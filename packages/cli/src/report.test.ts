import { describe, expect, test } from 'vitest'
import { analyse } from '@attache/core'
import { parseArgs } from './cli.js'
import { exitCode, fails, render, type Checked, type Format, type ReportOptions } from './report.js'

const check = (text: string, file = 'envoy.yaml'): Checked => ({
  file,
  text,
  analysis: analyse(text),
})

const options = (over: Partial<ReportOptions> = {}): ReportOptions => ({
  format: 'human',
  colour: false,
  failOn: 'error',
  quiet: false,
  showUnchecked: false,
  width: 100,
  ...over,
})

/** A dangling cluster reference (error) and a route that can never match (warning). */
const TROUBLE = `static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: r
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: web }
              - match: { prefix: "/api" }
                route: { cluster: ghost }
  clusters:
  - name: web
`

const CLEAN = 'static_resources: { listeners: [], clusters: [] }\n'

describe('what stops the build', () => {
  test('the threshold is inclusive and ordered', () => {
    const error = { severity: 'error' } as never
    const warning = { severity: 'warning' } as never
    const info = { severity: 'info' } as never

    expect(fails(error, 'error')).toBe(true)
    expect(fails(warning, 'error')).toBe(false)
    expect(fails(warning, 'warning')).toBe(true)
    expect(fails(info, 'warning')).toBe(false)
    expect(fails(info, 'info')).toBe(true)
    expect(fails(error, 'never')).toBe(false)
  })

  test('a config with only warnings passes by default and fails on request', () => {
    // `cluster-unused` is a warning on purpose — routes arriving over RDS are not in the
    // file — so a default run must not gate a deploy on it.
    const warned = [check('static_resources: { clusters: [{ name: a }] }')]
    expect(exitCode(warned, 'error')).toBe(0)
    expect(exitCode(warned, 'warning')).toBe(1)
    expect(exitCode([check(CLEAN)], 'info')).toBe(0)
  })
})

describe('the human format', () => {
  const out = render([check(TROUBLE)], options())

  test('points at a line and underlines the span', () => {
    expect(out).toContain('error[cluster-not-found]: No cluster named `ghost`.')
    expect(out).toContain('--> envoy.yaml:18:17')
    expect(out).toMatch(/^\s*│\s*\^+$/m)
  })

  test('carries the reason and somewhere to read more', () => {
    // The half of a finding that a boot error never gives you.
    expect(out).toContain('Envoy rejects a config whose route names a cluster that is not defined')
    expect(out).toContain('https://www.envoyproxy.io/docs/envoy/latest/api-v3/')
  })

  test('a block range underlines its first token, not the whole line', () => {
    // A mapping node's range runs to the end of everything nested under it, so "the first
    // line of the span" put a hundred and twenty carets under a `@type` URL.
    const carets = render([check(TROUBLE)], options())
      .split('\n')
      .filter((line) => /^\s*│\s*\^+$/.test(line))
    expect(carets.length).toBeGreaterThan(0)
    for (const line of carets) expect(line.replace(/[^^]/g, '').length).toBeLessThan(40)
  })

  test('keeps a config path and a URL on one line, however long', () => {
    // Both are things people select and paste. Wrapping them is what makes them unusable.
    for (const line of out.split('\n')) {
      if (line.includes('= at ')) expect(line.trimEnd().endsWith('routes[1]')).toBe(true)
    }
    expect(out).toMatch(/= RouteAction\.cluster — https:\/\/\S+$/m)
  })

  test('colour is off when asked and on when not', () => {
    expect(render([check(TROUBLE)], options())).not.toContain('[')
    expect(render([check(TROUBLE)], options({ colour: true }))).toContain('[')
  })

  test('quiet keeps only what fails the threshold', () => {
    const quiet = render([check(TROUBLE)], options({ quiet: true }))
    expect(quiet).toContain('cluster-not-found')
    expect(quiet).not.toContain('route-unreachable')
  })

  test('unchecked fields are counted by default and listed on request', () => {
    const config = 'static_resources:\n  clusters:\n  - name: a\n    invented_field: 1\n'
    expect(render([check(config)], options())).not.toContain('invented_field')
    expect(render([check(config)], options({ showUnchecked: true }))).toContain('invented_field')
  })
})

