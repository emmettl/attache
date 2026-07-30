import { isAlias, isMap, isScalar, isSeq, type Document, type Node } from 'yaml'
import type { Diagnostic, Unknown } from './diagnostics.js'
import { formatPath, toCamel, type ConfigPath, type Range } from './source.js'
import type { Positions } from './parse.js'

// A reader over the document AST that remembers what it was asked for.
//
// This is the mechanism behind the one promise this package makes about its own limits.
// The model builder asks for the fields it knows how to interpret; whatever is left over
// at the end is, by construction, a field the builder does not model. Nothing has to be
// kept in sync and nobody has to remember to add a field to a list of known fields — the
// leftovers ARE the list, derived from the code that did the reading.
//
// The alternative, a hand-maintained set of known field names checked against the input,
// is the same idea with a way to get it wrong: the day somebody adds `retry_policy` to the
// model and forgets to add it to the known-fields set, the tool starts reporting a field
// it understands perfectly well as unrecognised. Here that cannot happen.

interface Context {
  positions: Positions
  diagnostics: Diagnostic[]
  /** Needed to resolve aliases back to the node they were anchored on. */
  doc: Document
}

/**
 * Follow `*alias` to the `&anchor` it names.
 *
 * Real configs are full of these — a filter chain or a TLS context written once and
 * referenced from every listener that shares it — and an Alias is neither a map nor a
 * sequence, so without this a `filter_chains: *shared` reads as absent and the tool
 * confidently reports a listener with no filter chains. That is not a cosmetic miss: it
 * turns the checks into false accusations on exactly the configs most worth checking.
 *
 * Bounded rather than recursive-until-done, because a self-referential anchor is a document
 * a person can write and this should not be where it becomes a hang.
 */
function deref(doc: Document, node: Node | null): Node | null {
  let current = node
  for (let hops = 0; hops < 32 && isAlias(current); hops++) {
    current = (current.resolve(doc) ?? null) as Node | null
  }
  return isAlias(current) ? null : current
}

/** One `key: value` in the source, with the key spelled the way it was written. */
interface Entry {
  /** As written — `port_value`, not `portValue`. */
  raw: string
  /** Normalised for lookup. */
  camel: string
  keyRange: Range
  value: Node | null
}

export class Cursor {
  readonly path: ConfigPath
  readonly range: Range
  readonly node: Node | null

  private readonly ctx: Context
  /** The key this cursor arrived through, for reporting it as a whole. */
  private readonly key: string
  private readonly seen = new Set<string>()
  private readonly children = new Map<string, Cursor>()
  private entriesCache: Entry[] | null = null
  private itemsCache: Cursor[] | null = null
  /** Whether anything at all was asked of this node. */
  private touched = false
  /** Whether the builder gave up on this node deliberately. */
  private wholesale = false
  /** Whether this node is the wrong SHAPE, and already has a diagnostic saying so. */
  private misshapen = false

  constructor(ctx: Context, node: Node | null, path: ConfigPath, key: string) {
    this.ctx = ctx
    this.path = path
    this.key = key
    // The RANGE comes from the node as written and the CONTENT from what it resolves to.
    // Pointing a diagnostic at the anchor's definition when the user wrote an alias would
    // send them to a line they did not touch, possibly in a different listener.
    this.range = ctx.positions.range(node?.range)
    this.node = deref(ctx.doc, node)
  }

  // ---- shape -------------------------------------------------------------------

  get isMap(): boolean {
    return isMap(this.node)
  }

  get isSeq(): boolean {
    return isSeq(this.node)
  }

  /**
   * A map's fields, with `<<` merges folded in.
   *
   * Recursive, because a merge target can carry a merge of its own — a base map extended by
   * a second that extends a third is an ordinary way to write shared defaults, and treating
   * a target's items as final would leave its own `<<` sitting there as a field called
   * "<<". The depth bound is a backstop against anchors that reference each other.
   *
   * Precedence follows YAML: keys written here beat merged ones, and among merge targets
   * the earlier beats the later. Both fall out of only ever appending what is not already
   * present, given the explicit keys go in first.
   */
  private entriesOf(node: Node | null, depth = 0): Entry[] {
    const out: Entry[] = []
    if (!isMap(node) || depth > 16) return out

    const merged: Node[] = []

    for (const pair of node.items) {
      if (!isScalar(pair.key)) continue
      const raw = String(pair.key.value)

      // Its value is an alias, or a sequence of them. Dropping this — which is what used to
      // happen — does not merely mislabel a config, it loses fields: a cluster whose `type`
      // and `connect_timeout` arrive through `<<: *defaults` had neither.
      if (raw === '<<') {
        const value = deref(this.ctx.doc, (pair.value ?? null) as Node | null)
        if (isSeq(value)) {
          for (const item of value.items) {
            const target = deref(this.ctx.doc, (item ?? null) as Node | null)
            if (target) merged.push(target)
          }
        } else if (value) {
          merged.push(value)
        }
        continue
      }

      out.push({
        raw,
        camel: toCamel(raw),
        keyRange: this.ctx.positions.range(pair.key.range),
        value: (pair.value ?? null) as Node | null,
      })
    }

    for (const target of merged) {
      for (const entry of this.entriesOf(target, depth + 1)) {
        if (out.some((e) => e.camel === entry.camel)) continue
        out.push(entry)
      }
    }

    return out
  }

