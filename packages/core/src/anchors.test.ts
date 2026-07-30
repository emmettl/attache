import { describe, expect, test } from 'vitest'
import { analyse } from './index.js'
import { formatPath } from './source.js'

// Anchors, aliases and merge keys.
//
// These have their own file because they are not one feature, they are a property every
// other reader has to hold: anything walking the document tree has to follow `*alias` or it
// will report the config as missing whatever was shared. A real config found this — a
// listener whose `filter_chains` was an alias got reported as having none, which turned a
// new check into a false accusation on exactly the kind of config most worth checking.
//
// None of the hand-written fixtures used anchors, which is why nothing caught it. Real
// configs use them constantly, because repeating a filter chain per listener is how you get
// them out of step.

const SHARED_CHAINS = `
static_resources:
  listeners:
  - name: http_listener
    address: { socket_address: { address: 0.0.0.0, port_value: 80 } }
    filter_chains: &shared
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: backend } }]
          http_filters:
          - name: envoy.filters.http.router
  - name: https_listener
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains: *shared
  clusters:
  - name: backend
`

describe('a filter chain shared by alias', () => {
  const { model, diagnostics } = analyse(SHARED_CHAINS)

  test('both listeners have it', () => {
    expect(model.listeners.map((l) => `${l.name}:${l.filterChains.length}`)).toEqual([
      'http_listener:1',
      'https_listener:1',
    ])
  })

  test('so neither is accused of having none', () => {
    expect(diagnostics.map((d) => d.code)).not.toContain('no-filter-chains')
  })

  test('and what it points at is really there, not just counted', () => {
    const hcm = model.listeners[1]!.filterChains[0]!.hcm
    expect(hcm?.statPrefix).toBe('ingress')
    expect(hcm?.routeConfig?.virtualHosts[0]!.routes[0]!.action).toEqual({
      kind: 'cluster',
      cluster: 'backend',
    })
  })

  test('a diagnostic points at the alias, not at the anchor', () => {
    // The user wrote `*shared` on the https listener. Sending them to the anchor's
    // definition inside a different listener would be sending them somewhere they did not
    // touch and cannot fix from.
    const { diagnostics: found } = analyse(SHARED_CHAINS.replace('cluster: backend', 'cluster: gone'))
    const dangling = found.find((d) => d.code === 'cluster-not-found')!
    expect(formatPath(dangling.path)).toContain('listeners[0]')
  })
})

describe('a merge key', () => {
  const { model, unknowns } = analyse(`
cluster_defaults: &defaults
  connect_timeout: 5s
  type: STRICT_DNS
  lb_policy: ROUND_ROBIN
static_resources:
  listeners: []
  clusters:
  - name: inherits
    <<: *defaults
  - name: overrides
    <<: *defaults
    type: EDS
`)

  test('brings the merged fields in', () => {
    const inherits = model.clusters.find((c) => c.name === 'inherits')!
    expect(inherits.type).toBe('STRICT_DNS')
    expect(inherits.connectTimeout).toBe('5s')
    expect(inherits.lbPolicy).toBe('ROUND_ROBIN')
  })

  test('but an explicit key still wins', () => {
    const overrides = model.clusters.find((c) => c.name === 'overrides')!
    expect(overrides.type).toBe('EDS')
    // The rest still arrives from the merge.
    expect(overrides.connectTimeout).toBe('5s')
  })

  test('and `<<` itself is not reported as an unrecognised field', () => {
    expect(unknowns.map((u) => u.key)).not.toContain('<<')
  })
})

describe('merging several anchors at once', () => {
  test('earlier targets win over later ones, as YAML says', () => {
    const { model } = analyse(`
a: &a { type: STRICT_DNS }
b: &b { type: EDS, lb_policy: RANDOM }
static_resources:
  listeners: []
  clusters:
  - name: c
    <<: [*a, *b]
`)
    const cluster = model.clusters[0]!
    expect(cluster.type).toBe('STRICT_DNS')
    expect(cluster.lbPolicy).toBe('RANDOM')
  })
})

describe('anchors that misbehave', () => {
  test('an alias to nothing does not take the parse down', () => {
    const { model, diagnostics } = analyse(`
static_resources:
  listeners: []
  clusters:
  - name: fine
  - name: broken
    <<: *never_defined
`)
    // `yaml` reports the undefined alias itself; the point is that we still get a model.
    expect(model.clusters.map((c) => c.name)).toContain('fine')
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  test('a nested alias chain resolves through', () => {
    const { model } = analyse(`
inner: &inner { type: STRICT_DNS }
outer: &outer
  <<: *inner
static_resources:
  listeners: []
  clusters:
  - name: c
    <<: *outer
`)
    expect(model.clusters[0]!.type).toBe('STRICT_DNS')
  })
})

describe('a repeated field written as a single block', () => {
  // Envoy's repeated fields are YAML lists, and the commonest way to get one wrong is to
  // leave the `- ` off the first entry. Found on a real config, where the old message —
  // "this listener has no filter chains" — sent somebody looking for a missing block that
  // was sitting right there with a hyphen missing.
  const MISSING_DASH = `
static_resources:
  listeners:
  - name: https_listener
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
      transport_socket: { name: envoy.transport_sockets.tls }
      filters: []
  clusters: []
`

  const { diagnostics, unknowns } = analyse(MISSING_DASH)

  test('is reported as the shape problem it is', () => {
    const found = diagnostics.find((d) => d.code === 'expected-list')!
    expect(found.severity).toBe('error')
    expect(formatPath(found.path)).toBe('static_resources.listeners[0].filter_chains')
    expect(found.detail).toContain('missing `- `')
    // Names what it found, so you can see it is your block rather than a missing one.
    expect(found.detail).toContain('transport_socket')
  })

  test('and the misplaced fields are not also called unrecognised', () => {
    // They are misplaced, not unknown, and the finding above already says so.
    expect(unknowns.map((u) => formatPath(u.path))).toEqual([])
  })

  test('and the consequence of it is suppressed', () => {
    // "This listener has no filter chains" is true, derivative and misleading. Reporting a
    // cause and its symptom as peers is how a tool teaches people to skim past findings.
    expect(diagnostics.map((d) => d.code)).not.toContain('no-filter-chains')
    expect(diagnostics).toHaveLength(1)
  })

  test('the same mistake inside a TLS context reads the same way', () => {
    const found = analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificates:
              certificate_chain: { filename: /c.pem }
              private_key: { filename: /k.pem }
      filters: []
  clusters: []
`).diagnostics
    expect(found.map((d) => d.code)).toContain('expected-list')
    expect(found.map((d) => d.code)).not.toContain('tls-without-certificate')
  })

  test('a properly written list is untouched', () => {
    expect(
      analyse(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - filters: []
  clusters: []
`).diagnostics.map((d) => d.code),
    ).not.toContain('expected-list')
  })
})
