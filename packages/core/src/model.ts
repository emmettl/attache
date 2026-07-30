import type { Cursor } from './cursor.js'
import { cursorOver } from './cursor.js'
// The enum members live beside the suggestions that offer them. Two lists would drift, and
// a menu proposing a value this file then rejects is the tool arguing with itself.
import {
  API_TYPES,
  CLUSTER_TYPES,
  CODEC_TYPES,
  REDIRECT_RESPONSE_CODES,
  SERVER_HEADER_TRANSFORMATIONS,
  TRAFFIC_DIRECTIONS,
  UNDERSCORE_ACTIONS,
} from './suggest.js'
import type { Diagnostic, Unknown } from './diagnostics.js'
import type { ParseResult } from './parse.js'
import type {
  Bootstrap,
  Cluster,
  ConfigModel,
  DynamicResources,
  Endpoint,
  FilterChain,
  FilterChainMatch,
  HeaderMatcher,
  HeaderMatchKind,
  HttpConnectionManager,
  InternalAddressConfig,
  Listener,
  PathSpecifier,
  PerFilterOverride,
  QueryMatcher,
  Route,
  RouteAction,
  RouteConfig,
  RouteForwarding,
  RouteMatch,
  SocketAddress,
  TlsContext,
  UpgradeConfig,
  VirtualHost,
  WeightedCluster,
} from './types.js'

// Document AST → model.
//
// Every function here reads through a `Cursor`, and that is the only way anything gets
// read: a field interpreted without going through `field()` would not be marked as
// understood and would be reported as unrecognised, which makes the honest path also the
// path of least resistance.

export interface ModelResult {
  model: ConfigModel
  diagnostics: Diagnostic[]
  unknowns: Unknown[]
}

/** How Envoy names the HTTP connection manager, now and before the great renaming. */
const HCM_NAMES = new Set([
  'envoy.filters.network.http_connection_manager',
  'envoy.http_connection_manager',
])

const sourced = (c: Cursor) => ({ path: c.path, range: c.range })

// ---- addresses ------------------------------------------------------------------

function socketAddress(c: Cursor): SocketAddress | undefined {
  // `address` wraps a oneof; `socket_address` is the arm that carries a host and port.
  // A `pipe` or `internal_address` listener has no port to match on, so it is left
  // unmodelled rather than flattened into a shape it does not have.
  const sock = c.field('socketAddress')
  if (!sock) return undefined
  return {
    ...sourced(sock),
    address: sock.strAt('address'),
    portValue: sock.numAt('portValue'),
  }
}

// ---- routes ---------------------------------------------------------------------

function pathSpecifier(c: Cursor): PathSpecifier {
  const prefix = c.strAt('prefix')
  if (prefix !== undefined) return { kind: 'prefix', value: prefix }

  const exact = c.strAt('path')
  if (exact !== undefined) return { kind: 'path', value: exact }

  const separated = c.strAt('pathSeparatedPrefix')
  if (separated !== undefined) return { kind: 'pathSeparatedPrefix', value: separated }

  const safeRegex = c.field('safeRegex')
  if (safeRegex) {
    // `google_re2` is an empty marker message that has been a no-op since Envoy made RE2
    // the only engine. Acknowledged rather than merely fetched: the fetch alone left it as
    // an untouched node, which the collector reported as an unrecognised field — so the
    // comment that used to sit here claiming otherwise was, for every config that spelled
    // the marker out, simply wrong.
    safeRegex.field('googleRe2')?.acknowledge()
    const regex = safeRegex.strAt('regex')
    if (regex !== undefined) return { kind: 'safeRegex', value: regex }
  }

  // Recognised, and left at that: neither is evaluated, and the route tester says so when a
  // route carrying one comes up.
  const connect = c.field('connectMatcher')
  if (connect) {
    connect.acknowledge()
    return { kind: 'unmodelled', label: 'connect_matcher' }
  }
  const policy = c.field('pathMatchPolicy')
  if (policy) {
    policy.acknowledge()
    return { kind: 'unmodelled', label: 'path_match_policy' }
  }

  return { kind: 'none' }
}

