import { describe, expect, test } from 'vitest'
import { FRONT_PROXY, PRODUCTION } from './fixtures.js'
import { analyse } from './index.js'
import { matchRequest, type TestRequest } from './match.js'
import type { ConfigModel } from './types.js'

const ask = (model: ConfigModel, request: Partial<TestRequest>) =>
  matchRequest(model, {
    authority: 'example.com',
    path: '/',
    method: 'GET',
    port: 10000,
    headers: {},
    ...request,
  })

/** A config with one listener and whatever virtual hosts the test needs. */
function withHosts(hosts: string, clusters = 'a'): ConfigModel {
  const text = `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: local_route
            virtual_hosts:
${hosts}
  clusters:
${clusters
  .split(',')
  .map((c) => `  - name: ${c.trim()}`)
  .join('\n')}
`
  return analyse(text).model
}

describe('virtual host domain precedence', () => {
  // Every host routes to a differently named cluster, so the winner is legible from the
  // result alone.
  const model = withHosts(
    `            - name: exact
              domains: ["www.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: exact } }]
            - name: suffix_long
              domains: ["*.bar.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: suffix_long } }]
            - name: suffix_short
              domains: ["*.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: suffix_short } }]
            - name: prefix
              domains: ["api.*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: prefix } }]
            - name: catchall
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: catchall } }]`,
    'exact, suffix_long, suffix_short, prefix, catchall',
  )

  test.each([
    ['www.foo.com', 'exact', 'exact'],
    ['a.bar.foo.com', 'suffix_long', 'suffix-wildcard'],
    ['other.foo.com', 'suffix_short', 'suffix-wildcard'],
    ['api.elsewhere.net', 'prefix', 'prefix-wildcard'],
    ['nothing.in.particular', 'catchall', 'any'],
  ])('%s → %s', (authority, cluster, precedence) => {
    const result = ask(model, { authority })
    expect(result.cluster).toBe(cluster)
    expect(result.domainMatch?.precedence).toBe(precedence)
  })

  test('an exact name beats a wildcard that also covers it', () => {
    // Both `www.foo.com` and `*.foo.com` match, and declaration order does not decide it.
    expect(ask(model, { authority: 'www.foo.com' }).cluster).toBe('exact')
  })

  test('the longest suffix wildcard wins', () => {
    expect(ask(model, { authority: 'a.bar.foo.com' }).cluster).toBe('suffix_long')
  })

  test('a suffix wildcard does not match the bare domain it wraps', () => {
    const bare = withHosts(
      `            - name: wild
              domains: ["*.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: a } }]`,
    )
    expect(ask(bare, { authority: 'foo.com' }).outcome).toBe('no-virtual-host')
    expect(ask(bare, { authority: 'x.foo.com' }).outcome).toBe('matched')
  })

  test('declaration order does not decide it', () => {
    // The same set written in the opposite order gives the same answers.
    const reversed = withHosts(
      `            - name: catchall
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: catchall } }]
            - name: exact
              domains: ["www.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: exact } }]`,
      'exact, catchall',
    )
    expect(ask(reversed, { authority: 'www.foo.com' }).cluster).toBe('exact')
  })

  test('a request no host claims is a 404, and says so', () => {
    const only = withHosts(
      `            - name: strict
              domains: ["only.foo.com"]
              routes: [{ match: { prefix: "/" }, route: { cluster: a } }]`,
    )
    const result = ask(only, { authority: 'somewhere.else' })
    expect(result.outcome).toBe('no-virtual-host')
    expect(result.explanation).toContain('404')
  })
})