describe('the GitHub format', () => {
  const out = render([check(TROUBLE)], options({ format: 'github' }))

  test('emits one workflow command per finding, at the right level', () => {
    expect(out).toMatch(/^::error file=envoy\.yaml,line=18,col=17,endLine=\d+,title=/m)
    expect(out).toMatch(/^::warning file=envoy\.yaml/m)
  })

  test('an info finding becomes a notice, which is GitHub’s name for it', () => {
    const rds = `static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          rds: { route_config_name: elsewhere }
`
    expect(render([check(rds)], options({ format: 'github' }))).toContain('::notice ')
  })

  test('escapes what would otherwise truncate the command', () => {
    // A newline ends a workflow command, and `:` and `,` separate its properties. Every
    // finding here carries a URL in its body and a code in its title, so getting this wrong
    // cuts the annotation in half rather than failing loudly — one line per finding is what
    // that looks like from the outside.
    expect(out.split('\n').filter((line) => line.startsWith('::'))).toHaveLength(2)
    expect(out).toContain('%0A%0A')
    expect(out).toContain('title=Attaché%3A cluster-not-found')

    const awkward = render([check(TROUBLE, 'a,b:c.yaml')], options({ format: 'github' }))
    expect(awkward).toContain('file=a%2Cb%3Ac.yaml')
  })

  test('the job log still says what was checked', () => {
    // The annotations land on the diff, which leaves the log itself saying nothing.
    expect(out).toContain('envoy.yaml (bootstrap) — 1 error, 1 warning')
  })
})

describe('the JSON format', () => {
  const parsed = JSON.parse(render([check(TROUBLE)], options({ format: 'json' })))

  test('is versioned, because something will parse it', () => {
    expect(parsed.schema).toBe('attache-findings-1')
    expect(typeof parsed.version).toBe('string')
  })

  test('totals every severity and both kinds of unchecked', () => {
    expect(parsed.totals).toEqual({
      files: 1,
      errors: 1,
      warnings: 1,
      info: 0,
      unrecognised: 0,
      unvalidated: 0,
    })
  })

  test('each finding carries where it is and where to read about it', () => {
    const first = parsed.files[0].diagnostics[0]
    expect(first).toMatchObject({ severity: 'error', code: 'cluster-not-found', line: 18 })
    expect(first.path).toContain('routes[1]')
    expect(first.docs).toContain('envoyproxy.io')
  })
})

describe('the SARIF format', () => {
  const parsed = JSON.parse(render([check(TROUBLE)], options({ format: 'sarif' })))
  const run = parsed.runs[0]

  test('is a 2.1.0 document with one run', () => {
    expect(parsed.version).toBe('2.1.0')
    expect(parsed.runs).toHaveLength(1)
    expect(run.tool.driver.name).toBe('Attaché')
  })

  test('declares only the rules it actually reports', () => {
    // A tool declaring thirty rules and reporting two reads as twenty-eight passing checks,
    // and this package has no passing state to claim.
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id).sort()).toEqual([
      'cluster-not-found',
      'route-unreachable',
    ])
  })

  test('locates each result in the file, with forward slashes and no leading dot', () => {
    const location = run.results[0].locations[0].physicalLocation
    expect(location.artifactLocation.uri).toBe('envoy.yaml')
    expect(location.region).toMatchObject({ startLine: 18, startColumn: 17 })
    expect(
      JSON.parse(render([check(TROUBLE, './sub/envoy.yaml')], options({ format: 'sarif' })))
        .runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri,
    ).toBe('sub/envoy.yaml')
  })

  test('carries the unchecked counts as a property rather than as a finding', () => {
    expect(run.properties.unchecked[0]).toMatchObject({ file: 'envoy.yaml' })
    expect(run.results.every((r: { level: string }) => r.level !== 'none')).toBe(true)
  })
})

// The constraint the whole project is built on, asserted at its newest exit.
//
// `diagnostics.ts` says there is no success state and no code path that could produce one;
// the app honours that; a CLI is the easiest place in the world to undo it, because every
// other linter on earth prints a green tick when it finds nothing and it feels wrong not to.
describe('no format claims the config is valid', () => {
  test.each<Format>(['human', 'github', 'json', 'sarif'])('%s', (format) => {
    const out = render([check(CLEAN)], options({ format }))
    expect(out).not.toMatch(/\bvalid\b|✓|✔|\bpassed\b|\bok\b/i)
    // What it says instead, wherever it says anything at all.
    if (format === 'human' || format === 'github') {
      expect(out).toContain('nothing wrong in what I checked')
    }
  })
})

