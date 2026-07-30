import { describe, expect, test } from 'vitest'
import { CAMEL_CASE, CONFIG_DUMP, FRONT_PROXY } from './fixtures.js'
import { analyse } from './index.js'
import { formatPath } from './source.js'

describe('modelling a bootstrap', () => {
  const { model, format } = analyse(FRONT_PROXY)

  test('recognises it as a bootstrap', () => {
    expect(format).toBe('bootstrap')
  })

  test('finds the listener and its address', () => {
    expect(model.listeners).toHaveLength(1)
    expect(model.listeners[0]!.name).toBe('listener_0')
    expect(model.listeners[0]!.address).toMatchObject({ address: '0.0.0.0', portValue: 10000 })
  })

  test('finds the HTTP connection manager inside the filter chain', () => {
    const hcm = model.listeners[0]!.filterChains[0]!.hcm
    expect(hcm?.statPrefix).toBe('ingress_http')
    expect(hcm?.httpFilters).toEqual(['envoy.filters.http.router'])
  })

  test('finds the routes, in the order they were written', () => {
    const routes = model.listeners[0]!.filterChains[0]!.hcm!.routeConfig!.virtualHosts[0]!.routes
    expect(routes.map((r) => r.match.pathSpec)).toEqual([
      { kind: 'prefix', value: '/api' },
      { kind: 'prefix', value: '/' },
    ])
    expect(routes.map((r) => r.action)).toEqual([
      { kind: 'cluster', cluster: 'api_service' },
      { kind: 'cluster', cluster: 'web_service' },
    ])
  })

  test('finds the clusters and their endpoints', () => {
    expect(model.clusters.map((c) => c.name)).toEqual(['api_service', 'web_service'])
    expect(model.clusters[0]!.endpoints).toEqual([
      expect.objectContaining({ address: 'api', portValue: 8080 }),
    ])
  })

  test('every modelled thing knows where it came from', () => {
    const route = model.listeners[0]!.filterChains[0]!.hcm!.routeConfig!.virtualHosts[0]!.routes[0]!
    expect(formatPath(route.path)).toBe(
      'static_resources.listeners[0].filter_chains[0].filters[0].typed_config.route_config.virtual_hosts[0].routes[0]',
    )
    // The fixture opens with a newline, so the first route sits well down the file.
    expect(route.range.line).toBeGreaterThan(15)
  })
})

test('camelCase and snake_case are the same config', () => {
  const camel = analyse(CAMEL_CASE).model
  expect(camel.listeners[0]!.address).toMatchObject({ portValue: 10000 })
  expect(camel.listeners[0]!.filterChains[0]!.hcm?.statPrefix).toBe('ingress_http')
  expect(
    camel.listeners[0]!.filterChains[0]!.hcm!.routeConfig!.virtualHosts[0]!.routes[0]!.action,
  ).toEqual({ kind: 'cluster', cluster: 'api_service' })
})

describe('unrecognised fields', () => {
  test('a field outside the model is reported, not dropped', () => {
    const { unknowns } = analyse(`
static_resources:
  listeners:
  - name: listener_0
    invented_field: 42
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
`)
    const keys = unknowns.map((u) => u.key)
    expect(keys).toContain('invented_field')
  })

  test('a field the model does know about is not reported', () => {
    const { unknowns } = analyse(FRONT_PROXY)
    const keys = unknowns.map((u) => u.key)
    expect(keys).not.toContain('route_config')
    expect(keys).not.toContain('port_value')
    expect(keys).not.toContain('virtual_hosts')
  })

  test('an unmodelled filter is one finding, not one per field inside it', () => {
    const { unknowns } = analyse(`
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.tcp_proxy
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy
          stat_prefix: tcp
          cluster: some_cluster
          idle_timeout: 5s
          access_log: [{ name: one }, { name: two }]
`)
    const inside = unknowns.filter((u) => formatPath(u.path).includes('typed_config'))
    expect(inside).toHaveLength(1)
    expect(inside[0]!.key).toBe('typed_config')
  })

  test('the summary never claims the config is valid', () => {
    const clean = analyse(`
static_resources:
  listeners: []
  clusters: []
`)
    expect(clean.summary).not.toMatch(/valid|✓|ok\b/i)
    expect(clean.summary).toContain('nothing wrong in what I checked')
  })

  test('the summary counts what was not checked', () => {
    const { summary } = analyse(`
static_resources:
  listeners: []
  clusters: []
admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 9901 }
`)
    expect(summary).toMatch(/1 field not checked/)
  })
})

describe('a /config_dump', () => {
  const { model, format } = analyse(CONFIG_DUMP)

  test('is recognised by its envelopes', () => {
    expect(format).toBe('config-dump')
  })

  test('is unwrapped into the same shape as a bootstrap', () => {
    expect(model.listeners.map((l) => l.name)).toEqual(['listener_0'])
    expect(model.clusters.map((c) => c.name)).toEqual(['api_service'])
    expect(model.clusters[0]!.usesEds).toBe(true)
    expect(model.routeConfigs.map((r) => r.name)).toEqual(['local_route'])
  })

  test('keeps the RDS reference that ties them together', () => {
    expect(model.listeners[0]!.filterChains[0]!.hcm?.rdsRouteConfigName).toBe('local_route')
  })
})

describe('recovering from bad input', () => {
  test('a syntax error still yields whatever parsed', () => {
    const { diagnostics, model } = analyse(`
static_resources:
  clusters:
  - name: fine
  broken: [1, 2
`)
    expect(diagnostics.some((d) => d.code === 'yaml-error')).toBe(true)
    expect(model.clusters.map((c) => c.name)).toContain('fine')
  })

  test('a document that is not a map says so once', () => {
    const { diagnostics } = analyse('just a string')
    expect(diagnostics.filter((d) => d.code === 'not-a-map')).toHaveLength(1)
  })

  test('an empty document is not an error', () => {
    expect(analyse('').diagnostics).toEqual([])
  })
})
