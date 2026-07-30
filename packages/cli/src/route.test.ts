import { describe, expect, test } from 'vitest'
import { analyse, matchRequest, type TestRequest } from '@attache/core'
import { parseRouteArgs } from './cli.js'
import { failures, renderRoute, routeExitCode, type Expectation, type RouteCheck } from './route.js'

const CONFIG = `static_resources:
  listeners:
  - name: ingress
    address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: local
            virtual_hosts:
            - name: api
              domains: ["api.example.com"]
              routes:
              - name: health
                match: { path: /healthz }
                direct_response: { status: 200, body: { inline_string: "OK" } }
              - name: v1
                match: { prefix: /v1 }
                route: { cluster: api_service }
            - name: catchall
              domains: ["*"]
              routes:
              - match: { prefix: / }
                route: { cluster: web_service }
  clusters:
  - name: api_service
  - name: web_service
`

/** A route whose upstream is decided at request time, so no answer about it is certain. */
const WEIGHTED = `static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
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
              - name: canary
                match: { prefix: / }
                route:
                  weighted_clusters:
                    clusters:
                    - { name: v2, weight: 10 }
                    - { name: v1, weight: 90 }
  clusters:
  - name: v1
  - name: v2
`

const ask = (
  config: string,
  request: Partial<TestRequest>,
  expect_: Expectation = {},
): RouteCheck => {
  const full: TestRequest = {
    authority: 'api.example.com',
    path: '/v1/users',
    method: 'GET',
    headers: {},
    ...request,
  }
  return {
    file: 'envoy.yaml',
    request: full,
    result: matchRequest(analyse(config).model, full),
    expect: expect_,
  }
}

const options = { colour: false, quiet: false }

describe('asserting where a request goes', () => {
  test('an expectation that holds exits zero', () => {
    const check = ask(CONFIG, {}, { cluster: 'api_service' })
    expect(failures(check)).toEqual([])
    expect(routeExitCode(check)).toBe(0)
  })

  test('an expectation that breaks exits one and says both halves', () => {
    const check = ask(CONFIG, {}, { cluster: 'web_service' })
    expect(routeExitCode(check)).toBe(1)
    expect(failures(check)).toEqual([
      { what: 'cluster', expected: 'web_service', actual: 'api_service' },
    ])
    expect(renderRoute(check, 'human', options)).toContain(
      'expected cluster web_service, got api_service',
    )
  })

  test('a request that reaches no upstream says so rather than `undefined`', () => {
    // A direct response, a redirect and a 404 all reach no cluster at all, which is a
    // different thing from reaching one this tester could not name.
    const check = ask(CONFIG, { path: '/healthz' }, { cluster: 'api_service' })
    expect(failures(check)[0]!.actual).toBe('no cluster')
  })

  test('the outcome can be asserted on its own', () => {
    // The shape that guards against a shadowing regression: this path SHOULD 404, and the
    // day somebody adds a `prefix: /` above it, it silently will not.
    const reaches = ask(CONFIG, { authority: 'nope.example.com' }, { outcome: 'no-virtual-host' })
    expect(routeExitCode(reaches)).toBe(1)
    expect(failures(reaches)[0]).toMatchObject({ expected: 'no-virtual-host', actual: 'matched' })

    const missing = ask(CONFIG, { authority: 'api.example.com', path: '/nope' })
    expect(routeExitCode({ ...missing, expect: { outcome: 'no-route' } })).toBe(0)
  })

  test('with no expectation it is a question, and a 404 is an answer', () => {
    // Exiting non-zero here would make the informational mode unusable under `set -e`.
    const check = ask(CONFIG, { authority: 'api.example.com', path: '/nope' })
    expect(check.result.outcome).toBe('no-route')
    expect(routeExitCode(check)).toBe(0)
  })
})

describe('the human output', () => {
  const out = renderRoute(ask(CONFIG, {}), 'human', options)

  test('leads with the request and the verdict', () => {
    expect(out.split('\n')[0]).toContain('GET api.example.com/v1/users')
    expect(out).toContain('→ cluster `api_service`')
  })

  test('shows every candidate that lost, with the reason', () => {
    // The whole point. "It went to the wrong cluster" is almost never about the winner.
    expect(out).toContain('· catchall')
    expect(out).toContain('is more specific than `*`')
    expect(out).toContain('· health')
    expect(out).toContain('the path is not exactly `/healthz`')
  })

  test('quiet drops the candidates and keeps the verdict', () => {
    const quiet = renderRoute(ask(CONFIG, {}), 'human', { ...options, quiet: true })
    expect(quiet).toContain('→ cluster `api_service`')
    expect(quiet).not.toContain('catchall')
  })

  test('a passing expectation on uncertain ground says so above the tick', () => {
    const check = ask(WEIGHTED, { authority: 'x', path: '/' }, { cluster: 'v2' })
    const rendered = renderRoute(check, 'human', options)
    expect(routeExitCode(check)).toBe(0)
    expect(rendered).toContain('this answer is not certain')
    expect(rendered.indexOf('not certain')).toBeLessThan(rendered.indexOf('as expected'))
  })

  test('says "as expected" rather than "passed"', () => {
    // The tester is reporting that its answer matched the one you predicted. That is a
    // smaller claim than the config being right, and the wording keeps it that size.
    const rendered = renderRoute(ask(CONFIG, {}, { cluster: 'api_service' }), 'human', options)
    expect(rendered).toContain('as expected')
    expect(rendered).not.toMatch(/\bpassed\b|\bvalid\b|\bOK\b/)
  })
})

