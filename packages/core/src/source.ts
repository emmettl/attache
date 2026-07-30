// Where a thing is, in the text somebody typed.
//
// Every diagnostic this package produces has to be able to point at a line. That
// requirement reaches further back than it looks: it rules out `JSON.parse`, and it rules
// out any YAML parser that hands back plain objects, because by the time you have a plain
// object the association between `port_value` and line 14 is gone. So the parse keeps the
// document AST and everything downstream carries a `Range` taken from it.

/** A span of the original text. */
export interface Range {
  /** Byte offsets into the source, as the YAML parser reports them. */
  start: number
  end: number
  /** 1-based line and column of `start`. What a gutter and an error message want. */
  line: number
  column: number
}

/**
 * A location in the config tree: `['static_resources', 'listeners', 0, 'name']`.
 *
 * Numbers are array indices and strings are field names, kept apart so that formatting can
 * render `listeners[0]` rather than `listeners.0` — and so that a consumer that wants to
 * navigate the tree programmatically does not have to parse the display form back out.
 */
export type ConfigPath = readonly (string | number)[]

/** `static_resources.listeners[0].filter_chains[1].filters[0].name` */
export function formatPath(path: ConfigPath): string {
  let out = ''
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`
    else out += out === '' ? part : `.${part}`
  }
  return out
}

/**
 * Envoy accepts a field as `port_value` or as `portValue` and means the same thing by
 * both: hand-written bootstrap YAML conventionally uses snake_case, while proto JSON —
 * which is what the admin port's `/config_dump` emits — is lowerCamelCase. A tool that
 * understands only one of them would reject half the configs it is shown.
 *
 * Everything downstream works in camelCase, and this is the funnel. Note it is only ever
 * used to LOOK UP a field: the key as it was actually written is what gets reported back
 * in diagnostics, because telling somebody their `portValue` is wrong when they wrote
 * `port_value` is a small but corrosive way to seem unreliable.
 */
export function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

/** Whether two spellings of a field name refer to the same field. */
export function sameField(a: string, b: string): boolean {
  return a === b || toCamel(a) === toCamel(b)
}