  private entries(): Entry[] {
    this.entriesCache ??= this.entriesOf(this.node)
    return this.entriesCache
  }

  // ---- reading -----------------------------------------------------------------

  /**
   * Fetch a field, marking it as understood whether or not it is present.
   *
   * Absent fields are marked too, and deliberately: "this model knows about `route_config`"
   * is a fact about the model, not about this particular document, and it should not
   * depend on whether the field happened to be written.
   */
  field(name: string): Cursor | undefined {
    this.touched = true
    const camel = toCamel(name)
    this.seen.add(camel)

    const cached = this.children.get(camel)
    if (cached) return cached

    const entry = this.entries().find((e) => e.camel === camel)
    if (!entry) return undefined

    const child = new Cursor(this.ctx, entry.value, [...this.path, entry.raw], entry.raw)
    this.children.set(camel, child)
    return child
  }

  /** As `field`, but records a diagnostic when it is missing. */
  require(name: string, why?: string): Cursor | undefined {
    const found = this.field(name)
    if (!found) {
      this.ctx.diagnostics.push({
        severity: 'error',
        code: 'missing-required',
        message: `\`${name}\` is required${this.path.length > 0 ? ` on ${formatPath(this.path)}` : ''}.`,
        detail: why,
        path: this.path,
        range: this.range,
      })
    }
    return found
  }

  /**
   * Sequence items.
   *
   * A MAP here is called out rather than treated as empty. Envoy's repeated fields are
   * written as YAML lists, and the commonest way to get one wrong is to leave off the `- `
   * on the first entry — at which point `filter_chains:` becomes a mapping of the first
   * chain's fields, Envoy rejects the config, and every tool downstream reports the far
   * less useful "no filter chains".
   *
   * This was found on a real config, where the honest-but-unhelpful message sent somebody
   * looking for a missing block that was in fact sitting right there with a hyphen missing.
   */
  items(): Cursor[] {
    this.touched = true
    if (this.itemsCache) return this.itemsCache

    if (isMap(this.node)) {
      const fields = this.entries()
        .slice(0, 3)
        .map((e) => `\`${e.raw}\``)
        .join(', ')
      this.ctx.diagnostics.push({
        // A WARNING, not an error, and that distinction was earned the hard way. This
        // shipped saying "Envoy will refuse the config", and the person who found it
        // replied that the config in question is serving production traffic. Whether
        // Envoy's proto JSON parser is lenient here, or that deployment renders its config
        // from something else, is not knowable from inside a browser tab — and a tool that
        // states a confident consequence it cannot check is the exact failure this package
        // is built to avoid. So it reports what it can see and stops there.
        severity: 'warning',
        code: 'expected-list',
        message: `\`${formatPath(this.path)}\` is a list in Envoy's schema, and this is a single block.`,
        detail: `Attaché reads it as zero entries, so anything depending on it will look empty. The usual cause is a missing \`- \` in front of the first field${fields ? ` — the block starting ${fields}` : ''}. If this config is running, Envoy is being more forgiving here than its schema suggests, and it is the reading below that is wrong rather than your config.`,
        path: this.path,
        range: this.range,
      })
      // The fields inside are not unrecognised, they are misplaced, and the finding above
      // already says so. Listing them again as unmodelled would bury it.
      this.misshapen = true
      this.itemsCache = []
      return this.itemsCache
    }

    const out: Cursor[] = []
    if (isSeq(this.node)) {
      this.node.items.forEach((item, index) => {
        out.push(
          new Cursor(this.ctx, (item ?? null) as Node | null, [...this.path, index], String(index)),
        )
      })
    }
    this.itemsCache = out
    return out
  }

  /**
   * Mark this node as understood-but-not-modelled.
   *
   * For the case where the builder must read enough to know it cannot go further — a
   * `typed_config` whose `@type` is an extension this package has no model for. Without
   * this the node would count as touched, and its every inner field would be reported
   * separately: forty findings about one filter nobody asked about. One finding naming the
   * filter is the useful form.
   */
  unmodelled(): void {
    this.touched = true
    this.wholesale = true
  }