/**
 * A header matcher, in both spellings.
 *
 * Envoy moved these from a flat oneof (`exact_match`, `prefix_match`, …) to a nested
 * `string_match`, and deprecated but did not remove the flat form. Configs in the wild use
 * both — often in the same file, because the flat form is what every tutorial written
 * before 1.20 shows. Reading only the modern one would silently ignore half the matchers
 * in a real config, and silently ignoring a matcher makes the route tester wrong.
 */
function headerMatcher(c: Cursor): HeaderMatcher {
  const name = c.strAt('name') ?? ''
  const invert = c.field('invertMatch')?.bool() ?? false
  const treatMissingAsEmpty = c.field('treatMissingHeaderAsEmpty')?.bool() ?? false

  let kind: HeaderMatchKind = 'unmodelled'
  let value: string | undefined

  const stringMatch = c.field('stringMatch')
  if (stringMatch) {
    // `ignore_case` is read so it is not flagged; matching below is case-sensitive, which
    // is a limitation the route tester states rather than one it hides.
    stringMatch.field('ignoreCase')
    const arms = [
      ['exact', 'exact'],
      ['prefix', 'prefix'],
      ['suffix', 'suffix'],
      ['contains', 'contains'],
    ] as const
    for (const [field, k] of arms) {
      const found = stringMatch.strAt(field)
      if (found !== undefined) {
        kind = k
        value = found
        break
      }
    }
    if (value === undefined) {
      const safeRegex = stringMatch.field('safeRegex')
      if (safeRegex) {
        safeRegex.field('googleRe2')?.acknowledge()
        const regex = safeRegex.strAt('regex')
        if (regex !== undefined) {
          kind = 'safeRegex'
          value = regex
        }
      }
    }
  }

  if (value === undefined) {
    const legacy = [
      ['exactMatch', 'exact'],
      ['prefixMatch', 'prefix'],
      ['suffixMatch', 'suffix'],
      ['containsMatch', 'contains'],
    ] as const
    for (const [field, k] of legacy) {
      const found = c.strAt(field)
      if (found !== undefined) {
        kind = k
        value = found
        break
      }
    }
  }

  if (value === undefined) {
    const safeRegexMatch = c.field('safeRegexMatch')
    if (safeRegexMatch) {
      safeRegexMatch.field('googleRe2')?.acknowledge()
      const regex = safeRegexMatch.strAt('regex')
      if (regex !== undefined) {
        kind = 'safeRegex'
        value = regex
      }
    }
  }

  // `present_match: true` means "the header exists"; `present_match: false` means "it does
  // not", which Envoy expresses as presence inverted.
  if (value === undefined) {
    const present = c.field('presentMatch')?.bool()
    if (present !== undefined) return { ...sourced(c), name, kind: 'present', invert: invert !== present, treatMissingAsEmpty }
  }

  // A matcher with a name and nothing else is a presence check. A `range_match` is the one
  // arm left: recognised, not evaluated, and reported as such rather than as a field this
  // package has never heard of.
  const rangeMatch = c.field('rangeMatch')
  if (rangeMatch) rangeMatch.acknowledge()
  else if (value === undefined && kind === 'unmodelled') kind = 'present'

  return { ...sourced(c), name, kind, value, invert, treatMissingAsEmpty }
}

function queryMatcher(c: Cursor): QueryMatcher {
  const name = c.strAt('name') ?? ''
  if (c.field('presentMatch')) return { ...sourced(c), name, kind: 'present' }

  const stringMatch = c.field('stringMatch')
  if (stringMatch) {
    stringMatch.field('ignoreCase')
    for (const field of ['exact', 'prefix', 'suffix', 'contains'] as const) {
      const found = stringMatch.strAt(field)
      if (found !== undefined) return { ...sourced(c), name, kind: field, value: found }
    }
    const safeRegex = stringMatch.field('safeRegex')
    if (safeRegex) {
      safeRegex.field('googleRe2')
      const regex = safeRegex.strAt('regex')
      if (regex !== undefined) return { ...sourced(c), name, kind: 'safeRegex', value: regex }
    }
  }

  return { ...sourced(c), name, kind: 'present' }
}

