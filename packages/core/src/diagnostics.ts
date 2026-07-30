import type { ConfigPath, Range } from './source.js'

// What the tool has to say about a config, and — just as importantly — what it has
// declined to say.

export type Severity = 'error' | 'warning' | 'info'

/**
 * A stable identifier for each kind of finding.
 *
 * A string union rather than a TS enum: `erasableSyntaxOnly` is on, and an enum is not
 * erasable. It is also the more useful shape here, since these codes end up in the UI as
 * filter values and in tests as assertions.
 */
export type DiagnosticCode =
  // parse
  | 'yaml-error'
  | 'not-a-map'
  // structure
  | 'wrong-type'
  | 'bad-enum'
  | 'missing-required'
  | 'empty-list'
  // references
  | 'cluster-not-found'
  | 'cluster-unused'
  | 'route-config-not-found'
  | 'duplicate-listener-name'
  | 'duplicate-cluster-name'
  | 'duplicate-listener-address'
  | 'no-route-config'
  | 'no-filter-chains'
  // shadowing and ordering
  | 'route-unreachable'
  | 'duplicate-domain'
  | 'router-not-last'
  | 'no-router-filter'
  // transport
  | 'sni-without-tls'
  | 'tls-without-certificate'
  // dynamic config
  | 'dynamic-resource-not-resolvable'

export interface Diagnostic {
  severity: Severity
  code: DiagnosticCode
  /** One sentence, addressed to the person who wrote the config. */
  message: string
  /**
   * Why it matters, when that is not obvious from the message. Envoy's failure modes are
   * frequently silent — a route that never matches costs nothing at boot and everything at
   * three in the morning — so the reason a finding is worth acting on is often the more
   * useful half of it.
   */
  detail?: string
  path: ConfigPath
  range: Range
}

/**
 * A field this package does not model.
 *
 * The reason this type exists at all, rather than such fields being quietly skipped: a
 * curated subset of Envoy's schema can only be honest if it says where its edges are.
 * "I found no problems" and "I did not look" are different claims, and a tool that
 * conflates them is worse than no tool, because it converts an unchecked config into a
 * false sense of one.
 *
 * Reported at the SHALLOWEST unmodelled point. If `typed_config` is unknown, that is one
 * finding, not one per leaf beneath it.
 */
export interface Unknown {
  /** The field name as it was actually written in the source. */
  key: string
  path: ConfigPath
  range: Range
}

export const isError = (d: Diagnostic): boolean => d.severity === 'error'

/**
 * The one-line summary.
 *
 * Deliberately has no success state — there is no "valid", no green tick, and no code path
 * that produces one. The most this package will ever say is that it found nothing wrong in
 * the part it understands, and the count of what it did not understand is right there next
 * to it so that claim cannot be read as more than it is.
 */
export function summarise(diagnostics: readonly Diagnostic[], unknowns: readonly Unknown[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length

  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  if (parts.length === 0) parts.push('nothing wrong in what I checked')

  const notChecked =
    unknowns.length === 0
      ? 'nothing unrecognised'
      : `${unknowns.length} ${unknowns.length === 1 ? 'field' : 'fields'} not checked`

  return `${parts.join(', ')} · ${notChecked}`
}
