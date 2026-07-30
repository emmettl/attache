import {
  VERSION,
  docsForCode,
  formatPath,
  summarise,
  type Analysis,
  type Diagnostic,
  type Range,
  type Severity,
} from '@attache/core'

// Findings, rendered for whoever is reading them.
//
// Deliberately pure: text and an `Analysis` go in, a string comes out. Nothing here opens a
// file, reads an environment variable or calls `process.exit` — that is all in `cli.ts` —
// which is what makes every format below testable by asserting on a string rather than by
// running a subprocess and hoping.
//
// The formats exist because "CI-able" means two different things at once. A person reading
// a failed job wants the line, the reason and somewhere to go next; the job itself wants
// something it can turn into an annotation on the diff. Printing one and calling it the
// other is how linters end up with output that is neither.

export interface Checked {
  /** The path as the user wrote it, or `<stdin>`. Echoed back verbatim so it stays clickable. */
  file: string
  text: string
  analysis: Analysis
}

export type Format = 'human' | 'github' | 'json' | 'sarif'

/** The severity at which a finding stops the build, or `never`. */
export type FailOn = Severity | 'never'

export interface ReportOptions {
  format: Format
  colour: boolean
  failOn: FailOn
  /** Print only what fails the threshold. */
  quiet: boolean
  /** List the fields that were not checked, rather than only counting them. */
  showUnchecked: boolean
  /** Where to wrap prose. */
  width: number
}

const RANK: Record<Severity, number> = { error: 3, warning: 2, info: 1 }

/** Whether this finding is one the caller asked to fail on. */
export function fails(diagnostic: Diagnostic, failOn: FailOn): boolean {
  return failOn !== 'never' && RANK[diagnostic.severity] >= RANK[failOn]
}

export function exitCode(checked: readonly Checked[], failOn: FailOn): number {
  const any = checked.some((c) => c.analysis.diagnostics.some((d) => fails(d, failOn)))
  return any ? 1 : 0
}

/**
 * Line order, not pipeline order.
 *
 * The core emits parse errors, then structural ones, then everything relational, which is
 * the order they are discovered in and no use to somebody reading down a file. Sorted here
 * rather than there because the editor genuinely wants them grouped by kind.
 */
function ordered(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort(
    (a, b) => a.range.line - b.range.line || a.range.column - b.range.column,
  )
}

// ---- human ------------------------------------------------------------------------

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  dim: '[2m',
  red: '[31m',
  yellow: '[33m',
  blue: '[34m',
  cyan: '[36m',
}

const SEVERITY_COLOUR: Record<Severity, string> = {
  error: ANSI.red,
  warning: ANSI.yellow,
  info: ANSI.blue,
}

const painter = (colour: boolean) => (text: string, ...codes: string[]) =>
  colour && codes.length > 0 ? `${codes.join('')}${text}${ANSI.reset}` : text

/** Wrap prose at `width`, breaking on spaces and never mid-word. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '')
  if (words.length === 0) return []

  const lines: string[] = []
  let line = words[0]!
  for (const word of words.slice(1)) {
    if (line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line += ` ${word}`
    }
  }
  lines.push(line)
  return lines
}

/**
 * The offending line with a caret under the span, in the shape `rustc` and `cargo` made
 * everyone fluent in.
 *
 * Only the FIRST line of a range is shown. A mapping node's range covers everything nested
 * under it, so a finding about a listener spans the whole listener — and reprinting fifty
 * lines of somebody's config to point at the first of them is not context, it is the file.
 */
