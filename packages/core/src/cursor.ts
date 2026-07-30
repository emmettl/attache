import { isMap, isScalar, isSeq, type Node } from 'yaml'
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

  constructor(ctx: Context, node: Node | null, path: ConfigPath, key: string) {
    this.ctx = ctx
    this.node = node
    this.path = path
    this.key = key
    this.range = ctx.positions.range(node?.range)
  }

  // ---- shape -------------------------------------------------------------------

  get isMap(): boolean {
    return isMap(this.node)
  }

  get isSeq(): boolean {
    return isSeq(this.node)
  }

  private entries(): Entry[] {
    if (this.entriesCache) return this.entriesCache
    const out: Entry[] = []
    if (isMap(this.node)) {
      for (const pair of this.node.items) {
        if (!isScalar(pair.key)) continue
        const raw = String(pair.key.value)
        out.push({
          raw,
          camel: toCamel(raw),
          keyRange: this.ctx.positions.range(pair.key.range),
          value: (pair.value ?? null) as Node | null,
        })
      }
    }
    this.entriesCache = out
    return out
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

  /** Sequence items. An empty list for anything that is not a sequence. */
  items(): Cursor[] {
    this.touched = true
    if (this.itemsCache) return this.itemsCache
    const out: Cursor[] = []
    if (isSeq(this.node)) {
      this.node.items.forEach((item, index) => {
        out.push(new Cursor(this.ctx, (item ?? null) as Node | null, [...this.path, index], String(index)))
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
    if (this.node === null) return into

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
): Cursor {
  return new Cursor({ positions, diagnostics }, node, [], '')
}