describe('route order', () => {
  const { model } = analyse(FRONT_PROXY)

  test('the first matching route wins', () => {
    expect(ask(model, { path: '/api/v2/users' }).cluster).toBe('api_service')
    expect(ask(model, { path: '/anything' }).cluster).toBe('web_service')
  })

  test('the losers say why they lost', () => {
    const result = ask(model, { path: '/anything' })
    expect(result.routeAttempts[0]).toMatchObject({
      matched: false,
      reason: 'the path is not under `/api`',
    })
    expect(result.routeAttempts[1]!.matched).toBe(true)
  })

  test('the explanation names the route and the cluster', () => {
    expect(ask(model, { path: '/api/x' }).explanation).toBe(
      'Matched route 1 of `backend` → cluster `api_service`.',
    )
  })
})

describe('path matching', () => {
  const model = withHosts(
    `            - name: v
              domains: ["*"]
              routes:
              - match: { path: "/exact" }
                route: { cluster: exact }
              - match: { path_separated_prefix: "/seg" }
                route: { cluster: seg }
              - match: { safe_regex: { regex: "/re/[0-9]+" } }
                route: { cluster: re }
              - match: { prefix: "/case", case_sensitive: false }
                route: { cluster: insensitive }`,
    'exact, seg, re, insensitive',
  )

  test.each([
    ['/exact', 'exact'],
    ['/exact?a=1', 'exact'],
    ['/seg', 'seg'],
    ['/seg/below', 'seg'],
    ['/re/123', 're'],
    ['/CASE/anything', 'insensitive'],
  ])('%s → %s', (path, cluster) => {
    expect(ask(model, { path }).cluster).toBe(cluster)
  })

  test.each([
    ['/exactly', 'an exact path does not match a longer one'],
    ['/segment', 'a path-separated prefix does not match a longer segment'],
    ['/re/abc', 'a regex is anchored at both ends'],
    ['/re/123/more', 'a regex is anchored at both ends'],
  ])('%s does not match — %s', (path) => {
    expect(ask(model, { path }).outcome).toBe('no-route')
  })
})

describe('header and query matching', () => {
  const model = withHosts(
    `            - name: v
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                  headers: [{ name: x-canary, string_match: { exact: "yes" } }]
                route: { cluster: canary }
              - match:
                  prefix: "/"
                  headers: [{ name: x-legacy, exact_match: "1" }]
                route: { cluster: legacy }
              - match:
                  prefix: "/"
                  query_parameters: [{ name: debug, string_match: { exact: "1" } }]
                route: { cluster: debug }
              - match:
                  prefix: "/"
                  headers: [{ name: ":method", string_match: { exact: "POST" } }]
                route: { cluster: writes }
              - match: { prefix: "/" }
                route: { cluster: fallback }`,
    'canary, legacy, debug, writes, fallback',
  )

  test('a header matcher selects its route', () => {
    expect(ask(model, { headers: { 'x-canary': 'yes' } }).cluster).toBe('canary')
  })

  test('the deprecated flat spelling works too', () => {
    // Every tutorial written before Envoy 1.20 uses `exact_match`, and configs in the wild
    // still carry it. Reading only `string_match` would silently ignore this route.
    expect(ask(model, { headers: { 'x-legacy': '1' } }).cluster).toBe('legacy')
  })

  test('a query parameter selects its route', () => {
    expect(ask(model, { path: '/thing?debug=1' }).cluster).toBe('debug')
  })

  test('pseudo-headers are matchable', () => {
    expect(ask(model, { method: 'POST' }).cluster).toBe('writes')
  })

  test('with none of them, the plain route wins', () => {
    expect(ask(model, {}).cluster).toBe('fallback')
  })

  test('a missing header is reported as missing, not as mismatched', () => {
    const result = ask(model, {})
    expect(result.routeAttempts[0]!.reason).toBe('header `x-canary` is missing')
  })

  test('a present but different header quotes what was actually sent', () => {
    const result = ask(model, { headers: { 'x-canary': 'no' } })
    expect(result.routeAttempts[0]!.reason).toBe('header `x-canary` is `no`')
  })
})