function excerpt(text: string, range: Range, paint: ReturnType<typeof painter>, colour: string): string[] {
  const lines = text.split('\n')
  const source = lines[range.line - 1]
  if (source === undefined) return []

  const gutter = String(range.line).length
  const pad = ' '.repeat(gutter)
  const bar = paint('│', ANSI.dim)

  const from = Math.max(0, range.column - 1)
  // A single-line range gets underlined for its real width. A BLOCK gets only its first
  // token, because a mapping node's range starts at its first key and runs to the end of
  // everything nested under it — so underlining "the first line of the span" put a hundred
  // and twenty carets under a `@type` URL to say "this filter". The key is the useful mark.
  const span =
    range.endLine > range.line
      ? (/^\S+/.exec(source.slice(from))?.[0].length ?? 1)
      : range.end - range.start
  const width = Math.max(1, Math.min(span, source.length - from))

  return [
    ` ${pad} ${bar}`,
    ` ${paint(String(range.line), ANSI.dim)} ${bar} ${source}`,
    ` ${pad} ${bar} ${' '.repeat(from)}${paint('^'.repeat(width), colour, ANSI.bold)}`,
  ]
}

function block(file: Checked, diagnostic: Diagnostic, options: ReportOptions): string[] {
  const paint = painter(options.colour)
  const colour = SEVERITY_COLOUR[diagnostic.severity]
  const gutter = String(diagnostic.range.line).length
  const lead = (i: number) => ` ${' '.repeat(gutter)} ${paint(i === 0 ? '=' : ' ', ANSI.dim)} `

  /** Prose, wrapped to the terminal. */
  const note = (body: string) =>
    wrap(body, Math.max(40, options.width - gutter - 5)).map((line, i) => `${lead(i)}${line}`)

  /**
   * One line, however long — for a config path and a documentation URL.
   *
   * Both are things people select and paste, and wrapping put a URL across two lines and a
   * config path on a line of its own beneath the word "at". A line that runs past the
   * terminal is a line the terminal will wrap; a line this wraps is one nobody can copy.
   */
  const unbroken = (body: string) => [`${lead(0)}${body}`]

  const out: string[] = [
    `${paint(diagnostic.severity, colour, ANSI.bold)}${paint(`[${diagnostic.code}]`, ANSI.dim)}: ${diagnostic.message}`,
    ` ${' '.repeat(gutter)}${paint('-->', ANSI.dim)} ${paint(
      `${file.file}:${diagnostic.range.line}:${diagnostic.range.column}`,
      ANSI.cyan,
    )}`,
    ...excerpt(file.text, diagnostic.range, paint, colour),
  ]

  // The reason it matters, then where in the config tree, then somewhere to read more.
  // Envoy's failure modes are frequently silent, so the `detail` is often the more useful
  // half of a finding — and the reference page for it is three levels into a generated
  // proto document that you have to already know the name of to find.
  if (diagnostic.detail) out.push(...note(diagnostic.detail))
  const path = formatPath(diagnostic.path)
  if (path !== '') out.push(...unbroken(`at ${paint(path, ANSI.dim)}`))
  const docs = docsForCode(diagnostic.code)
  if (docs) out.push(...unbroken(`${docs.title} — ${paint(docs.url, ANSI.cyan)}`))

  out.push('')
  return out
}

function human(checked: readonly Checked[], options: ReportOptions): string {
  const paint = painter(options.colour)
  const out: string[] = []

  for (const file of checked) {
    const shown = ordered(file.analysis.diagnostics).filter(
      (d) => !options.quiet || fails(d, options.failOn),
    )
    for (const diagnostic of shown) out.push(...block(file, diagnostic, options))

    if (options.showUnchecked && file.analysis.unknowns.length > 0) {
      out.push(paint(`${file.file} — fields Attaché did not check:`, ANSI.dim))
      for (const unknown of file.analysis.unknowns) {
        const kind = unknown.kind === 'unrecognised' ? 'unrecognised' : 'read, not checked'
        out.push(
          paint(
            `  ${file.file}:${unknown.range.line}  ${formatPath(unknown.path)}  (${kind})`,
            ANSI.dim,
          ),
        )
      }
      out.push('')
    }

    if (options.quiet && shown.length === 0) continue

    // `summarise` and nothing else. It is the one sentence in this project that is allowed
    // to describe a whole config, and it has no success state by construction — the most it
    // will ever say is that nothing was wrong IN WHAT IT CHECKED, with the size of what it
    // did not check sitting next to it. A CLI that printed a green tick here would be
    // undoing the argument the rest of the tool is built on.
    out.push(
      `${paint(file.file, ANSI.bold)} ${paint(`(${file.analysis.format})`, ANSI.dim)} — ${summarise(
        file.analysis.diagnostics,
        file.analysis.unknowns,
      )}`,
    )
  }

  if (checked.length > 1) {
    const all = checked.flatMap((c) => c.analysis.diagnostics)
    const unknowns = checked.flatMap((c) => c.analysis.unknowns)
    out.push('', `${paint(`${checked.length} files`, ANSI.bold)} — ${summarise(all, unknowns)}`)
  }

  return out.join('\n')
}