function routeMatch(c: Cursor): RouteMatch {
  return {
    ...sourced(c),
    pathSpec: pathSpecifier(c),
    caseSensitive: c.field('caseSensitive')?.bool() ?? true,
    headers: (c.field('headers')?.items() ?? []).map(headerMatcher),
    queryParameters: (c.field('queryParameters')?.items() ?? []).map(queryMatcher),
  }
}

function routeAction(c: Cursor): RouteAction {
  const route = c.field('route')
  if (route) {
    const cluster = route.strAt('cluster')
    if (cluster !== undefined) return { kind: 'cluster', cluster }

    const header = route.strAt('clusterHeader')
    if (header !== undefined) return { kind: 'clusterHeader', header }

    const weighted = route.field('weightedClusters')
    if (weighted) {
      const clusters: WeightedCluster[] = (weighted.field('clusters')?.items() ?? []).map((w) => ({
        name: w.strAt('name') ?? '',
        weight: w.numAt('weight'),
      }))
      return { kind: 'weightedClusters', clusters }
    }

    return { kind: 'unmodelled', label: 'route' }
  }

  const redirect = c.field('redirect')
  if (redirect) {
    return {
      kind: 'redirect',
      hostRedirect: redirect.strAt('hostRedirect'),
      portRedirect: redirect.numAt('portRedirect'),
      pathRedirect: redirect.strAt('pathRedirect'),
      prefixRewrite: redirect.strAt('prefixRewrite'),
      httpsRedirect: redirect.field('httpsRedirect')?.bool(),
      schemeRedirect: redirect.strAt('schemeRedirect'),
      responseCode: redirect.field('responseCode')?.enumOf(REDIRECT_RESPONSE_CODES),
      stripQuery: redirect.field('stripQuery')?.bool(),
    }
  }

  const direct = c.field('directResponse')
  if (direct) {
    const body = direct.field('body')
    return {
      kind: 'directResponse',
      status: direct.numAt('status'),
      body: body && {
        inline: body.strAt('inlineString'),
        // Not opened, obviously — nothing here can see that machine's filesystem — but
        // worth naming, because "it returns the contents of a file you have not looked at"
        // is a different answer from "it returns nothing".
        filename: body.strAt('filename'),
      },
    }
  }

  return { kind: 'unmodelled', label: 'no action' }
}

/**
 * The parts of a `route` action that are not about choosing an upstream.
 *
 * Fetched through `field('route')` a second time rather than threaded out of
 * `routeAction`: the cursor caches its children, so the second call is the same object and
 * costs a map lookup, and keeping the two readers separate means the action stays a clean
 * discriminated union over what the route DOES rather than a bag with a timeout in it.
 */
function forwarding(c: Cursor): RouteForwarding | undefined {
  const route = c.field('route')
  if (!route) return undefined

  const retry = route.field('retryPolicy')
  return {
    timeout: route.strAt('timeout'),
    idleTimeout: route.strAt('idleTimeout'),
    prefixRewrite: route.strAt('prefixRewrite'),
    hostRewriteLiteral: route.strAt('hostRewriteLiteral'),
    hasRetryPolicy: retry !== undefined,
    retryOn: retry?.strAt('retryOn'),
    numRetries: retry?.numAt('numRetries'),
  }
}

/**
 * Per-route HTTP filter overrides, by filter name.
 *
 * `typed_per_filter_config` is a proto map, so the keys are filter names rather than schema
 * and `field()` has nothing to be handed — hence `fields()`, which exists for this. What is
 * read is deliberately shallow: the `@type` and whether the override switches the filter
 * off. Everything past that is the filter's own configuration, which this package does not
 * evaluate for any filter and should not start evaluating here.
 *
 * The exception is an override that says nothing but `disabled`, which is by far the
 * commonest shape in a real config. There is nothing left in it to withhold judgement
 * about, so it is not acknowledged, and it drops out of the unchecked list entirely rather
 * than padding it.
 */