describe('the cascade before routing', () => {
  const { model } = analyse(FRONT_PROXY)

  test('a port nothing listens on stops at the listener', () => {
    const result = ask(model, { port: 9999 })
    expect(result.outcome).toBe('no-listener')
    expect(result.listenerAttempts[0]!.reason).toContain('10000')
  })

  test('a TCP-only chain answers with its upstream rather than declining to answer', () => {
    const tcp = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: tcp
          cluster: db
  clusters:
  - name: db
`).model
    // This used to be `not-http` — "no HTTP connection manager, so there are no routes to
    // match", which is true and useless. The chain names `db` outright and the question was
    // where the connection goes, so that is now the answer. `not-http` survives for the case
    // it was really describing: a chain carrying neither an HCM nor a tcp_proxy.
    const result = ask(tcp, {})
    expect(result.outcome).toBe('tcp-proxy')
    expect(result.cluster).toBe('db')
  })

  test('a chain with neither an HCM nor a tcp_proxy is still `not-http`', () => {
    const neither = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.echo
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.echo.v3.Echo
`).model
    expect(ask(neither, {}).outcome).toBe('not-http')
  })

  test('routes that live on a management server are named, not guessed at', () => {
    const rds = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          rds: { route_config_name: remote_routes }
  clusters: []
`).model
    const result = ask(rds, {})
    expect(result.outcome).toBe('routes-elsewhere')
    expect(result.explanation).toContain('remote_routes')
  })
})

describe('filter chain selection', () => {
  const model = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - filter_chain_match: { server_names: ["www.foo.com"] }
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: exact_sni } }]
    - filter_chain_match: { server_names: ["*.foo.com"] }
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: wildcard_sni } }]
  clusters:
  - name: exact_sni
  - name: wildcard_sni
`).model

  test('an exact SNI beats a wildcard one', () => {
    expect(ask(model, { port: 443, serverName: 'www.foo.com' }).cluster).toBe('exact_sni')
  })

  test('a wildcard SNI takes what the exact one does not', () => {
    expect(ask(model, { port: 443, serverName: 'other.foo.com' }).cluster).toBe('wildcard_sni')
  })

  test('SNI that matches nothing leaves the connection unaccepted', () => {
    expect(ask(model, { port: 443, serverName: 'elsewhere.net' }).outcome).toBe('no-filter-chain')
  })
})

describe('answers the tester cannot give on its own', () => {
  test('a weighted split says the choice happens at request time', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route:
                  weighted_clusters:
                    clusters:
                    - { name: blue, weight: 90 }
                    - { name: green, weight: 10 }`,
      'blue, green',
    )
    const result = ask(model, {})
    expect(result.outcome).toBe('matched')
    expect(result.caveats.join(' ')).toContain('decided at request time')
  })

  test('a cluster taken from a header cannot be read from the config', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster_header: x-upstream }`,
      'a',
    )
    const result = ask(model, {})
    expect(result.cluster).toBeUndefined()
    expect(result.caveats.join(' ')).toContain('x-upstream')
  })

  test('a chain matching on IP ranges is flagged rather than guessed at', () => {
    const model = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filter_chain_match:
        source_prefix_ranges: [{ address_prefix: 10.0.0.0, prefix_len: 8 }]
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: internal } }]
  clusters:
  - name: internal
