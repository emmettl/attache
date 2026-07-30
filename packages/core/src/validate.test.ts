import { describe, expect, test } from 'vitest'
import { FRONT_PROXY, TROUBLE } from './fixtures.js'
import { analyse } from './index.js'
import type { DiagnosticCode } from './diagnostics.js'

const codes = (text: string): DiagnosticCode[] => analyse(text).diagnostics.map((d) => d.code)

describe('a config with nothing relational wrong', () => {
  test('produces no errors', () => {
    const errors = analyse(FRONT_PROXY).diagnostics.filter((d) => d.severity === 'error')
    expect(errors).toEqual([])
  })
})

describe('names that refer to nothing', () => {
  test('a route naming a cluster that does not exist is an error', () => {
    const found = analyse(TROUBLE).diagnostics.find((d) => d.code === 'cluster-not-found')
    expect(found?.message).toContain('ghost_service')
    expect(found?.severity).toBe('error')
  })

  test('a cluster nothing routes to is a warning, not an error', () => {
    const found = analyse(TROUBLE).diagnostics.find((d) => d.code === 'cluster-unused')
    expect(found?.message).toContain('nobody_calls_me')
    expect(found?.severity).toBe('warning')
  })

  test('a weighted cluster counts as a reference', () => {
    expect(
      codes(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route:
                  weighted_clusters:
                    clusters:
                    - { name: blue, weight: 50 }
                    - { name: green, weight: 50 }
  clusters:
  - name: blue
  - name: green
`),
    ).not.toContain('cluster-unused')
  })
})

describe('names claimed twice', () => {
  test('two listeners with one name is an error', () => {
    expect(codes(TROUBLE)).toContain('duplicate-listener-name')
  })

  test('two listeners on one address is an error', () => {
    expect(codes(TROUBLE)).toContain('duplicate-listener-address')
  })

  test('two virtual hosts claiming one domain is an error', () => {
    expect(
      codes(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: first
              domains: ["example.com"]
              routes: []
            - name: second
              domains: ["example.com"]
              routes: []
  clusters: []
`),
    ).toContain('duplicate-domain')
  })
})

