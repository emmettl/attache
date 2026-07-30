import { LineCounter, isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml'
import type { Diagnostic } from './diagnostics.js'
import type { Range } from './source.js'

// Text in, document AST out — with the source ranges intact, which is the whole reason
// this goes through `yaml` rather than `JSON.parse`.
//
// One code path handles YAML and JSON, because JSON is a subset of YAML 1.2 and this
// parser implements YAML 1.2. That is not a trick: it means a bootstrap someone
// hand-wrote and a `/config_dump` someone curled off an admin port arrive here the same
// way, and neither needs sniffing to decide which reader to use.

/** What shape of document arrived. */
export type ConfigFormat =
  /** A bootstrap: what `envoy -c` takes, and what people write by hand. */
  | 'bootstrap'
  /** The admin port's `/config_dump`, which wraps the same messages in envelopes. */
  | 'config-dump'

export interface ParseResult {
  doc: Document
  /** The root node, or null for an empty or wholly unparseable document. */
  root: Node | null
  format: ConfigFormat
  /** Syntax errors. A document with these can still yield a partial tree, and does. */
  diagnostics: Diagnostic[]
  /** Offset → line and column, for anything that needs to build a `Range` later. */
  positions: Positions
}

export interface Positions {
  at(offset: number): { line: number; column: number }
  /** Build a `Range` from a `yaml` node's `[start, valueEnd, nodeEnd]` triple. */
  range(nodeRange: readonly [number, number, number] | undefined | null): Range
}

const EMPTY_RANGE: Range = { start: 0, end: 0, line: 1, column: 1 }

function positionsFrom(lineCounter: LineCounter): Positions {
  return {
    at(offset) {
      const { line, col } = lineCounter.linePos(offset)
      return { line, column: col }
    },
    range(nodeRange) {
      if (!nodeRange) return EMPTY_RANGE
      const [start, end] = nodeRange
      const { line, col } = lineCounter.linePos(start)
      return { start, end, line, column: col }
    },
  }
}

/**
 * A `/config_dump` is recognised by its envelope, not by guessing from its contents.
 *
 * The tell is a top-level `configs` array of `@type`-tagged envelopes in the
 * `envoy.admin.v3` package. Checking the package rather than merely the presence of
 * `configs` matters, because `configs` is not a reserved word — somebody's bootstrap could
 * carry one in a filter's typed_config and should not be mistaken for a dump.
 */
function detectFormat(root: Node | null): ConfigFormat {
  if (!isMap(root)) return 'bootstrap'
  const configs = root.items.find((pair) => isScalar(pair.key) && pair.key.value === 'configs')
  if (!configs || !isSeq(configs.value)) return 'bootstrap'

  for (const item of configs.value.items) {
    if (!isMap(item)) continue
    const type = item.items.find((pair) => isScalar(pair.key) && pair.key.value === '@type')
    if (isScalar(type?.value) && String(type.value.value).includes('envoy.admin.v3')) {
      return 'config-dump'
    }
  }
  return 'bootstrap'
}

export function parse(text: string): ParseResult {
  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter })
  const positions = positionsFrom(lineCounter)

  const diagnostics: Diagnostic[] = doc.errors.map((error) => {
    const [start, end] = error.pos
    const { line, col } = lineCounter.linePos(start)
    return {
      severity: 'error',
      code: 'yaml-error',
      // `yaml` appends its own source excerpt after a blank line; the first paragraph is
      // the sentence, and the excerpt is redundant next to a gutter that highlights the
      // same span.
      message: error.message.split('\n\n')[0]!,
      path: [],
      range: { start, end, line, column: col },
    }
  })

  const root = (doc.contents ?? null) as Node | null

  // A document that is neither a map nor empty — a bare string, a list at the top level —
  // is not a config, and saying so once is more use than the pile of missing-field errors
  // that would otherwise follow.
  if (root !== null && !isMap(root) && diagnostics.length === 0) {
    diagnostics.push({
      severity: 'error',
      code: 'not-a-map',
      message: 'The top level of an Envoy config is a set of fields, not a list or a single value.',
      path: [],
      range: positions.range(root.range),
    })
  }

  return { doc, root, format: detectFormat(root), diagnostics, positions }
}