// ---- GitHub Actions ---------------------------------------------------------------

/**
 * Workflow commands, which GitHub turns into annotations on the diff.
 *
 * The escaping is not optional and not obvious: a literal `%`, carriage return or newline
 * has to be percent-encoded in a message or the command is truncated at that character, and
 * a property value needs `:` and `,` doing as well because those are its own separators. A
 * finding whose detail contains a URL — most of them — would otherwise arrive cut in half.
 */
const escapeData = (value: string) =>
  value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

const escapeProperty = (value: string) =>
  escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C')

const GITHUB_LEVEL: Record<Severity, string> = {
  error: 'error',
  warning: 'warning',
  // GitHub has no "info" annotation; `notice` is the level below warning and renders the
  // same way on the diff.
  info: 'notice',
}

function github(checked: readonly Checked[], options: ReportOptions): string {
  const out: string[] = []

  for (const file of checked) {
    for (const diagnostic of ordered(file.analysis.diagnostics)) {
      if (options.quiet && !fails(diagnostic, options.failOn)) continue

      const docs = docsForCode(diagnostic.code)
      const body = [diagnostic.message, diagnostic.detail, docs && `${docs.title}: ${docs.url}`]
        .filter((part): part is string => part !== undefined && part !== '')
        .join('\n\n')

      const properties = [
        `file=${escapeProperty(file.file)}`,
        `line=${diagnostic.range.line}`,
        `col=${diagnostic.range.column}`,
        `endLine=${diagnostic.range.endLine}`,
        `title=${escapeProperty(`Attaché: ${diagnostic.code}`)}`,
      ].join(',')

      out.push(`::${GITHUB_LEVEL[diagnostic.severity]} ${properties}::${escapeData(body)}`)
    }

    // Plain, because the annotations above are attached to the diff and leave the job log
    // itself saying nothing about what was checked.
    out.push(
      `${file.file} (${file.analysis.format}) — ${summarise(file.analysis.diagnostics, file.analysis.unknowns)}`,
    )
  }

  return out.join('\n')
}

// ---- JSON -------------------------------------------------------------------------

/**
 * The shape another program consumes.
 *
 * Versioned, because something will parse this and a silent reshape is how that breaks. The
 * unchecked counts are in here for the same reason they are on screen: a consumer deciding
 * whether to gate a deploy on this should be able to see how much of the config the answer
 * covers.
 */