describe('routes that can never match', () => {
  test('a prefix route below a broader one is flagged', () => {
    const found = analyse(TROUBLE).diagnostics.find((d) => d.code === 'route-unreachable')
    expect(found?.severity).toBe('warning')
    expect(found?.detail).toContain('first match wins')
  })

  test('the same routes in the useful order are not flagged', () => {
    expect(codes(FRONT_PROXY)).not.toContain('route-unreachable')
  })

  test('an earlier route with header criteria shadows nothing', () => {
    // It might not match — the header decides at request time — so declaring the later
    // route dead would be a guess presented as a finding.
    expect(
      codes(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                  headers: [{ name: x-canary, string_match: { exact: "1" } }]
                route: { cluster: canary }
              - match: { prefix: "/api" }
                route: { cluster: api }
  clusters:
  - name: canary
  - name: api
`),
    ).not.toContain('route-unreachable')
  })
})

describe('an HTTP connection manager with nowhere to route', () => {
  const withoutRoutes = `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress
  clusters: []
`

  test('is an error', () => {
    expect(codes(withoutRoutes)).toContain('no-route-config')
  })

  test('but routes delivered over RDS are not — they are just elsewhere', () => {
    const found = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          rds: { route_config_name: local_route }
  clusters: []
`).diagnostics.find((d) => d.code === 'dynamic-resource-not-resolvable')

    expect(found?.severity).toBe('info')
    expect(found?.message).toContain('local_route')
  })
})

describe('required fields', () => {
  test('a cluster with no name is an error', () => {
    expect(
      codes(`
static_resources:
  clusters:
  - type: STATIC
`),
    ).toContain('missing-required')
  })

  test('a bad enum names the values it would have accepted', () => {
    const found = analyse(`
static_resources:
  clusters:
  - name: c
    type: SORT_OF_DNS
`).diagnostics.find((d) => d.code === 'bad-enum')
    expect(found?.message).toContain('STRICT_DNS')
    expect(found?.message).toContain('SORT_OF_DNS')
  })
})

describe('http filter order', () => {
  const withFilters = (names: string[]) => `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config: { virtual_hosts: [] }
          http_filters:
${names.map((n) => `          - name: ${n}`).join('\n')}
  clusters: []
`

  test('the router last is fine', () => {
    expect(
      codes(withFilters(['envoy.filters.http.cors', 'envoy.filters.http.router'])),
    ).not.toContain('router-not-last')
  })

  test('a filter after the router can never run', () => {
    const found = analyse(
      withFilters(['envoy.filters.http.router', 'envoy.filters.http.cors']),
    ).diagnostics.find((d) => d.code === 'router-not-last')
    expect(found?.severity).toBe('error')
    // Names the filters that are stranded, not just the fact of it.
    expect(found?.detail).toContain('envoy.filters.http.cors')
  })

  test('no router at all is an error', () => {
    expect(codes(withFilters(['envoy.filters.http.cors']))).toContain('no-router-filter')
  })
})

describe('transport', () => {
  const chain = (body: string) => `
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - ${body}
      filters: []
  clusters: []
`

  test('SNI matching on a chain that does not terminate TLS is flagged', () => {
    const found = analyse(
      chain('filter_chain_match: { server_names: ["www.foo.com"] }'),
    ).diagnostics.find((d) => d.code === 'sni-without-tls')
    expect(found?.severity).toBe('warning')
    expect(found?.detail).toContain('TLS handshake')
  })

  test('SNI matching on a chain that does terminate TLS is not', () => {
    expect(
      codes(
        chain(`filter_chain_match: { server_names: ["www.foo.com"] }
      transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificates:
            - certificate_chain: { filename: /cert.pem }
              private_key: { filename: /key.pem }`),
      ),
    ).not.toContain('sni-without-tls')
  })

  test('TLS with no certificate at all is an error', () => {
    expect(
      codes(
        chain(`transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context: {}`),
      ),
    ).toContain('tls-without-certificate')
  })

  test('a certificate delivered by SDS counts', () => {
    expect(
      codes(
        chain(`transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificate_sds_secret_configs:
            - name: server_cert`),
      ),
    ).not.toContain('tls-without-certificate')
  })

  test('key material is counted, never carried into the model', () => {
    const model = analyse(
      chain(`transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            alpn_protocols: ["h2", "http/1.1"]
            tls_certificates:
            - private_key: { inline_string: "SUPER-SECRET" }`),
    ).model
    const tls = model.listeners[0]!.filterChains[0]!.tls!
    expect(tls.certificateCount).toBe(1)
    expect(tls.alpnProtocols).toEqual(['h2', 'http/1.1'])
    expect(JSON.stringify(tls)).not.toContain('SUPER-SECRET')
  })
})

test('a listener with no filter chains is an error', () => {
  expect(
    codes(`
static_resources:
  listeners:
  - name: empty
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains: []
  clusters: []
`),
  ).toContain('no-filter-chains')
})

describe('a cluster the file does not define', () => {
  const withDynamic = (dynamic: string) => `
${dynamic}
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
            name: r
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: elsewhere } }]
          http_filters:
          - name: envoy.filters.http.router
  clusters: []
`

  test('is an error when nothing says it could arrive later', () => {
    const found = analyse(withDynamic('')).diagnostics.find((d) => d.code === 'cluster-not-found')
    expect(found?.severity).toBe('error')
  })

  test('is not an error when the bootstrap fetches clusters over CDS', () => {
    const found = analyse(
      withDynamic(`dynamic_resources:
  cds_config:
    api_config_source:
      api_type: GRPC
      grpc_services:
      - envoy_grpc: { cluster_name: xds_cluster }`),
    ).diagnostics.find((d) => d.code === 'cluster-not-found')

    // The old wording said "nothing in this config says so" about CDS delivery. Something
    // does now, and keeping it at error severity would be the tool ignoring evidence in the
    // same file using the word that means it is sure.
    expect(found?.severity).toBe('info')
    expect(found?.detail).toContain('xds_cluster')
  })

  test('is still an error in a config dump, which lists what Envoy actually holds', () => {
    const dump = JSON.stringify({
      configs: [
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.BootstrapConfigDump',
          bootstrap: { dynamic_resources: { cds_config: { ads: {} } } },
        },
        {
          '@type': 'type.googleapis.com/envoy.admin.v3.RoutesConfigDump',
          static_route_configs: [
            {
              route_config: {
                name: 'r',
                virtual_hosts: [
                  {
                    name: 'v',
                    domains: ['*'],
                    routes: [{ match: { prefix: '/' }, route: { cluster: 'elsewhere' } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    expect(
      analyse(dump).diagnostics.find((d) => d.code === 'cluster-not-found')?.severity,
    ).toBe('error')
  })
})

describe('references that are not routes', () => {
  const withMirror = (mirror: string) => `
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
            name: r
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route:
                  cluster: primary
                  request_mirror_policies:
                  - cluster: ${mirror}
  clusters:
  - name: primary
  - name: shadow
`

  test('a cluster reached only by a mirror policy is not called unreached', () => {
    // The same shape `ext_authz` and `tcp_proxy` each had: a cluster this config sends every
    // matching request a copy of, reported as one nothing reaches.
    const codes = analyse(withMirror('shadow')).diagnostics.map((d) => d.code)
    expect(codes).not.toContain('cluster-unused')
  })

  test('and a mirror naming a cluster that is not here is reported', () => {
    const found = analyse(withMirror('ghost')).diagnostics.find(
      (d) => d.code === 'cluster-not-found',
    )
    expect(found?.message).toContain('ghost')
  })
})

describe('two listeners that cannot both start', () => {
  test('`0.0.0.0` and an address left out are the same bind', () => {
    // Both are the wildcard. Comparing the strings `0.0.0.0:80` and `*:80` said they were
    // different and let a genuine bind conflict through.
    const codes = analyse(`
static_resources:
  listeners:
  - name: a
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
  - name: b
    address: { socket_address: { port_value: 80 } }
`).diagnostics.map((d) => d.code)
    expect(codes).toContain('duplicate-listener-address')
  })

  test('an additional address conflicts like any other', () => {
    const codes = analyse(`
static_resources:
  listeners:
  - name: a
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
    additional_addresses:
    - address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
  - name: b
    address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
`).diagnostics.map((d) => d.code)
    expect(codes).toContain('duplicate-listener-address')
  })

  test('a listener that never binds cannot conflict', () => {
    // `bind_to_port: false` is a virtual listener, reached by another listener redirecting
    // to it. Sharing a port with one is the entire point rather than a mistake.
    const codes = analyse(`
static_resources:
  listeners:
  - name: real
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
  - name: virtual
    bind_to_port: false
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
`).diagnostics.map((d) => d.code)
    expect(codes).not.toContain('duplicate-listener-address')
  })
})

describe('which routes are genuinely unreachable', () => {
  const routes = (body: string) => `
static_resources:
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
${body}
  clusters:
  - name: a
  - name: b
`
  const unreachable = (body: string) =>
    analyse(routes(body)).diagnostics.filter((d) => d.code === 'route-unreachable')

  test('a route that does not take every request shadows nothing', () => {
    // The one that matters. A canary at fifty per cent sends half its traffic to the route
    // underneath it BY DESIGN, so calling that dead config is a false accusation — and
    // reading `runtime_fraction` without telling `shadows` about it is what created one.
    expect(
      unreachable(`              - name: canary
                match:
                  prefix: /
                  runtime_fraction: { default_value: { numerator: 50, denominator: HUNDRED } }
                route: { cluster: a }
              - name: rest
                match: { prefix: / }
                route: { cluster: b }`),
    ).toEqual([])
  })

  test('a `path_separated_prefix` above covers what sits under it', () => {
    const found = unreachable(`              - name: api
                match: { path_separated_prefix: /api }
                route: { cluster: a }
              - name: below
                match: { prefix: /api/v1 }
                route: { cluster: b }`)
    expect(found).toHaveLength(1)
    // Named as it was written: saying `prefix:` here would send somebody looking for a line
    // that is not in their file.
    expect(found[0]!.detail).toContain('`path_separated_prefix: /api`')
  })

  test('and does not cover a sibling that merely starts with the same letters', () => {
    // `path_separated_prefix: /api` takes `/api` and `/api/...` and nothing else, so a
    // plain `startsWith` would invent a shadow Envoy does not have.
    expect(
      unreachable(`              - name: api
                match: { path_separated_prefix: /api }
                route: { cluster: a }
              - name: sibling
                match: { prefix: /apifoo }
                route: { cluster: b }`),
    ).toEqual([])
  })

  test('the same exact path written twice', () => {
    // An ordinary merge artefact, and the second one never runs.
    expect(
      unreachable(`              - name: first
                match: { path: /healthz }
                route: { cluster: a }
              - name: second
                match: { path: /healthz }
                route: { cluster: b }`),
    ).toHaveLength(1)
  })

  test('an exact path does not shadow a prefix that merely contains it', () => {
    // `path: /api` takes exactly `/api`. `prefix: /api` takes far more, and remains
    // reachable for everything else under it.
    expect(
      unreachable(`              - name: exact
                match: { path: /api }
                route: { cluster: a }
              - name: under
                match: { prefix: /api }
                route: { cluster: b }`),
    ).toEqual([])
  })

  test('a regex above claims nothing, because a string comparison cannot say', () => {
    expect(
      unreachable(`              - name: re
                match: { safe_regex: { regex: "/.*" } }
                route: { cluster: a }
              - name: after
                match: { prefix: /anything }
                route: { cluster: b }`),
    ).toEqual([])
  })
})

test('one missing cluster named by three routes is three findings, at three lines', () => {
  // Locked in as a decision rather than left as an accident. Deduplicating on the name
  // would have to pick one of the three routes to point at, and the other two would look
  // fine in the editor — so somebody fixes the line they were shown and ships the rest.
  const found = analyse(`
static_resources:
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
              - match: { path: /1 }
                route: { cluster: ghost }
              - match: { path: /2 }
                route: { cluster: ghost }
              - match: { path: /3 }
                route: { cluster: ghost }
  clusters: []
`).diagnostics.filter((d) => d.code === 'cluster-not-found')

  expect(found).toHaveLength(3)
  expect(new Set(found.map((d) => d.range.line)).size).toBe(3)
})
