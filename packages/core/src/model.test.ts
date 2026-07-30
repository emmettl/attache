import { describe, expect, test } from 'vitest'
import { CAMEL_CASE, CONFIG_DUMP, FRONT_PROXY, PRODUCTION } from './fixtures.js'
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
    expect(unknowns).toContainEqual(
      expect.objectContaining({ key: 'invented_field', kind: 'unrecognised' }),
    )
  })

  test('a field the model does know about is not reported', () => {
    const { unknowns } = analyse(FRONT_PROXY)
    const keys = unknowns.map((u) => u.key)
    expect(keys).not.toContain('route_config')
    expect(keys).not.toContain('port_value')
    expect(keys).not.toContain('virtual_hosts')
  })

  test('a field read and deliberately not judged is not called unrecognised', () => {
    const { unknowns } = analyse(`
static_resources:
  clusters:
  - name: api_service
    type: STATIC
    health_checks:
    - timeout: 1s
      interval: 5s
      http_health_check: { path: /healthz }
    circuit_breakers:
      thresholds:
      - max_connections: 100
`)
    // Both are ordinary production configuration that Attaché reads for its presence. Being
    // told they are fields it has never heard of is the overstatement the split is for.
    expect(unknowns.map((u) => [u.key, u.kind])).toEqual([
      ['health_checks', 'unvalidated'],
      ['circuit_breakers', 'unvalidated'],
    ])
  })

  test('an empty marker message is not counted as a field at all', () => {
    const { unknowns } = analyse(`
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress
          route_config:
            name: local
            virtual_hosts:
            - name: vh
              domains: ["*"]
              routes:
              - match:
                  safe_regex:
                    google_re2: {}
                    regex: "/v[0-9]+/.*"
                direct_response: { status: 200 }
`)
    // `google_re2` has no fields and never had any behaviour. Counting it would pad the one
    // number this tool asks to be taken seriously.
    expect(unknowns.map((u) => u.key)).not.toContain('google_re2')
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
    // Attaché read as far as the `@type`, recognised a filter it has no model for, and
    // stopped. That is a limit of its remit, not a gap in its schema.
    expect(inside[0]!.kind).toBe('unvalidated')
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
a_block_nobody_has_heard_of:
- name: envoy.stat_sinks.statsd
`)
    expect(summary).toMatch(/1 field unrecognised/)
  })

  // `stats_sinks` was what this test used to be written against, on the assumption that a
  // bootstrap block outside the routing spine had to be unrecognised. It is not: it is
  // documented Envoy, it is on most real deployments, and calling it unrecognised put it in
  // the list that is supposed to read as "one of these might be your typo".
  test('an ordinary bootstrap block is read, not called unrecognised', () => {
    const { summary, unknowns } = analyse(`
static_resources:
  listeners: []
  clusters: []
stats_sinks:
- name: envoy.stat_sinks.statsd
layered_runtime:
  layers:
  - name: static_layer
    static_layer: { envoy.reloadable_features.something: true }
overload_manager:
  refresh_interval: 0.25s
`)
    expect(unknowns.map((u) => [u.key, u.kind])).toEqual([
      ['layered_runtime', 'unvalidated'],
      ['stats_sinks', 'unvalidated'],
      ['overload_manager', 'unvalidated'],
    ])
    expect(summary).toContain('3 fields read but not checked')
    expect(summary).not.toMatch(/unrecognised/)
  })

  test('the summary keeps the two kinds apart', () => {
    const { summary } = analyse(`
static_resources:
  clusters:
  - name: api_service
    type: STATIC
    health_checks:
    - timeout: 1s
    tracing_config_i_invented:
      enabled: true
`)
    expect(summary).toMatch(/1 field unrecognised · 1 read but not checked/)
    // Still no success state anywhere in it, however the counts fall.
    expect(summary).not.toMatch(/valid|✓|ok\b/i)
  })
})

describe('a config that has been in production', () => {
  const { model, unknowns, summary } = analyse(PRODUCTION)
  const listener = model.listeners[0]!
  const hcm = listener.filterChains[0]!.hcm!
  const routes = hcm.routeConfig!.virtualHosts[0]!.routes

  test('reads the listener beyond its address', () => {
    expect(listener.trafficDirection).toBe('INBOUND')
    expect(listener.perConnectionBufferLimitBytes).toBe(32768)
    expect(listener.listenerFilterNames).toEqual(['envoy.filters.listener.tls_inspector'])
  })

  test('reads how the connection manager treats HTTP', () => {
    expect(hcm.codecType).toBe('AUTO')
    expect(hcm.useRemoteAddress).toBe(false)
    expect(hcm.addUserAgent).toBe(true)
    expect(hcm.serverHeaderTransformation).toBe('PASS_THROUGH')
    expect(hcm.streamIdleTimeout).toBe('300s')
    // `0s` is a request timeout switched off, which is why these stay as text: a parsed
    // number could not tell it apart from a field nobody wrote.
    expect(hcm.requestTimeout).toBe('0s')
    expect(hcm.idleTimeout).toBe('3600s')
    expect(hcm.headersWithUnderscoresAction).toBe('REJECT_REQUEST')
  })

  test('keeps the three protocol option blocks apart', () => {
    expect(hcm.http1).toEqual({ acceptHttp10: true, defaultHostForHttp10: 'legacy.internal' })
    expect(hcm.http2).toEqual({
      maxConcurrentStreams: 100,
      allowConnect: true,
      initialStreamWindowSize: 65536,
      initialConnectionWindowSize: 1048576,
    })
    expect(hcm.internalAddress).toEqual({ unixSockets: true, cidrRanges: ['10.0.0.0/8'] })
  })

  test('names the access loggers and the upgrades without reading their innards', () => {
    expect(hcm.accessLogNames).toEqual(['envoy.access_loggers.file'])
    expect(hcm.upgrades).toEqual([
      { type: 'websocket', enabled: undefined },
      { type: 'CONNECT', enabled: false },
    ])
  })

  test('says where a redirect goes, not merely that it is one', () => {
    expect(routes[1]!.action).toEqual({
      kind: 'redirect',
      hostRedirect: 'api.example.com',
      portRedirect: undefined,
      pathRedirect: undefined,
      prefixRewrite: '/v2',
      httpsRedirect: true,
      schemeRedirect: undefined,
      responseCode: 'TEMPORARY_REDIRECT',
      stripQuery: undefined,
    })
  })

  test('reads what a proxying route does on the way upstream', () => {
    expect(routes[3]!.forwarding).toMatchObject({
      timeout: '15s',
      idleTimeout: undefined,
      prefixRewrite: '/',
      regexRewrite: undefined,
      hostRewriteLiteral: 'api.internal',
      hostRewriteHeader: undefined,
      autoHostRewrite: undefined,
      appendXForwardedHost: true,
      hasRetryPolicy: true,
      retryOn: '5xx,reset',
      numRetries: 3,
    })
    // A route that does not proxy never gets that far, so there is nothing to report.
    expect(routes[0]!.forwarding).toBeUndefined()
  })

  test('reads the clusters a route mirrors to, which nothing routes to', () => {
    // The shape that produced two wrong answers at once before this was read: the shadow
    // cluster was reported as one nothing reaches, and a mirror naming a cluster that did
    // not exist was not reported at all.
    expect(routes[3]!.forwarding?.mirrorClusters).toMatchObject([
      { cluster: 'api_shadow', by: 'request_mirror_policies' },
    ])
    expect(model.clusters.map((c) => c.name)).toContain('api_shadow')
  })

  test('reads a virtual host beyond its domains', () => {
    const host = hcm.routeConfig!.virtualHosts[0]!
    expect(host.requireTls).toBe('EXTERNAL_ONLY')
    expect(host.includeRequestAttemptCount).toBe(true)
    expect(host.perRequestBufferLimitBytes).toBe(32768)
  })

  test('reads what the connection manager does to a request before it routes', () => {
    expect(hcm.mergeSlashes).toBe(true)
    expect(hcm.normalizePath).toBe(true)
    expect(hcm.stripMatchingHostPort).toBe(true)
    expect(hcm.pathWithEscapedSlashesAction).toBe('UNESCAPE_AND_REDIRECT')
    expect(hcm.xffNumTrustedHops).toBe(1)
    expect(hcm.maxConnectionDuration).toBe('600s')
    expect(hcm.maxHeadersCount).toBe(100)
  })

  test('reads the route config settings that decide how a host is matched', () => {
    expect(hcm.routeConfig!.ignorePortInHostMatching).toBe(true)
    expect(hcm.routeConfig!.validateClusters).toBe(false)
  })

  test('reads the listener beyond the one address it binds', () => {
    expect(listener.additionalAddresses.map((a) => a.portValue)).toEqual([15007])
    expect(listener.statPrefix).toBe('inbound')
    expect(listener.listenerFiltersTimeout).toBe('5s')
    expect(listener.tcpBacklogSize).toBe(1024)
    expect(listener.accessLogNames).toEqual(['envoy.access_loggers.file'])
  })

  test('reads an endpoint with the locality and health it was declared under', () => {
    const shadow = model.clusters.find((c) => c.name === 'api_shadow')!
    expect(shadow.endpoints).toMatchObject([
      {
        address: '10.0.2.9',
        portValue: 8080,
        hostname: 'shadow-1.internal',
        healthStatus: 'HEALTHY',
        loadBalancingWeight: 1,
        locality: 'us-east-1/us-east-1a',
        priority: 0,
      },
    ])
    expect(shadow.dnsLookupFamily).toBeUndefined()
    expect(model.clusters[0]!.dnsLookupFamily).toBe('V4_ONLY')
  })

  test('reads a direct response body', () => {
    expect(routes[0]!.action).toMatchObject({
      kind: 'directResponse',
      status: 200,
      body: { inline: 'OK' },
    })
  })

  test('records which filters a route switches off', () => {
    expect(routes[0]!.typedPerFilterConfig).toEqual([
      {
        name: 'envoy.filters.http.ext_authz',
        disabled: true,
        type: 'type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute',
      },
    ])
    expect(routes[3]!.typedPerFilterConfig).toEqual([])
  })

  test('reads the bootstrap top level', () => {
    expect(model.bootstrap?.node).toMatchObject({ id: 'sidecar~10.0.1.7~api-7f9c', cluster: 'api' })
    expect(model.bootstrap?.admin?.address).toMatchObject({
      address: '127.0.0.1',
      portValue: 15000,
    })
    expect(model.bootstrap?.dynamicResources).toMatchObject({
      usesLds: false,
      usesCds: true,
      // Named on `ads_config`, which is an ApiConfigSource, while `cds_config` beside it is
      // a ConfigSource wrapping one. Reading both the same way misses this.
      xdsCluster: 'xds_cluster',
    })
  })

  test('says where a redirect rewrites its path by regex, without applying it', () => {
    expect(routes[2]!.action).toMatchObject({
      kind: 'redirect',
      regexRewrite: { pattern: '^/docs/(.*)$', substitution: '/documentation/\\1' },
    })
  })

  test('reads the chain match criteria it will not evaluate, rather than skipping them', () => {
    const match = listener.filterChains[0]!.match!
    // Named, not merely counted. The distinction this asserts is the whole point: these are
    // fields Attaché recognises and declines to answer, not fields it has never seen.
    expect(match.unevaluatedCriteria).toEqual(['source_prefix_ranges', 'source_type'])
    expect(match.hasUnmodelledCriteria).toBe(false)
  })

  test('has nothing left it cannot name', () => {
    expect(unknowns.filter((u) => u.kind === 'unrecognised')).toEqual([])
    // What remains is every place it stopped on purpose. Each of these was, at some point,
    // reported as a field Attaché had never heard of, on a config where all of it is
    // ordinary: a sidecar's source-range chain match, the TLS parameters on both ends of it,
    // the CORS and hash policy on a route, and the admin interface's own access log.
    expect(unknowns.map((u) => u.key)).toEqual([
      // Bootstrap blocks about how the process behaves rather than where a request goes.
      'layered_runtime',
      'stats_sinks',
      'overload_manager',
      // The listener: a socket option, and the access logger it keeps for itself.
      'socket_options',
      'typed_config',
      'typed_config',
      // Header mutations, at all four levels that can carry them.
      'request_headers_to_add',
      'response_headers_to_remove',
      'request_headers_to_add',
      'retry_policy',
      'rate_limits',
      'response_headers_to_remove',
      'decorator',
      // Route match criteria this tester reads and will not answer for. The route carrying
      // them says so in the verdict rather than in silence.
      'runtime_fraction',
      'cors',
      'hash_policy',
      'upgrade_configs',
      'max_stream_duration',
      // The mirror policy's own sampling. The cluster it names IS read — that is the point.
      'runtime_fraction',
      // The filters, whose configuration is nobody's business here.
      'typed_config',
      'typed_config',
      'typed_config',
      'local_reply_config',
      'set_current_client_cert_details',
      // The chain match criteria that are about an address rather than a request.
      'source_prefix_ranges',
      'source_type',
      // TLS on both ends, and the EDS config source.
      'tls_params',
      'eds_cluster_config',
      'tls_params',
      'validation_context_sds_secret_config',
      // The cluster's health, resilience and load balancing settings.
      'health_checks',
      'circuit_breakers',
      'outlier_detection',
      'typed_extension_protocol_options',
      'common_lb_config',
      'upstream_connection_options',
      'policy',
      'metadata',
      'health_check_config',
      // The node's own identity beyond the two names that identify it.
      'metadata',
      'locality',
      // The admin interface's access log.
      'access_log',
    ])
    expect(summary).toContain('42 fields read but not checked')
    expect(summary).not.toMatch(/valid|✓/i)
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