function perFilterConfig(c: Cursor): PerFilterOverride[] {
  const map = c.field('typedPerFilterConfig')
  if (!map) return []

  return map.fields().map(({ name, cursor }) => {
    const type = cursor.strAt('@type')
    const disabled = cursor.field('disabled')?.bool() ?? false
    if (cursor.hasUnread()) cursor.acknowledge()
    return { name, disabled, type }
  })
}

function route(c: Cursor): Route {
  const match = c.require('match', 'Without it Envoy cannot decide whether this route applies.')
  return {
    ...sourced(c),
    name: c.strAt('name'),
    match: match ? routeMatch(match) : { ...sourced(c), pathSpec: { kind: 'none' }, caseSensitive: true, headers: [], queryParameters: [] },
    action: routeAction(c),
    forwarding: forwarding(c),
    typedPerFilterConfig: perFilterConfig(c),
  }
}

function virtualHost(c: Cursor): VirtualHost {
  const domains = c.require('domains', 'A virtual host with no domains can never be selected.')
  return {
    ...sourced(c),
    name: c.strAt('name'),
    domains: (domains?.items() ?? []).map((d) => d.str()).filter((d): d is string => d !== undefined),
    routes: (c.field('routes')?.items() ?? []).map(route),
  }
}

function routeConfig(c: Cursor): RouteConfig {
  return {
    ...sourced(c),
    name: c.strAt('name'),
    virtualHosts: (c.field('virtualHosts')?.items() ?? []).map(virtualHost),
  }
}

// ---- listeners ------------------------------------------------------------------

/**
 * `internal_address_config`, as a pair of CIDR ranges and a flag.
 *
 * The ranges are flattened to `address/prefix` strings rather than kept as a pair of
 * fields, because that is the notation the person who wrote them was thinking in and the
 * only form anything downstream wants to display.
 */
function internalAddressConfig(c: Cursor): InternalAddressConfig {
  return {
    unixSockets: c.field('unixSockets')?.bool(),
    cidrRanges: (c.field('cidrRanges')?.items() ?? [])
      .map((range) => {
        const address = range.strAt('addressPrefix')
        if (address === undefined) return undefined
        const length = range.numAt('prefixLen')
        return length === undefined ? address : `${address}/${length}`
      })
      .filter((r): r is string => r !== undefined),
  }
}