describe('the GitHub output', () => {
  test('annotates a broken expectation, and carries the losers into the body', () => {
    const out = renderRoute(ask(CONFIG, {}, { cluster: 'web_service' }), 'github', options)
    expect(out).toMatch(/^::error file=envoy\.yaml,title=/m)
    expect(out).toContain('Expected cluster web_service, got api_service.')
    expect(out).toContain('%0A%0A')
    // No `line=`: the failure is about the config as a whole, and pointing at the winning
    // route would blame the line that is behaving correctly.
    expect(out).not.toContain('line=')
  })

  test('warns when an expectation held on ground the tester cannot be sure of', () => {
    // Otherwise the diff shows a green check for `--expect-cluster v2` against a route that
    // splits traffic by weight, and the log line saying otherwise is in a job nobody opens.
    const out = renderRoute(
      ask(WEIGHTED, { authority: 'x', path: '/' }, { cluster: 'v2' }),
      'github',
      options,
    )
    expect(out).toMatch(/^::warning file=envoy\.yaml,title=Attaché%3A route assertion is not certain/m)
    expect(out).not.toContain('::error')
  })

  test('says nothing extra when there was no expectation to qualify', () => {
    const out = renderRoute(ask(WEIGHTED, { authority: 'x', path: '/' }), 'github', options)
    expect(out).not.toContain('::warning')
    expect(out).not.toContain('::error')
  })
})

describe('the JSON output', () => {
  const parsed = JSON.parse(
    renderRoute(ask(CONFIG, {}, { cluster: 'web_service' }), 'json', options),
  )

  test('is versioned and carries the request it was asked', () => {
    expect(parsed.schema).toBe('attache-route-1')
    expect(parsed.request).toMatchObject({ authority: 'api.example.com', path: '/v1/users' })
  })

  test('carries the verdict, the failures and every stage', () => {
    expect(parsed.outcome).toBe('matched')
    expect(parsed.cluster).toBe('api_service')
    expect(parsed.failures).toHaveLength(1)
    expect(parsed.stages.map((s: { stage: string }) => s.stage)).toEqual([
      'listener',
      'filter chain',
      'virtual host',
      'route',
    ])
    const hosts = parsed.stages.find((s: { stage: string }) => s.stage === 'virtual host')
    expect(hosts.candidates).toHaveLength(2)
    expect(hosts.candidates.find((c: { matched: boolean }) => !c.matched).reason).toContain(
      'more specific',
    )
  })
})

describe('the route arguments', () => {
  test('builds a request from the flags', () => {
    const args = parseRouteArgs([
      'envoy.yaml',
      '--authority',
      'api.example.com',
      '--path',
      '/v1',
      '--method',
      'post',
      '--port',
      '8080',
      '--sni',
      'api.example.com',
    ])
    expect(args.error).toBeUndefined()
    expect(args.file).toBe('envoy.yaml')
    expect(args.request).toMatchObject({
      authority: 'api.example.com',
      path: '/v1',
      // Upper-cased, because `:method` is and a config matching on it would otherwise miss.
      method: 'POST',
      port: 8080,
      serverName: 'api.example.com',
    })
  })

  test('splits a header on the first colon and lower-cases the name', () => {
    // A `x-forwarded-proto: https://x` value has more colons in it, and a header split on
    // the last one is a header nobody wrote.
    const args = parseRouteArgs([
      'e.yaml',
      '--authority',
      'a',
      '-H',
      'X-Forwarded-Proto: https://x',
      '--header',
      'x-canary: yes',
    ])
    expect(args.request.headers).toEqual({
      'x-forwarded-proto': 'https://x',
      'x-canary': 'yes',
    })
  })

  test('reads both expectations', () => {
    const args = parseRouteArgs([
      'e.yaml',
      '--authority',
      'a',
      '--expect-cluster',
      'api',
      '--expect-outcome',
      'matched',
    ])
    expect(args.expect).toEqual({ cluster: 'api', outcome: 'matched' })
  })

  test('refuses what it cannot act on rather than guessing', () => {
    // A mistyped expectation that were silently ignored is a CI job asserting nothing and
    // passing, which is worse than one that never ran.
    expect(parseRouteArgs(['e.yaml', '--authority', 'a', '--expect-outcome', 'matchd']).error)
      .toContain('--expect-outcome')
    expect(parseRouteArgs(['e.yaml', '--authority', 'a', '--header', 'nocolon']).error)
      .toContain('--header')
    expect(parseRouteArgs(['e.yaml', '--authority', 'a', '--port', 'eighty']).error)
      .toContain('--port')
    expect(parseRouteArgs(['e.yaml']).error).toContain('--authority')
    expect(parseRouteArgs(['--authority', 'a']).error).toContain('config')
    expect(parseRouteArgs(['a.yaml', 'b.yaml', '--authority', 'a']).error).toContain('one config')
    // SARIF is a finding at a location, and a route assertion has no honest location.
    expect(parseRouteArgs(['e.yaml', '--authority', 'a', '--format', 'sarif']).error)
      .toContain('--format')
  })

  test('--help needs nothing else to be valid', () => {
    expect(parseRouteArgs(['--help']).error).toBeUndefined()
  })
})