`).model
    const caveats = ask(model, {}).caveats.join(' ')
    expect(caveats).toContain('does not evaluate')
    // Which criterion, not just that there was one. The old wording gestured at "source or
    // destination IP ranges" in general and left the reader to go and find which chain field
    // it meant.
    expect(caveats).toContain('`source_prefix_ranges`')
  })
})

describe('what the winning route does besides choosing a cluster', () => {
  const { model } = analyse(PRODUCTION)

  test('a redirect says where it sends the request', () => {
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '/v1/users?page=2',
      method: 'GET',
      port: 15006,
      headers: {},
    })
    // Host and path from the config, the rest of the path from the request, and the scheme
    // from `https_redirect`. "Redirects rather than proxying" was true and told nobody
    // anything.
    expect(result.explanation).toContain('https://api.example.com/v2/users?page=2')
    expect(result.explanation).toContain('307')
  })

  test('a redirect that overrides nothing still reads back as a destination', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                redirect: { https_redirect: true }`,
      'a',
    )
    const result = ask(model, { authority: 'plain.example', path: '/thing' })
    expect(result.explanation).toContain('https://plain.example/thing')
  })

  test('a route that disables a filter says so', () => {
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '/healthz',
      method: 'GET',
      port: 15006,
      headers: {},
    })
    // The reason this is in the verdict rather than in the list of things not modelled: it
    // is invisible in the route's match, and "why did this request skip authorization" has
    // no answer anywhere else in the config.
    expect(result.explanation).toContain('disables `envoy.filters.http.ext_authz`')
    expect(result.explanation).toContain('answers directly with 200')
    expect(result.explanation).toContain('`OK`')
  })

  test('a route that only overrides a filter is not described as disabling it', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: a }
                typed_per_filter_config:
                  envoy.filters.http.lua:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.lua.v3.LuaPerRoute
                    name: extra`,
      'a',
    )
    const result = ask(model, {})
    expect(result.explanation).toContain('overrides the configuration of `envoy.filters.http.lua`')
    expect(result.explanation).not.toContain('disables')
  })
})

// Cases where the tester used to answer confidently and wrongly.
//
// Each of these was a silent disagreement with Envoy rather than a crash or a blank: the
// tester produced a winner, printed no caveat, and was simply not describing the proxy the
// config would build. That is the worst failure available to a tool whose whole pitch is
// answering where a request actually goes, so each one has a test here.
describe('answers that were confidently wrong', () => {
  test('a config with no listeners says so, rather than asking for a port', () => {
    const model = analyse('static_resources:\n  clusters:\n  - name: a\n').model
    const result = matchRequest(model, {
      authority: 'example.com',
      path: '/',
      method: 'GET',
      headers: {},
    })
    expect(result.outcome).toBe('no-listener')
    expect(result.explanation).toContain('no listeners')
    // The old wording, which described a config nobody was looking at.
    expect(result.explanation).not.toContain('more than one listener')
  })

  test('a chain matching on ALPN wins with a caveat rather than in silence', () => {
    const model = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - name: h2only
      filter_chain_match: { application_protocols: ["h2"] }
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config: { name: r, virtual_hosts: [{ name: v, domains: ["*"], routes: [{ match: { prefix: "/" }, route: { cluster: h2 } }] }] }
    - name: plain
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config: { name: r2, virtual_hosts: [{ name: v, domains: ["*"], routes: [{ match: { prefix: "/" }, route: { cluster: plain } }] }] }
  clusters:
  - name: h2
  - name: plain
`).model
    const result = ask(model, {})
    // ALPN counts towards specificity in Envoy, so the h2 chain really does win for an h2
    // client — and this tester is never told which client. It used to present that as the
    // answer for every client, with nothing said.
    expect(result.filterChain?.name).toBe('h2only')
    expect(result.caveats.join(' ')).toContain('`application_protocols`')
  })

  test('a header matcher written `ignore_case` is matched without case', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                  headers:
                  - name: x-env
                    string_match: { exact: "PROD", ignore_case: true }
                route: { cluster: a }`,
      'a',
    )
    expect(ask(model, { headers: { 'x-env': 'prod' } }).outcome).toBe('matched')
    expect(ask(model, { headers: { 'x-env': 'staging' } }).outcome).toBe('no-route')
  })

  test('a matcher arm nothing here recognises is not treated as a presence check', () => {
    const headers = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                  headers:
                  - name: x-new
                    some_future_match: { foo: 1 }
                route: { cluster: a }`,
      'a',
    )
    // Not "the header is missing", which is what a presence check would have said and which
    // reads as a settled answer about a criterion nothing here evaluated.
    expect(ask(headers, { headers: { 'x-new': 'yes' } }).routeAttempts[0]!.reason).toContain(
      'not evaluated here',
    )

    const query = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                  query_parameters:
                  - name: v
                    some_future_match: { foo: 1 }
                route: { cluster: a }`,
      'a',
    )
    expect(ask(query, { path: '/?v=1' }).routeAttempts[0]!.reason).toContain('not evaluated here')
  })

  test('a route action naming no cluster is said in words, not printed as undefined', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route:
                  weighted_clusters:
                    clusters: []`,
      'a',
    )
    const result = ask(model, {})
    expect(result.explanation).toContain('names no cluster')
    expect(result.explanation).not.toContain('undefined')
  })

  test('a route matching on something unevaluated does not present a settled winner', () => {
    const model = withHosts(
      `            - name: v
              domains: ["*"]
              routes:
              - name: canary
                match:
                  prefix: "/"
                  runtime_fraction: { default_value: { numerator: 50, denominator: HUNDRED } }
                route: { cluster: a }
              - name: rest
                match: { prefix: "/" }
                route: { cluster: a }`,
      'a',
    )
    const result = ask(model, {})
    // It still wins — half the time is not never — but the other half of the traffic goes to
    // the route below it, and that used to go entirely unsaid.
    expect(result.route?.name).toBe('canary')
    expect(result.caveats.join(' ')).toContain('`runtime_fraction`')
    expect(result.caveats.join(' ')).toContain('fall through')
  })
})

