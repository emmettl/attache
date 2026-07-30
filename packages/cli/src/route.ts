import {
  VERSION,
  type Attempt,
  type MatchResult,
  type Outcome,
  type PathSpecifier,
  type TestRequest,
} from '@attache/core'

// Where does this request actually go — asked from a script, and answered so a build can
// fail on the answer.
//
// This is the half `envoy --mode validate` structurally cannot do. A validator tells you
// Envoy will accept the file; it cannot tell you the file still sends `/v1/users` to
// `api_service`, because answering that means walking the cascade rather than checking the
// schema. And that is the assertion worth having in CI: a config can stay valid through the
// edit that quietly moved a route below a broader one.
//
// The losers are reported for the same reason the app reports them. "It went to the wrong
// cluster" is almost never a question about the winner.

export interface Expectation {
  cluster?: string
  outcome?: Outcome
}

export interface RouteCheck {
  file: string
  request: TestRequest
  result: MatchResult
  expect: Expectation
}

/** What an expectation asked for, and what it got. Empty when nothing was asserted. */
export interface Failure {
  what: 'cluster' | 'outcome'
  expected: string
  actual: string
}

export function failures(check: RouteCheck): Failure[] {
  const out: Failure[] = []

  if (check.expect.outcome !== undefined && check.result.outcome !== check.expect.outcome) {
    out.push({ what: 'outcome', expected: check.expect.outcome, actual: check.result.outcome })
  }

  if (check.expect.cluster !== undefined && check.result.cluster !== check.expect.cluster) {
    out.push({
      what: 'cluster',
      expected: check.expect.cluster,
      // `no cluster` rather than `undefined`: a request that 404s, redirects or answers
      // directly reaches no upstream at all, and that is a different thing from reaching one
      // this tester could not name.
      actual: check.result.cluster ?? 'no cluster',
    })
  }

  return out
}

/**
 * Zero unless an expectation was broken.
 *
 * A run with NO expectation is a question rather than a test, and a question is not a
 * failure however it is answered — `attache route` on a config whose request 404s has told
 * you exactly what you asked. Exiting non-zero there would make the informational mode
 * unusable in a shell that sets `-e`.
 */
export function routeExitCode(check: RouteCheck): number {
  return failures(check).length > 0 ? 1 : 0
}

// ---- shared shapes ------------------------------------------------------------------

export function describeSpec(spec: PathSpecifier): string {
  switch (spec.kind) {
    case 'prefix':
      return `prefix ${spec.value}`
    case 'path':
      return `path ${spec.value}`
    case 'pathSeparatedPrefix':
      return `segment ${spec.value}`
    case 'safeRegex':
      return `regex ${spec.value}`
    case 'unmodelled':
      return spec.label
    case 'none':
      return 'no path match'
  }
}

/** The request line, as it would be written down. */
export function describeRequest(request: TestRequest): string {
  const port = request.port === undefined ? '' : ` (port ${request.port})`
  const sni = request.serverName === undefined ? '' : ` SNI ${request.serverName}`
  return `${request.method} ${request.authority}${request.path}${port}${sni}`
}

interface Row {
  label: string
  detail?: string
  matched: boolean
  reason?: string
}

/** Each stage's candidates, in the order Envoy considered them. */
function stages(result: MatchResult): { title: string; rows: Row[] }[] {
  const rows = <T>(
    attempts: readonly Attempt<T>[],
    label: (candidate: T, index: number) => string,
    detail: (candidate: T) => string | undefined,
  ): Row[] =>
    attempts.map((attempt) => ({
      label: label(attempt.candidate, attempt.index),
      detail: detail(attempt.candidate),
      matched: attempt.matched,
      reason: attempt.reason,
    }))

  const out = [
    {
      title: 'listener',
      rows: rows(
        result.listenerAttempts,
        (listener, index) => listener.name ?? `listener ${index + 1}`,
        (listener) =>
          listener.address === undefined
            ? undefined
            : `${listener.address.address ?? '*'}:${listener.address.portValue ?? '?'}`,
      ),
    },
    {
      title: 'filter chain',
      rows: rows(
        result.chainAttempts,
        (chain, index) => chain.name ?? `chain ${index + 1}`,
        (chain) => chain.match?.serverNames.join(', ') || undefined,
      ),
    },
    {
      title: 'virtual host',
      rows: rows(
        result.hostAttempts,
        (host, index) => host.name ?? `virtual host ${index + 1}`,
        (host) => host.domains.join(', ') || undefined,
      ),
    },
    {
      title: 'route',
      rows: rows(
        result.routeAttempts,
        (route, index) => route.name ?? `route ${index + 1}`,
        (route) => describeSpec(route.match.pathSpec),
      ),
    },
  ]

  return out.filter((stage) => stage.rows.length > 0)
}

// ---- human --------------------------------------------------------------------------

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  cyan: '[36m',
}

const painter = (colour: boolean) => (text: string, ...codes: string[]) =>
  colour && codes.length > 0 ? `${codes.join('')}${text}${ANSI.reset}` : text

export interface RouteOptions {
  colour: boolean
  /** Drop the losing candidates and print only the verdict. */
  quiet: boolean
}