function json(checked: readonly Checked[]): string {
  const count = (all: Diagnostic[], severity: Severity) =>
    all.filter((d) => d.severity === severity).length

  const files = checked.map((file) => ({
    file: file.file,
    format: file.analysis.format,
    summary: file.analysis.summary,
    diagnostics: ordered(file.analysis.diagnostics).map((d) => ({
      severity: d.severity,
      code: d.code,
      message: d.message,
      detail: d.detail,
      path: formatPath(d.path),
      line: d.range.line,
      column: d.range.column,
      endLine: d.range.endLine,
      docs: docsForCode(d.code)?.url,
    })),
    unchecked: {
      unrecognised: file.analysis.unknowns.filter((u) => u.kind === 'unrecognised').length,
      unvalidated: file.analysis.unknowns.filter((u) => u.kind === 'unvalidated').length,
      fields: file.analysis.unknowns.map((u) => ({
        key: u.key,
        kind: u.kind,
        path: formatPath(u.path),
        line: u.range.line,
      })),
    },
  }))

  const all = checked.flatMap((c) => c.analysis.diagnostics)
  const unknowns = checked.flatMap((c) => c.analysis.unknowns)

  return JSON.stringify(
    {
      schema: 'attache-findings-1',
      version: VERSION,
      files,
      totals: {
        files: checked.length,
        errors: count(all, 'error'),
        warnings: count(all, 'warning'),
        info: count(all, 'info'),
        unrecognised: unknowns.filter((u) => u.kind === 'unrecognised').length,
        unvalidated: unknowns.filter((u) => u.kind === 'unvalidated').length,
      },
    },
    null,
    2,
  )
}

// ---- SARIF ------------------------------------------------------------------------

const SARIF_LEVEL: Record<Severity, string> = { error: 'error', warning: 'warning', info: 'note' }

/**
 * SARIF 2.1.0, which is what GitHub code scanning and most everything else reads.
 *
 * Worth the extra format because it is the one that survives: an annotation lives for the
 * length of a pull request, and a SARIF upload becomes an alert with a history, so "this
 * listener has had no router filter for four months" is a question somebody can answer.
 *
 * Rules are derived from the codes actually present rather than from the full list, because
 * a tool that declares thirty rules and reports two reads as one with twenty-eight passing
 * checks — and this package does not have a passing state to claim.
 */
function sarif(checked: readonly Checked[]): string {
  const seen = new Map<string, { id: string; helpUri?: string }>()
  const results: unknown[] = []

  for (const file of checked) {
    for (const diagnostic of ordered(file.analysis.diagnostics)) {
      if (!seen.has(diagnostic.code)) {
        seen.set(diagnostic.code, {
          id: diagnostic.code,
          helpUri: docsForCode(diagnostic.code)?.url,
        })
      }

      results.push({
        ruleId: diagnostic.code,
        level: SARIF_LEVEL[diagnostic.severity],
        message: {
          text: diagnostic.detail
            ? `${diagnostic.message}\n\n${diagnostic.detail}`
            : diagnostic.message,
        },
        locations: [
          {
            physicalLocation: {
              // Forward slashes and no leading `./`, which is what the spec asks for and
              // what GitHub needs to line an alert up with a file in the repository.
              artifactLocation: { uri: file.file.replace(/\\/g, '/').replace(/^\.\//, '') },
              region: {
                startLine: diagnostic.range.line,
                startColumn: diagnostic.range.column,
                endLine: diagnostic.range.endLine,
              },
            },
          },
        ],
      })
    }
  }

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: 'Attaché',
              version: VERSION,
              informationUri: 'https://github.com/emmettl/attache',
              rules: [...seen.values()].map((rule) => ({
                id: rule.id,
                name: rule.id,
                shortDescription: { text: rule.id.replace(/-/g, ' ') },
                ...(rule.helpUri ? { helpUri: rule.helpUri } : {}),
              })),
            },
          },
          // Not a finding, and not dressed up as one. It rides along as a property so that
          // whatever consumes this can still see how much of each config was covered.
          properties: {
            unchecked: checked.map((c) => ({
              file: c.file,
              unrecognised: c.analysis.unknowns.filter((u) => u.kind === 'unrecognised').length,
              unvalidated: c.analysis.unknowns.filter((u) => u.kind === 'unvalidated').length,
            })),
          },
          results,
        },
      ],
    },
    null,
    2,
  )
}

// ---- the switch -------------------------------------------------------------------

export function render(checked: readonly Checked[], options: ReportOptions): string {
  switch (options.format) {
    case 'human':
      return human(checked, options)
    case 'github':
      return github(checked, options)
    case 'json':
      return json(checked)
    case 'sarif':
      return sarif(checked)
  }
}
