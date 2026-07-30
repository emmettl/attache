import { describe, expect, test } from 'vitest'
import { analyse, buildGraph, matchRequest } from './index.js'

// Clusters that are named by something other than a route.
//
// The whole point of this file is the config below: it has nothing wrong with it, and before
// tcp_proxy and the service-calling filters were read, Attaché reported two warnings about
// it — that nothing routed to the TCP listener's entire upstream, and that nothing routed to
// the cluster the authorization filter calls on every single request. Both were false, and
// both came from the same gap.

const MIXED = `
static_resources:
  listeners:
  - name: tcp_ingress
    address: { socket_address: { address: 0.0.0.0, port_value: 3306 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: mysql
          cluster: mysql_primary
          idle_timeout: 600s
  - name: http_ingress
    address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: http
          tracing:
            provider:
              name: envoy.tracers.opentelemetry
              typed_config:
                "@type": type.googleapis.com/envoy.config.trace.v3.OpenTelemetryConfig
                grpc_service: { envoy_grpc: { cluster_name: otel } }
          access_log:
          - name: envoy.access_loggers.http_grpc
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.grpc.v3.HttpGrpcAccessLogConfig
              common_config:
                log_name: access
                grpc_service: { envoy_grpc: { cluster_name: log_sink } }
          http_filters:
          - name: envoy.filters.http.ext_authz
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
              grpc_service: { envoy_grpc: { cluster_name: authz } }
          - name: envoy.filters.http.jwt_authn
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication
              providers:
                okta:
                  issuer: https://okta.example.com
                  remote_jwks:
                    http_uri: { uri: https://okta.example.com/keys, cluster: jwks, timeout: 5s }
          - name: envoy.filters.http.router
            typed_config: { "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router }
          route_config:
            name: r
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: / }, route: { cluster: web } }]
  clusters:
  - { name: mysql_primary, type: STATIC }
  - { name: authz, type: STATIC }
  - { name: jwks, type: STRICT_DNS }
  - { name: log_sink, type: STATIC }
  - { name: otel, type: STATIC }
  - { name: web, type: STATIC }
`

describe('a config whose clusters are reached without being routed to', () => {
  const { model, diagnostics } = analyse(MIXED)

  test('reports nothing wrong, where it used to report two things', () => {
    // The regression this file exists for. `mysql_primary` is the whole purpose of the TCP
    // listener and `authz` is called on every request through the HTTP one; both were
    // reported as clusters nothing routes to, on a config with nothing wrong with it.
    expect(diagnostics).toEqual([])
  })

  test('the tcp_proxy chain names its upstream', () => {
    const chain = model.listeners[0]!.filterChains[0]!
    expect(chain.hcm).toBeUndefined()
    expect(chain.tcpProxy).toMatchObject({ statPrefix: 'mysql', cluster: 'mysql_primary' })
  })

  test('the connection manager collects every cluster its own machinery calls', () => {
    const hcm = model.listeners[1]!.filterChains[0]!.hcm!
    expect(hcm.serviceClusters.map((r) => [r.by, r.cluster])).toEqual([
      ['envoy.filters.http.ext_authz', 'authz'],
      // A provider map, so this one arrives from a `fields()` walk rather than a named read.
      ['envoy.filters.http.jwt_authn', 'jwks'],
      ['envoy.access_loggers.http_grpc', 'log_sink'],
      ['envoy.tracers.opentelemetry', 'otel'],
    ])
  })

  test('and still has no opinion about what any of them do', () => {
    // Reading one field out of ext_authz is not the same as checking ext_authz. Every one of
    // those blocks is still reported as read-but-not-checked, exactly as before.
    const { unknowns } = analyse(MIXED)
    const kinds = new Set(unknowns.map((u) => u.kind))
    expect(kinds.has('unrecognised')).toBe(false)
    expect(unknowns.length).toBeGreaterThan(0)
  })
})

describe('the graph', () => {
  const graph = buildGraph(analyse(MIXED).model)

  const edgeTo = (cluster: string) =>
    graph.edges.find((e) => e.to === graph.nodes.find((n) => n.label === cluster)?.id)

  test('draws the tcp_proxy chain through to its cluster', () => {
    // It used to stop at the filter chain, which drew an entire class of listener as a node
    // with nothing after it.
    expect(edgeTo('mysql_primary')).toMatchObject({ label: 'tcp' })
  })

  test('draws the service clusters, labelled by what calls them', () => {
    expect(edgeTo('authz')).toMatchObject({ label: 'ext_authz' })
    expect(edgeTo('log_sink')).toMatchObject({ label: 'http_grpc' })
    expect(edgeTo('otel')).toMatchObject({ label: 'opentelemetry' })
  })

  test('no cluster is left an orphan', () => {
    const reached = new Set(graph.edges.map((e) => e.to))
    for (const node of graph.nodes.filter((n) => n.kind === 'cluster')) {
      expect({ cluster: node.label, reached: reached.has(node.id) }).toEqual({
        cluster: node.label,
        reached: true,
      })
    }
  })
})

describe('testing a request against a tcp_proxy listener', () => {
  const { model } = analyse(MIXED)
  const result = matchRequest(model, {
    authority: 'db.internal',
    path: '/ignored',
    method: 'GET',
    port: 3306,
    headers: {},
  })

  test('answers with the upstream instead of refusing to answer', () => {
    // Before tcp_proxy was modelled this came back as "no HTTP connection manager, so there
    // are no routes to match" — accurate about what it did not find, silent about the
    // upstream sitting right there in the config.
    expect(result.outcome).toBe('tcp-proxy')
    expect(result.cluster).toBe('mysql_primary')
    expect(result.explanation).toContain('mysql_primary')
  })

  test('and says the path and headers had nothing to do with it', () => {
    expect(result.caveats.join(' ')).toContain('played no part')
  })
})

describe('a cluster named only by a filter that does not exist', () => {
  test('is a dangling reference, the same as one a route names', () => {
    const { diagnostics } = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: t
          cluster: gone
  clusters: []
`)
    expect(diagnostics.map((d) => d.code)).toContain('cluster-not-found')
  })
})

describe('weighted tcp_proxy', () => {
  const { model } = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 6379 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: redis
          weighted_clusters:
            clusters:
            - { name: redis_a, weight: 80 }
            - { name: redis_b, weight: 20 }
  clusters:
  - { name: redis_a, type: STATIC }
  - { name: redis_b, type: STATIC }
`)

  test('splits, and the answer says so rather than picking one', () => {
    const result = matchRequest(model, {
      authority: 'x',
      path: '/',
      method: 'GET',
      port: 6379,
      headers: {},
    })
    expect(result.cluster).toBeUndefined()
    expect(result.explanation).toContain('`redis_a` (80) or `redis_b` (20), by weight')
  })
})