function httpConnectionManager(c: Cursor): HttpConnectionManager {
  const inline = c.field('routeConfig')
  const rds = c.field('rds')

  // Envoy splits its HTTP settings across three blocks by which protocol they apply to, and
  // the split is not one anybody remembers: `common_http_protocol_options` holds the ones
  // that apply to all of them, `http_protocol_options` is HTTP/1 only despite the name
  // reading like the general case, and `http2_protocol_options` is the other one. They are
  // read here as three, and flattened where the model is read, because a caller asking
  // "what is the idle timeout" should not have to know which box Envoy filed it in.
  const common = c.field('commonHttpProtocolOptions')
  const http1 = c.field('httpProtocolOptions')
  const http2 = c.field('http2ProtocolOptions')
  const internal = c.field('internalAddressConfig')

  return {
    ...sourced(c),
    statPrefix: c.strAt('statPrefix'),
    codecType: c.field('codecType')?.enumOf(CODEC_TYPES),
    routeConfig: inline ? routeConfig(inline) : undefined,
    rdsRouteConfigName: rds?.strAt('routeConfigName'),
    httpFilters: (c.field('httpFilters')?.items() ?? [])
      .map((f) => {
        // The filter's own config is not modelled — this package does not evaluate http
        // filters — but the names are worth having: a routing question is often really a
        // question about which filter short-circuited the request before routing happened.
        f.field('typedConfig')?.unmodelled()
        return f.strAt('name')
      })
      .filter((n): n is string => n !== undefined),
    useRemoteAddress: c.field('useRemoteAddress')?.bool(),
    addUserAgent: c.field('addUserAgent')?.bool(),
    idleTimeout: common?.strAt('idleTimeout'),
    headersWithUnderscoresAction: common
      ?.field('headersWithUnderscoresAction')
      ?.enumOf(UNDERSCORE_ACTIONS),
    streamIdleTimeout: c.strAt('streamIdleTimeout'),
    requestTimeout: c.strAt('requestTimeout'),
    serverHeaderTransformation: c
      .field('serverHeaderTransformation')
      ?.enumOf(SERVER_HEADER_TRANSFORMATIONS),
    http1: http1 && {
      acceptHttp10: http1.field('acceptHttp10')?.bool(),
      defaultHostForHttp10: http1.strAt('defaultHostForHttp10'),
    },
    http2: http2 && {
      maxConcurrentStreams: http2.numAt('maxConcurrentStreams'),
      allowConnect: http2.field('allowConnect')?.bool(),
    },
    internalAddress: internal && internalAddressConfig(internal),
    accessLogNames: (c.field('accessLog')?.items() ?? [])
      .map((log) => {
        // The logger's own config says where the lines go and in what format, and its
        // `filter` decides which requests produce one. Both are real configuration and
        // neither is something this can check, so each is acknowledged rather than picked
        // apart. The name is the useful half: "there is an access log here, and it is the
        // file one" answers most of what anybody asks of it from a config alone.
        log.field('typedConfig')?.acknowledge()
        log.field('filter')?.acknowledge()
        return log.strAt('name')
      })
      .filter((n): n is string => n !== undefined),
    upgrades: (c.field('upgradeConfigs')?.items() ?? [])
      .map((upgrade): UpgradeConfig | undefined => {
        // An upgrade config can carry its own filter chain, run for upgraded streams only.
        upgrade.field('filters')?.acknowledge()
        const type = upgrade.strAt('upgradeType')
        return type === undefined
          ? undefined
          : { type, enabled: upgrade.field('enabled')?.bool() }
      })
      .filter((u): u is UpgradeConfig => u !== undefined),
  }
}

function filterChainMatch(c: Cursor): FilterChainMatch {
  const serverNames = (c.field('serverNames')?.items() ?? [])
    .map((s) => s.str())
    .filter((s): s is string => s !== undefined)
  const destinationPort = c.numAt('destinationPort')
  const transportProtocol = c.strAt('transportProtocol')
  const applicationProtocols = (c.field('applicationProtocols')?.items() ?? [])
    .map((s) => s.str())
    .filter((s): s is string => s !== undefined)

  return {
    ...sourced(c),
    serverNames,
    destinationPort,
    transportProtocol,
    applicationProtocols,
    // Asked after every known field has been read, so "unread" means "not modelled".
    hasUnmodelledCriteria: c.hasUnread(),
  }
}

/**
 * A transport socket, read for its shape rather than its contents.
 *
 * The certificates are counted, never held: a config's key material is the one thing this
 * package should be able to reason about without carrying around. `redact.ts` walks the raw
 * document separately for exactly that reason.
 *
 * `common_tls_context` sits under both the downstream and upstream contexts, so one reader
 * serves a listener's TLS and a cluster's.
 */
function tlsContext(socket: Cursor): TlsContext | undefined {
  const name = socket.strAt('name')
  const typed = socket.field('typedConfig')
  if (!typed) return undefined

  const type = typed.strAt('@type') ?? ''
  if (!type.includes('TlsContext')) {
    // Some other transport socket — raw_buffer, a proxy protocol wrapper, quic. Known to
    // exist, not modelled, and said so.
    typed.unmodelled()
    return undefined
  }

  const common = typed.field('commonTlsContext')
  const certificates = common?.field('tlsCertificates')?.items() ?? []
  for (const certificate of certificates) {
    // Consumed but never read. The fields under here are the private key and the chain, and
    // this package has no business holding either.
    certificate.unmodelled()
  }

  const sds = common?.field('tlsCertificateSdsSecretConfigs')?.items() ?? []

  return {
    ...sourced(typed),
    socketName: name,
    certificateCount: certificates.length,
    sdsSecretNames: sds.map((s) => s.strAt('name')).filter((n): n is string => n !== undefined),
    alpnProtocols: (common?.field('alpnProtocols')?.items() ?? [])
      .map((a) => a.str())
      .filter((a): a is string => a !== undefined),
    requireClientCertificate: typed.field('requireClientCertificate')?.bool() ?? false,
  }
}