  // ---- scalars -----------------------------------------------------------------

  private scalar(): unknown {
    this.touched = true
    return isScalar(this.node) ? this.node.value : undefined
  }

  private wrongType(expected: string): undefined {
    this.ctx.diagnostics.push({
      severity: 'error',
      code: 'wrong-type',
      message: `\`${formatPath(this.path)}\` should be ${expected}.`,
      path: this.path,
      range: this.range,
    })
    return undefined
  }

  /**
   * A string.
   *
   * Numbers and booleans are coerced rather than rejected, because YAML decides those for
   * you: an unquoted `name: 8080` is a number by the time it gets here, and a cluster
   * called 8080 is legal and reasonably common. Rejecting it would be a complaint about
   * YAML's type inference dressed up as a complaint about the config.
   */
  str(): string | undefined {
    const value = this.scalar()
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    if (value === undefined || value === null) return undefined
    return this.wrongType('a string')
  }

  /**
   * A number.
   *
   * Numeric strings are accepted because proto JSON requires them: 64-bit integer fields
   * are encoded as strings to survive JSON's float precision, so a `/config_dump` will
   * hand back `"10000"` where a hand-written bootstrap has `10000`. Both are the same port.
   */
  num(): number | undefined {
    const value = this.scalar()
    if (typeof value === 'number') return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value)
    }
    if (value === undefined || value === null) return undefined
    return this.wrongType('a number')
  }

  bool(): boolean | undefined {
    const value = this.scalar()
    if (typeof value === 'boolean') return value
    if (value === 'true') return true
    if (value === 'false') return false
    if (value === undefined || value === null) return undefined
    return this.wrongType('true or false')
  }

  /** One of a fixed set. Envoy spells these in SCREAMING_SNAKE; matching is exact. */
  enumOf<T extends string>(allowed: readonly T[]): T | undefined {
    const value = this.str()
    if (value === undefined) return undefined
    if ((allowed as readonly string[]).includes(value)) return value as T
    this.ctx.diagnostics.push({
      severity: 'error',
      code: 'bad-enum',
      message: `\`${formatPath(this.path)}\` should be one of ${allowed.join(', ')} — got \`${value}\`.`,
      path: this.path,
      range: this.range,
    })
    return undefined
  }

  /** Convenience: read a field's string in one step. */
  strAt(name: string): string | undefined {
    return this.field(name)?.str()
  }

  numAt(name: string): number | undefined {
    return this.field(name)?.num()
  }

  /**
   * Whether this node carries fields nobody asked for.
   *
   * Used where the CONSEQUENCE of not modelling something matters beyond reporting it: a
   * `filter_chain_match` with criteria this package does not evaluate produces a chain
   * selection that may not be the one Envoy would make, and the route tester has to say so
   * rather than present its answer as authoritative.
   */
  hasUnread(): boolean {
    return this.entries().some((entry) => !this.seen.has(entry.camel))
  }

  // ---- leftovers ---------------------------------------------------------------

  /**
   * Everything below this node that the builder never interpreted.
   *
   * Reported at the shallowest point: an untouched node is one finding, and a node that
   * was partly read yields one finding per field that was not. Recursion follows only the
   * children that were actually created, since anything beneath an unread node is already
   * covered by the finding for the node itself.
   */
  collectUnknowns(into: Unknown[] = []): Unknown[] {
    if (this.node === null || this.misshapen) return into

    if (this.wholesale || !this.touched) {
      // Scalars are values, not structure. Reporting `stat_prefix: ingress_http` as an
      // unrecognised field when what is unrecognised is the enclosing filter would bury
      // the useful finding under its own details.
      if (!isScalar(this.node)) {
        into.push({ key: this.key, path: this.path, range: this.range })
      }
      return into
    }

    if (isMap(this.node)) {
      for (const entry of this.entries()) {
        if (this.seen.has(entry.camel)) continue
        into.push({ key: entry.raw, path: [...this.path, entry.raw], range: entry.keyRange })
      }
      for (const child of this.children.values()) child.collectUnknowns(into)
    } else if (isSeq(this.node)) {
      for (const item of this.itemsCache ?? []) item.collectUnknowns(into)
    }

    return into
  }
}

/** Start a read over a parsed document. */
export function cursorOver(
  node: Node | null,
  positions: Positions,
  diagnostics: Diagnostic[],
  doc: Document,
): Cursor {
  return new Cursor({ positions, diagnostics, doc }, node, [], '')
}
