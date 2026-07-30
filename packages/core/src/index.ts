import { summarise, type Diagnostic, type DiagnosticCode, type Unknown } from './diagnostics.js'
import { buildModel } from './model.js'
import { parse, type ConfigFormat } from './parse.js'
import type { ConfigModel } from './types.js'
import { validate } from './validate.js'

// The public face of the core. Nothing in here — or anywhere below it — imports React,
// touches the DOM, or knows a UI exists. `tsconfig.build.json` leaves DOM out of `lib` so
// that stays true by construction rather than by good intentions.
//
// The surface is data-in, data-out: text goes in, a model and a list of findings come out,
// and everything downstream is a pure function of that model. The app is one consumer; a
// CLI or a CI check would be another, and neither should need a browser.

export * from './types.js'
export * from './diagnostics.js'
export * from './source.js'
export { parse, type ConfigFormat, type ParseResult } from './parse.js'
export { buildModel, type ModelResult } from './model.js'
export { validate } from './validate.js'
export {
  ALL_DOCS,
  docsForCode,
  docsForKind,
  type DocLink,
} from './docs.js'
export {
  buildGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeKind,
} from './graph.js'
export {
  describeSecrets,
  findSecrets,
  redact,
  type Redaction,
  type Secret,
} from './redact.js'
export {
  matchRequest,
  pathOnly,
  type Attempt,
  type DomainPrecedence,
  type MatchResult,
  type Outcome,
  type TestRequest,
} from './match.js'

export const VERSION = '0.2.0'

export interface Analysis {
  /** Whether this was a bootstrap or a `/config_dump`. */
  format: ConfigFormat
  model: ConfigModel
  /** Syntax errors, structural problems and referential problems, in that order. */
  diagnostics: Diagnostic[]
  /** Fields this package did not check, each saying which of the two reasons applies. */
  unknowns: Unknown[]
  /** One line, and never a claim of validity. See `summarise`. */
  summary: string
}

/**
 * Text in, everything out.
 *
 * The whole pipeline in one call, because every caller wants all of it: there is no useful
 * way to have a model without knowing what was skipped to build it.
 *
 * A document with syntax errors still produces a model, from as much of the tree as the
 * parser recovered. That is deliberate — a config being edited is broken most of the time,
 * and a tool that goes blank at the first stray colon is a tool you close.
 */
/**
 * Findings that only exist because of another finding, removed.
 *
 * A `filter_chains` written as a mapping instead of a list produces two: the shape problem,
 * and then "this listener has no filter chains" — which is technically true, entirely
 * derivative, and actively misleading, because it sends somebody looking for a missing
 * block that is sitting right there with a hyphen missing. Reporting the cause and its
 * symptom side by side as peers is how a tool teaches people to skim past it.
 *
 * Keyed on containment: a consequence is dropped when a shape error sits somewhere beneath
 * the thing it is complaining about.
 */
const CONSEQUENCES = new Set<DiagnosticCode>(['no-filter-chains', 'tls-without-certificate'])

function suppressConsequences(all: Diagnostic[]): Diagnostic[] {
  const shapeErrors = all.filter((d) => d.code === 'expected-list')
  if (shapeErrors.length === 0) return all

  const under = (inner: readonly (string | number)[], outer: readonly (string | number)[]) =>
    inner.length > outer.length && outer.every((part, i) => inner[i] === part)

  return all.filter(
    (d) => !CONSEQUENCES.has(d.code) || !shapeErrors.some((shape) => under(shape.path, d.path)),
  )
}

export function analyse(text: string): Analysis {
  const parsed = parse(text)
  const { model, diagnostics: structural, unknowns } = buildModel(parsed)
  const referential = validate(model)

  const diagnostics = suppressConsequences([
    ...parsed.diagnostics,
    ...structural,
    ...referential,
  ])

  return {
    format: parsed.format,
    model,
    diagnostics,
    unknowns,
    summary: summarise(diagnostics, unknowns),
  }
}