function filterChain(c: Cursor): FilterChain {
  const filterNames: string[] = []
  let hcm: HttpConnectionManager | undefined

  for (const filter of c.field('filters')?.items() ?? []) {
    const name = filter.strAt('name')
    if (name !== undefined) filterNames.push(name)

    const typed = filter.field('typedConfig')
    if (!typed) continue

    const type = typed.strAt('@type') ?? ''
    if ((name !== undefined && HCM_NAMES.has(name)) || type.includes('HttpConnectionManager')) {
      hcm = httpConnectionManager(typed)
    } else {
      // Read enough to know it is not an HCM, then stop — one finding naming this filter,
      // rather than one per field of a config nobody asked about.
      typed.unmodelled()
    }
  }

  const match = c.field('filterChainMatch')
  const socket = c.field('transportSocket')

  return {
    ...sourced(c),
    name: c.strAt('name'),
    match: match ? filterChainMatch(match) : undefined,
    hcm,
    filterNames,
    tls: socket ? tlsContext(socket) : undefined,
  }
}

function listener(c: Cursor): Listener {
  const address = c.field('address')
  const fallback = c.field('defaultFilterChain')

  return {
    ...sourced(c),
    name: c.strAt('name'),
    address: address ? socketAddress(address) : undefined,
    trafficDirection: c
      .field('trafficDirection')
      ?.enumOf(TRAFFIC_DIRECTIONS),
    perConnectionBufferLimitBytes: c.numAt('perConnectionBufferLimitBytes'),
    listenerFilterNames: (c.field('listenerFilters')?.items() ?? [])
      .map((f) => {
        // A listener filter sniffs the first bytes of a connection to decide what it is.
        // What it does with them is not modelled; that it is there is the part that changes
        // how the chains below are selected.
        f.field('typedConfig')?.acknowledge()
        return f.strAt('name')
      })
      .filter((n): n is string => n !== undefined),
    filterChains: (c.field('filterChains')?.items() ?? []).map(filterChain),
    defaultFilterChain: fallback ? filterChain(fallback) : undefined,
  }
}

// ---- clusters -------------------------------------------------------------------

function endpointsOf(c: Cursor): Endpoint[] {
  const out: Endpoint[] = []
  // Redundant with the enclosing cluster's own name, and required to equal it. Read so
  // that a field present in every Envoy example does not show up as unrecognised.
  c.field('clusterName')
  for (const locality of c.field('endpoints')?.items() ?? []) {
    for (const lb of locality.field('lbEndpoints')?.items() ?? []) {
      const address = lb.field('endpoint')?.field('address')
      if (!address) continue
      const sock = socketAddress(address)
      if (sock) out.push(sock)
    }
  }
  return out
}

