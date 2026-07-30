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
