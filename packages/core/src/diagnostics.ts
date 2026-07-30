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
  | 'expected-list'
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
 * Which of two rather different claims a leftover field is making.
 *
 * These were one number for a long time, and on a real production config that number read
 * "49 fields not checked" when about half of them were fields Attaché reads perfectly well
 * and has merely declined to have an opinion about — a cluster's `health_checks`, an
 * `outlier_detection` block, the `typed_config` of a filter it had already named for you.
 *
 * Overstating its own ignorance is the mirror image of the failure the rest of this file
 * exists to prevent, and it is not a harmless error in the safe direction. It costs the
 * number its only use: a list where half the entries are already handled is not a backlog
 * of things to model, it is something you learn to scroll past — and once somebody is
 * scrolling past the unrecognised list, the honesty it was buying is gone.
 *
 * `unrecognised` means the model builder never asked for this field. It might be a typo,
 * it might be a corner of Envoy's schema nobody has modelled yet, and Attaché genuinely
 * cannot tell you which. `unvalidated` means it went and looked, knows what the field is,
 * and stopped there: the contents are real configuration and this package is not in a
 * position to judge them.
 */
export type UnknownKind = 'unrecognised' | 'unvalidated'

/**
 * A field this package did not check, and why not.
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
  /** Whether this is an edge of the model, or an edge of its remit. */
  kind: UnknownKind
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
 *
 * Two counts rather than one, for the reason set out on `UnknownKind`: a single figure had
 * to stand for both "there are fields here I have never heard of" and "there are fields
 * here I know and am not judging", and it inflated the first at the expense of anyone
 * believing either.
 */
export function summarise(diagnostics: readonly Diagnostic[], unknowns: readonly Unknown[]): string {
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length

  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`)
  if (parts.length === 0) parts.push('nothing wrong in what I checked')

  const unrecognised = unknowns.filter((u) => u.kind === 'unrecognised').length
  const unvalidated = unknowns.length - unrecognised

  const edges: string[] = []
  if (unrecognised > 0) {
    edges.push(`${unrecognised} ${unrecognised === 1 ? 'field' : 'fields'} unrecognised`)
  }
  // No noun on the second count when the first is already carrying one, so the common case
  // reads as one thought — "24 fields unrecognised · 25 read but not checked" — rather than
  // as two separate tallies that happen to be adjacent.
  if (unvalidated > 0) {
    edges.push(
      unrecognised > 0
        ? `${unvalidated} read but not checked`
        : `${unvalidated} ${unvalidated === 1 ? 'field' : 'fields'} read but not checked`,
    )
  }
  if (edges.length === 0) edges.push('nothing unrecognised')

  return `${parts.join(', ')} · ${edges.join(' · ')}`
}