function cluster(c: Cursor): Cluster {
  const type = c.field('type')?.enumOf(CLUSTER_TYPES)
  const eds = c.field('edsClusterConfig')
  const assignment = c.field('loadAssignment')
  const socket = c.field('transportSocket')

  // Presence, not contents. Whether a cluster has health checking at all is worth showing
  // next to it in the graph; whether the interval is sensible is a judgement this package
  // is not in a position to make, so each of these is acknowledged and left alone.
  //
  // `eds_cluster_config` is read for one bit — that this cluster's endpoints come from EDS,
  // which is what makes an empty `endpoints` expected rather than suspicious — and its
  // config source is somebody else's business. It joins the list because a node read for a
  // single fact is still a node nothing has checked.
  //
  // `typed_extension_protocol_options` is here because a real config had one on every
  // cluster: it is where upstream HTTP/2 settings live nowadays, it is entirely ordinary,
  // and having it named as a field Attaché had never heard of was exactly the overstatement
  // this split is for.
  const healthChecks = c.field('healthChecks')
  const circuitBreakers = c.field('circuitBreakers')
  const outlierDetection = c.field('outlierDetection')
  for (const block of [
    healthChecks,
    circuitBreakers,
    outlierDetection,
    eds,
    c.field('typedExtensionProtocolOptions'),
  ]) {
    block?.acknowledge()
  }

  return {
    ...sourced(c),
    name: c.require('name', 'Routes and stats refer to a cluster by name.')?.str(),
    type,
    lbPolicy: c.strAt('lbPolicy'),
    connectTimeout: c.strAt('connectTimeout'),
    endpoints: assignment ? endpointsOf(assignment) : [],
    usesEds: type === 'EDS' || eds !== undefined,
    tls: socket ? tlsContext(socket) : undefined,
    hasHealthChecks: healthChecks !== undefined,
    hasCircuitBreakers: circuitBreakers !== undefined,
    hasOutlierDetection: outlierDetection !== undefined,
  }
}

// ---- assembling -----------------------------------------------------------------

/**
 * Which cluster an `ApiConfigSource` opens its stream to, if it says.
 *
 * Only the gRPC arm is followed. A REST config source is perfectly legal, names an HTTP
 * cluster in a different field, and is rare enough that guessing at it would be modelling
 * on speculation; its fields stay reported instead.
 */
function grpcClusterOf(api: Cursor | undefined): string | undefined {
  if (!api) return undefined
  api.field('apiType')?.enumOf(API_TYPES)
  for (const service of api.field('grpcServices')?.items() ?? []) {
    const name = service.field('envoyGrpc')?.strAt('clusterName')
    if (name !== undefined) return name
  }
  return undefined
}

/**
 * The same question of a `ConfigSource`, which wraps one.
 *
 * The distinction is easy to miss and cost me a pass: `lds_config` and `cds_config` are
 * `ConfigSource`s and carry their `api_config_source` nested, while `ads_config` beside
 * them IS an `ApiConfigSource` already. Reading all three the same way left the ADS block's
 * `grpc_services` reported as a field nobody recognised, on the one config in the fixtures
 * that has one.
 */
function configSourceCluster(source: Cursor | undefined): string | undefined {
  // `ads: {}` is the marker meaning "use the aggregated stream", which is configured once
  // under `ads_config` rather than here. An empty message, acknowledged so it does not
  // arrive as a field nobody recognised.
  source?.field('ads')?.acknowledge()
  return grpcClusterOf(source?.field('apiConfigSource'))
}

function dynamicResources(c: Cursor): DynamicResources {
  const lds = c.field('ldsConfig')
  const cds = c.field('cdsConfig')

  // All three are read before any of them is chosen from, and that is not a style
  // preference. Reading through a cursor is what marks a field as understood, so a `??`
  // chain over these calls stops reading as soon as one of them answers — and on the very
  // config this was written for, where `ads_config` names the cluster, that left
  // `cds_config` beside it reported as a field Attaché had never heard of.
  //
  // With ADS, which is how most meshes are wired, the per-resource sources are bare
  // `ads: {}` markers and only `ads_config` carries a cluster name. With a split stream it
  // is the other way round. So all three are asked and the first answer wins.
  const named = [
    grpcClusterOf(c.field('adsConfig')),
    configSourceCluster(lds),
    configSourceCluster(cds),
  ]

  return {
    ...sourced(c),
    usesLds: lds !== undefined,
    usesCds: cds !== undefined,
    xdsCluster: named.find((name) => name !== undefined),
  }
}

/**
 * The bootstrap's own top level, when the document has one.
 *
 * Returns undefined rather than an object full of undefineds when none of the three blocks
 * is present, so that `model.bootstrap` reads as "this document said something about
 * itself" rather than as a struct that is always there and usually empty.
 */