describe('what the connection manager does before it routes', () => {
  const listener = (settings: string, routes: string) => `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 8443 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
${settings}
          route_config:
            name: r
${routes}
  clusters:
  - name: a
`

  const ROUTES = `            virtual_hosts:
            - name: v
              domains: ["api.example.com"]
              routes:
              - match: { path: /api/v1 }
                route: { cluster: a }`

  test('merged slashes are applied, and said', () => {
    const model = analyse(listener('          merge_slashes: true', ROUTES)).model
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '//api//v1',
      method: 'GET',
      port: 8443,
      headers: {},
    })
    expect(result.outcome).toBe('matched')
    expect(result.rewrites.join(' ')).toContain('`/api/v1`')
  })

  test('and are not applied when the listener does not ask for them', () => {
    const model = analyse(listener('          stat_prefix: x', ROUTES)).model
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '//api//v1',
      method: 'GET',
      port: 8443,
      headers: {},
    })
    expect(result.outcome).toBe('no-route')
    expect(result.rewrites).toEqual([])
  })

  test('`normalize_path` resolves dot segments before the route is chosen', () => {
    const model = analyse(listener('          normalize_path: true', ROUTES)).model
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '/api/v2/../v1',
      method: 'GET',
      port: 8443,
      headers: {},
    })
    expect(result.outcome).toBe('matched')
    expect(result.rewrites.join(' ')).toContain('`/api/v1`')
  })

  test('the port comes off the authority when the listener strips it', () => {
    // Without the strip, `api.example.com:8443` is matched against the domain list verbatim
    // and reaches nothing — which is correct, surprising, and exactly what somebody comes
    // to the tester to find out.
    const plain = analyse(listener('          stat_prefix: x', ROUTES)).model
    const asked = {
      authority: 'api.example.com:8443',
      path: '/api/v1',
      method: 'GET',
      port: 8443,
      headers: {},
    }
    expect(matchRequest(plain, asked).outcome).toBe('no-virtual-host')

    const stripped = analyse(listener('          strip_matching_host_port: true', ROUTES)).model
    const result = matchRequest(stripped, asked)
    expect(result.outcome).toBe('matched')
    expect(result.rewrites.join(' ')).toContain('strip_matching_host_port')
  })

  test('or when the route config ignores it', () => {
    const model = analyse(
      listener('          stat_prefix: x', `            ignore_port_in_host_matching: true\n${ROUTES}`),
    ).model
    const result = matchRequest(model, {
      authority: 'api.example.com:8443',
      path: '/api/v1',
      method: 'GET',
      port: 8443,
      headers: {},
    })
    expect(result.outcome).toBe('matched')
    expect(result.rewrites.join(' ')).toContain('ignore_port_in_host_matching')
  })

  test('an escaped slash is flagged rather than decoded', () => {
    const model = analyse(
      listener('          path_with_escaped_slashes_action: UNESCAPE_AND_REDIRECT', ROUTES),
    ).model
    const result = matchRequest(model, {
      authority: 'api.example.com',
      path: '/api%2Fv1',
      method: 'GET',
      port: 8443,
      headers: {},
    })
    expect(result.caveats.join(' ')).toContain('escaped slash')
  })
})