function human(check: RouteCheck, options: RouteOptions): string {
  const paint = painter(options.colour)
  const broken = failures(check)
  const out: string[] = [
    paint(describeRequest(check.request), ANSI.bold),
    check.result.explanation,
  ]

  // Before the cascade, because they are the reason the cascade below reads the way it does:
  // a path that was merged or normalised is matched against routes in its rewritten form.
  for (const rewrite of check.result.rewrites) out.push(paint(`  ${rewrite}`, ANSI.dim))

  if (!options.quiet) {
    for (const stage of stages(check.result)) {
      out.push('', paint(stage.title, ANSI.dim))
      for (const row of stage.rows) {
        const mark = row.matched ? paint('✓', ANSI.green) : paint('·', ANSI.dim)
        const label = row.matched ? paint(row.label, ANSI.bold) : row.label
        const detail = row.detail === undefined ? '' : ` ${paint(row.detail, ANSI.cyan)}`
        const reason = row.reason === undefined ? '' : paint(` — ${row.reason}`, ANSI.dim)
        out.push(`  ${mark} ${label}${detail}${reason}`)
      }
    }
  }

  // Where this answer may differ from Envoy's. Printed after the cascade and before the
  // verdict, so that an expectation which passed with a caveat attached cannot be read as
  // one that passed cleanly — which for a `runtime_fraction` route is the difference between
  // "this is where it goes" and "this is where it goes about half the time".
  if (check.result.caveats.length > 0) {
    out.push('', paint('this answer is not certain', ANSI.yellow))
    for (const caveat of check.result.caveats) out.push(paint(`  ${caveat}`, ANSI.dim))
  }

  if (broken.length > 0) {
    out.push('')
    for (const failure of broken) {
      out.push(
        `${paint('✗', ANSI.red)} expected ${failure.what} ${paint(failure.expected, ANSI.bold)}, got ${paint(failure.actual, ANSI.bold)}`,
      )
    }
  } else if (check.expect.cluster !== undefined || check.expect.outcome !== undefined) {
    const held = [
      check.expect.outcome === undefined ? undefined : `outcome ${check.expect.outcome}`,
      check.expect.cluster === undefined ? undefined : `cluster ${check.expect.cluster}`,
    ].filter((part): part is string => part !== undefined)
    // "as expected", not "passed" — the tester is reporting that its own answer matched the
    // one you predicted, which is a smaller claim than the config being right.
    out.push('', `${paint('✓', ANSI.green)} ${held.join(', ')}, as expected`)
  }

  return out.join('\n')
}

// ---- GitHub Actions -------------------------------------------------------------------

const escapeData = (value: string) =>
  value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const escapeProperty = (value: string) =>
  escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')

/**
 * One annotation when an expectation breaks, and a log line either way.
 *
 * A route assertion has no line in the file to hang an annotation on — the failure is about
 * the config as a whole, and pointing at the winning route would blame the line that is
 * behaving correctly. So the file is named without a line, and the body carries the losing
 * candidates, which is what somebody opening the job actually needs.
 */
function github(check: RouteCheck): string {
  const broken = failures(check)
  const out: string[] = []

  if (broken.length > 0) {
    const detail = stages(check.result)
      .map(
        (stage) =>
          `${stage.title}:\n${stage.rows
            .map(
              (row) =>
                `  ${row.matched ? '✓' : '·'} ${row.label}${row.reason === undefined ? '' : ` — ${row.reason}`}`,
            )
            .join('\n')}`,
      )
      .join('\n\n')

    const body = [
      describeRequest(check.request),
      broken
        .map((failure) => `Expected ${failure.what} ${failure.expected}, got ${failure.actual}.`)
        .join(' '),
      check.result.explanation,
      detail,
      ...check.result.caveats,
    ].join('\n\n')

    out.push(
      `::error file=${escapeProperty(check.file)},title=${escapeProperty('Attaché: route assertion')}::${escapeData(body)}`,
    )
  }

  // An assertion that HELD on uncertain ground, said out loud.
  //
  // On the terminal the caveats are impossible to miss — they sit directly above the tick.
  // In a job they would be one line in a log nobody opens, and the annotation on the diff
  // would show a green check for `--expect-cluster v2` against a route that splits traffic
  // by weight. A passing test that quietly means "about half the time" is exactly the kind
  // of confident wrong answer this package spends its comments refusing to give.
  const asserted = check.expect.cluster !== undefined || check.expect.outcome !== undefined
  if (broken.length === 0 && asserted && check.result.caveats.length > 0) {
    const body = [
      `${describeRequest(check.request)} met its expectation, but this tester cannot be certain of the answer.`,
      ...check.result.caveats,
    ].join('\n\n')
    out.push(
      `::warning file=${escapeProperty(check.file)},title=${escapeProperty('Attaché: route assertion is not certain')}::${escapeData(body)}`,
    )
  }

  out.push(`${check.file} — ${describeRequest(check.request)} — ${check.result.explanation}`)
  return out.join('\n')
}

// ---- JSON ----------------------------------------------------------------------------

function json(check: RouteCheck): string {
  return JSON.stringify(
    {
      schema: 'attache-route-1',
      version: VERSION,
      file: check.file,
      request: check.request,
      outcome: check.result.outcome,
      explanation: check.result.explanation,
      cluster: check.result.cluster,
      rewrites: check.result.rewrites,
      caveats: check.result.caveats,
      expected: check.expect,
      failures: failures(check),
      stages: stages(check.result).map((stage) => ({
        stage: stage.title,
        candidates: stage.rows,
      })),
    },
    null,
    2,
  )
}

export function renderRoute(
  check: RouteCheck,
  format: 'human' | 'github' | 'json',
  options: RouteOptions,
): string {
  switch (format) {
    case 'human':
      return human(check, options)
    case 'github':
      return github(check)
    case 'json':
      return json(check)
  }
}