describe('the arguments', () => {
  test('takes files with or without the verb, and `-` for stdin', () => {
    expect(parseArgs(['check', 'a.yaml', 'b.yaml']).files).toEqual(['a.yaml', 'b.yaml'])
    expect(parseArgs(['a.yaml']).files).toEqual(['a.yaml'])
    expect(parseArgs(['check', '-']).files).toEqual(['-'])
  })

  test('a file genuinely called `check` is still reachable', () => {
    // The verb is only swallowed in the leading position.
    expect(parseArgs(['check', 'check']).files).toEqual(['check'])
  })

  test('reads the options', () => {
    const args = parseArgs(['check', 'a.yaml', '--format', 'sarif', '--fail-on', 'warning', '-q'])
    expect(args).toMatchObject({ format: 'sarif', failOn: 'warning', quiet: true })
    expect(parseArgs(['--no-color']).colour).toBe(false)
    expect(parseArgs([]).failOn).toBe('error')
  })

  test('refuses what it cannot act on rather than guessing', () => {
    // Silently ignoring `--format sarrif` in CI means a job that reports nothing and passes.
    expect(parseArgs(['--format', 'sarrif']).error).toContain('--format')
    expect(parseArgs(['--format']).error).toContain('--format')
    expect(parseArgs(['--fail-on', 'critical']).error).toContain('--fail-on')
    expect(parseArgs(['--nonsense']).error).toContain('--nonsense')
    expect(parseArgs(['--width', '3']).error).toContain('--width')
  })
})

// What GitHub's ingestion actually insists on.
//
// Asserted field by field rather than against the published schema, which would mean an
// `ajv` devDependency and a 200 kB document vendored into the repo to catch a shape this
// file produces in forty lines. What follows is the intersection that matters: SARIF 2.1.0's
// required properties, plus the ones code scanning rejects an upload without.
describe('the SARIF conforms', () => {
  const CONFIGS = [
    TROUBLE,
    CLEAN,
    // An info-level finding, which is the one that maps to a level SARIF spells differently.
    `static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          rds: { route_config_name: elsewhere }
`,
  ]

  const LEVELS = new Set(['none', 'note', 'warning', 'error'])

  test.each(CONFIGS.map((c, i) => [i, c]))('config %i', (_i, config) => {
    const doc = JSON.parse(
      render([check(config as string, 'sub/envoy.yaml')], options({ format: 'sarif' })),
    )

    expect(doc.version).toBe('2.1.0')
    expect(Array.isArray(doc.runs)).toBe(true)

    for (const run of doc.runs) {
      // `tool.driver.name` is required by the spec and by the uploader.
      expect(typeof run.tool.driver.name).toBe('string')
      expect(run.tool.driver.name.length).toBeGreaterThan(0)

      const declared = new Set(run.tool.driver.rules.map((r: { id: string }) => r.id))
      for (const rule of run.tool.driver.rules) {
        expect(typeof rule.id).toBe('string')
        if ('helpUri' in rule) expect(rule.helpUri).toMatch(/^https:\/\//)
      }

      for (const result of run.results) {
        // Every rule a result names has to be declared, or the alert has nothing to link to.
        expect(declared.has(result.ruleId)).toBe(true)
        expect(LEVELS.has(result.level)).toBe(true)
        expect(typeof result.message.text).toBe('string')
        expect(result.message.text.length).toBeGreaterThan(0)
        expect(result.locations.length).toBeGreaterThan(0)

        for (const location of result.locations) {
          const { artifactLocation, region } = location.physicalLocation
          // Relative, forward slashes, no leading `./` — otherwise the alert lands on no
          // file in the repository.
          expect(artifactLocation.uri).toBe('sub/envoy.yaml')
          expect(artifactLocation.uri.startsWith('/')).toBe(false)
          expect(artifactLocation.uri).not.toContain('\\')
          // SARIF regions are 1-based, and a region that ends before it starts is rejected.
          expect(region.startLine).toBeGreaterThanOrEqual(1)
          expect(region.startColumn).toBeGreaterThanOrEqual(1)
          expect(region.endLine).toBeGreaterThanOrEqual(region.startLine)
        }
      }
    }
  })

  test('a clean config is a valid document with no results, not an empty one', () => {
    const doc = JSON.parse(render([check(CLEAN)], options({ format: 'sarif' })))
    expect(doc.runs[0].results).toEqual([])
    expect(doc.runs[0].tool.driver.rules).toEqual([])
    expect(doc.runs[0].tool.driver.name).toBe('Attaché')
  })
})