test('a listener is found on any of the addresses it binds', () => {
  const model = analyse(`
static_resources:
  listeners:
  - name: dual
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
    additional_addresses:
    - address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config: { name: r, virtual_hosts: [{ name: v, domains: ["*"], routes: [{ match: { prefix: "/" }, route: { cluster: a } }] }] }
  - name: other
    address: { socket_address: { address: 0.0.0.0, port_value: 9000 } }
  clusters:
  - name: a
`).model
  const ask8080 = matchRequest(model, {
    authority: 'x',
    path: '/',
    method: 'GET',
    port: 8080,
    headers: {},
  })
  expect(ask8080.outcome).toBe('matched')
  expect(ask8080.listener?.name).toBe('dual')
})

describe('the order the connection manager rewrites a path in', () => {
  const both = (settings: string) => `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
${settings}
          route_config:
            name: r
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes:
              - name: kept
                match: { path: /a/b }
                route: { cluster: kept }
              - name: eaten
                match: { path: /b }
                route: { cluster: eaten }
  clusters:
  - name: kept
  - name: eaten
`

  test('`normalize_path` runs before `merge_slashes`, as Envoy does', () => {
    // `maybeNormalizePath` calls canonicalPath and only then mergeSlashes. On `/a//../b`
    // that resolves to `/a/b`, because the `..` cancels the empty segment the doubled slash
    // made. The other way round the `..` eats `a` instead and the request lands on `/b` —
    // a different route, named confidently, on any config that sets both.
    const model = analyse(both('          normalize_path: true\n          merge_slashes: true')).model
    const result = matchRequest(model, {
      authority: 'x',
      path: '/a//../b',
      method: 'GET',
      port: 80,
      headers: {},
    })
    expect(result.cluster).toBe('kept')
    expect(result.rewrites.join(' ')).toContain('`/a/b`')
  })

  test('and each is still applied on its own', () => {
    const merged = analyse(both('          merge_slashes: true')).model
    expect(
      matchRequest(merged, { authority: 'x', path: '/a//b', method: 'GET', port: 80, headers: {} })
        .cluster,
    ).toBe('kept')

    const normalised = analyse(both('          normalize_path: true')).model
    expect(
      matchRequest(normalised, { authority: 'x', path: '/a/c/../b', method: 'GET', port: 80, headers: {} })
        .cluster,
    ).toBe('kept')
  })
})

test('an exact SNI beats a wildcard of any length', () => {
  // The rank was a magic 1000 against wildcards scored by their own length, so a pattern
  // longer than that outranked an exact name. Unreachable with real DNS, and now a fact
  // about the code rather than about how long domains happen to be.
  const tail = `${'a'.repeat(1200)}.com`
  const model = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - name: wildcard
      filter_chain_match: { server_names: ["*.${tail}"] }
      filters: []
    - name: exact
      filter_chain_match: { server_names: ["host.${tail}"] }
      filters: []
  clusters: []
`).model
  const result = matchRequest(model, {
    authority: 'x',
    path: '/',
    method: 'GET',
    port: 443,
    serverName: `host.${tail}`,
    headers: {},
  })
  expect(result.filterChain?.name).toBe('exact')
})