function bootstrapOf(root: Cursor): Bootstrap | undefined {
  const node = root.field('node')
  const admin = root.field('admin')
  const dynamic = root.field('dynamicResources')
  if (!node && !admin && !dynamic) return undefined

  const adminAddress = admin?.field('address')

  return {
    node: node && { ...sourced(node), id: node.strAt('id'), cluster: node.strAt('cluster') },
    admin: admin && {
      ...sourced(admin),
      address: adminAddress ? socketAddress(adminAddress) : undefined,
    },
    dynamicResources: dynamic && dynamicResources(dynamic),
  }
}

/** A plain bootstrap: listeners and clusters live under `static_resources`. */
function fromBootstrap(root: Cursor): {
  listeners: Cursor[]
  clusters: Cursor[]
  routeConfigs: Cursor[]
  bootstrap?: Bootstrap
} {
  const stat = root.field('staticResources')
  return {
    listeners: stat?.field('listeners')?.items() ?? [],
    clusters: stat?.field('clusters')?.items() ?? [],
    routeConfigs: [],
    bootstrap: bootstrapOf(root),
  }
}

/**
 * A `/config_dump`: the same messages, each in an envelope.
 *
 * The envelopes differ by resource and by whether the resource was static or delivered
 * over xDS — a dynamic listener nests its listener under `active_state`, a static one does
 * not — so each is unwrapped by name rather than by a general rule. Dropping to the
 * innermost message means everything downstream, the graph and the route tester included,
 * cannot tell a dumped config from a hand-written one, which is the point.
 */
function fromConfigDump(root: Cursor): {
  listeners: Cursor[]
  clusters: Cursor[]
  routeConfigs: Cursor[]
  bootstrap?: Bootstrap
} {
  const listeners: Cursor[] = []
  const clusters: Cursor[] = []
  const routeConfigs: Cursor[] = []
  let bootstrap: Bootstrap | undefined

  for (const config of root.field('configs')?.items() ?? []) {
    const type = config.strAt('@type') ?? ''

    if (type.includes('ListenersConfigDump')) {
      for (const entry of config.field('staticListeners')?.items() ?? []) {
        const found = entry.field('listener')
        if (found) listeners.push(found)
      }
      for (const entry of config.field('dynamicListeners')?.items() ?? []) {
        const found = entry.field('activeState')?.field('listener')
        if (found) listeners.push(found)
      }
    } else if (type.includes('ClustersConfigDump')) {
      for (const key of ['staticClusters', 'dynamicActiveClusters'] as const) {
        for (const entry of config.field(key)?.items() ?? []) {
          const found = entry.field('cluster')
          if (found) clusters.push(found)
        }
      }
    } else if (type.includes('RoutesConfigDump')) {
      for (const key of ['staticRouteConfigs', 'dynamicRouteConfigs'] as const) {
        for (const entry of config.field(key)?.items() ?? []) {
          const found = entry.field('routeConfig')
          if (found) routeConfigs.push(found)
        }
      }
    } else if (type.includes('BootstrapConfigDump')) {
      const dumped = config.field('bootstrap')
      if (dumped) {
        const inner = fromBootstrap(dumped)
        listeners.push(...inner.listeners)
        clusters.push(...inner.clusters)
        bootstrap ??= inner.bootstrap
      }
    } else {
      // Scoped routes, secrets, endpoints — envelopes this package has no model for.
      config.unmodelled()
    }
  }

  return { listeners, clusters, routeConfigs, bootstrap }
}

export function buildModel(parsed: ParseResult): ModelResult {
  const diagnostics: Diagnostic[] = []
  const root = cursorOver(parsed.root, parsed.positions, diagnostics, parsed.doc)

  const raw = parsed.format === 'config-dump' ? fromConfigDump(root) : fromBootstrap(root)

  const model: ConfigModel = {
    format: parsed.format,
    listeners: raw.listeners.map(listener),
    clusters: raw.clusters.map(cluster),
    routeConfigs: raw.routeConfigs.map(routeConfig),
    bootstrap: raw.bootstrap,
  }

  return { model, diagnostics, unknowns: root.collectUnknowns() }
}
