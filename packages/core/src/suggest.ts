import type { ConfigModel } from './types.js'
import { toCamel } from './source.js'

// What a value can be, offered as a list.
//
// VALUES ONLY. Never field names, and that is the whole design constraint rather than a
// scoping decision that could be revisited when there is time.
//
// The unknown list this package is built around is DESCRIPTIVE: it says "I did not check
// this", and it is honest precisely because it makes no claim about what else exists. A
// completion menu is PRESCRIPTIVE. Offer field names from a model that knows sixty of
// Envoy's thousands and the menu is read as the set of fields there ARE — so the tool would
// spend its time teaching people its own subset, which is the exact inversion of the
// property the unknown list exists to guarantee. Somebody would learn Attaché instead of
// Envoy, and would not find out until production.
//
// Values are the opposite case. A cluster name is not a fact about Envoy's schema, it is a
// fact about the config in front of us: the names are RIGHT THERE under `clusters`, and
// offering them turns `cluster-not-found` from a finding into something you cannot type
// wrong in the first place. The enums are the same shape of claim — they come from the very
// `enumOf()` calls that would report a wrong one, so a suggestion here and a diagnostic
// there cannot disagree.
//
// Field-name completion is gated on the same `FileDescriptorSet` work as full validation.
// When the model is the proto descriptors rather than a curated subset, the menu will be
// describing Envoy rather than describing us, and the objection above stops applying.

export interface Suggestion {
  value: string
  /** A short gloss, shown beside the value. Absent where the value speaks for itself. */
  detail?: string
}

// ---- enums ------------------------------------------------------------------------
//
// Exported so `model.ts` validates against these exact arrays. Two lists would drift, and
// they would drift in the worst available direction: a menu offering a value the checker
// then flags is a tool arguing with itself in front of the person using it.

export const CLUSTER_TYPES = ['STATIC', 'STRICT_DNS', 'LOGICAL_DNS', 'EDS', 'ORIGINAL_DST'] as const
export const CODEC_TYPES = ['AUTO', 'HTTP1', 'HTTP2', 'HTTP3'] as const
export const TRAFFIC_DIRECTIONS = ['UNSPECIFIED', 'INBOUND', 'OUTBOUND'] as const
export const UNDERSCORE_ACTIONS = ['ALLOW', 'REJECT_REQUEST', 'DROP_HEADER'] as const
export const SERVER_HEADER_TRANSFORMATIONS = ['OVERWRITE', 'APPEND_IF_ABSENT', 'PASS_THROUGH'] as const
export const REDIRECT_RESPONSE_CODES = [
  'MOVED_PERMANENTLY',
  'FOUND',
  'SEE_OTHER',
  'TEMPORARY_REDIRECT',
  'PERMANENT_REDIRECT',
] as const
export const API_TYPES = [
  'DEPRECATED_AND_UNAVAILABLE_DO_NOT_USE',
  'REST',
  'GRPC',
  'DELTA_GRPC',
  'AGGREGATED_GRPC',
  'AGGREGATED_DELTA_GRPC',
] as const

/**
 * What each enum value means, where the name does not already say it.
 *
 * Only the ones that are genuinely opaque. Glossing `INBOUND` would be noise, and a menu
 * where every row carries a line of prose is a menu you read instead of scan.
 */
const ENUM_DETAIL: Record<string, string> = {
  STRICT_DNS: 'Re-resolves DNS, uses every address returned',
  LOGICAL_DNS: 'Re-resolves DNS, keeps one connection to the first address',
  EDS: 'Endpoints arrive over xDS',
  ORIGINAL_DST: 'Forwards to the address the connection was originally for',
  AUTO: 'Sniffs HTTP/1 or HTTP/2 per connection',
  REJECT_REQUEST: 'Envoy answers 400 rather than forwarding',
  DROP_HEADER: 'Silently removed before the upstream sees it',
  MOVED_PERMANENTLY: '301',
  FOUND: '302',
  SEE_OTHER: '303',
  TEMPORARY_REDIRECT: '307 — keeps the method and body',
  PERMANENT_REDIRECT: '308 — keeps the method and body',
  APPEND_IF_ABSENT: 'Only sets `server` when the upstream did not',
  PASS_THROUGH: "Leaves the upstream's `server` header alone",
}

// ---- extension names --------------------------------------------------------------
//
// Curated, and shorter than Envoy's full set on purpose: these are the ones that turn up in
// configs people actually write. The list being incomplete is not the failure mode it would
// be for field names, because nothing here implies it is exhaustive — a name you know and
// this does not is a name you type, and it is accepted exactly as before.

interface Extension {
  name: string
  type: string
  detail: string
}

const HTTP_FILTERS: Extension[] = [
  { name: 'envoy.filters.http.router', type: 'type.googleapis.com/envoy.extensions.filters.http.router.v3.Router', detail: 'Does the forwarding. Must be last.' },
  { name: 'envoy.filters.http.cors', type: 'type.googleapis.com/envoy.extensions.filters.http.cors.v3.Cors', detail: 'Cross-origin request handling' },
  { name: 'envoy.filters.http.ext_authz', type: 'type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz', detail: 'Calls an external authorization service' },
  { name: 'envoy.filters.http.jwt_authn', type: 'type.googleapis.com/envoy.extensions.filters.http.jwt_authn.v3.JwtAuthentication', detail: 'Verifies JWTs' },
  { name: 'envoy.filters.http.ratelimit', type: 'type.googleapis.com/envoy.extensions.filters.http.ratelimit.v3.RateLimit', detail: 'Global rate limiting, via a service' },
  { name: 'envoy.filters.http.local_ratelimit', type: 'type.googleapis.com/envoy.extensions.filters.http.local_ratelimit.v3.LocalRateLimit', detail: 'Rate limiting inside this Envoy' },
  { name: 'envoy.filters.http.rbac', type: 'type.googleapis.com/envoy.extensions.filters.http.rbac.v3.RBAC', detail: 'Allow and deny rules' },
  { name: 'envoy.filters.http.lua', type: 'type.googleapis.com/envoy.extensions.filters.http.lua.v3.Lua', detail: 'Inline Lua' },
  { name: 'envoy.filters.http.fault', type: 'type.googleapis.com/envoy.extensions.filters.http.fault.v3.HTTPFault', detail: 'Injected delays and aborts' },
  { name: 'envoy.filters.http.buffer', type: 'type.googleapis.com/envoy.extensions.filters.http.buffer.v3.Buffer', detail: 'Buffers the whole request before forwarding' },
  { name: 'envoy.filters.http.compressor', type: 'type.googleapis.com/envoy.extensions.filters.http.compressor.v3.Compressor', detail: 'Compresses responses' },
  { name: 'envoy.filters.http.grpc_web', type: 'type.googleapis.com/envoy.extensions.filters.http.grpc_web.v3.GrpcWeb', detail: 'Bridges grpc-web to gRPC' },
  { name: 'envoy.filters.http.health_check', type: 'type.googleapis.com/envoy.extensions.filters.http.health_check.v3.HealthCheck', detail: 'Answers health checks without going upstream' },
]

const NETWORK_FILTERS: Extension[] = [
  { name: 'envoy.filters.network.http_connection_manager', type: 'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager', detail: 'Speaks HTTP and routes it' },
  { name: 'envoy.filters.network.tcp_proxy', type: 'type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy', detail: 'Forwards bytes to one cluster' },
  { name: 'envoy.filters.network.rbac', type: 'type.googleapis.com/envoy.extensions.filters.network.rbac.v3.RBAC', detail: 'Allow and deny rules, per connection' },
  { name: 'envoy.filters.network.echo', type: 'type.googleapis.com/envoy.extensions.filters.network.echo.v3.Echo', detail: 'Writes back whatever it is sent' },
]

const LISTENER_FILTERS: Extension[] = [
  { name: 'envoy.filters.listener.tls_inspector', type: 'type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector', detail: 'Reads SNI and ALPN — what makes server_names matching work' },
  { name: 'envoy.filters.listener.http_inspector', type: 'type.googleapis.com/envoy.extensions.filters.listener.http_inspector.v3.HttpInspector', detail: 'Detects the HTTP version' },
  { name: 'envoy.filters.listener.original_dst', type: 'type.googleapis.com/envoy.extensions.filters.listener.original_dst.v3.OriginalDst', detail: 'Recovers the pre-redirect destination' },
  { name: 'envoy.filters.listener.proxy_protocol', type: 'type.googleapis.com/envoy.extensions.filters.listener.proxy_protocol.v3.ProxyProtocol', detail: 'Reads the PROXY protocol header' },
]

const ACCESS_LOGGERS: Extension[] = [
  { name: 'envoy.access_loggers.file', type: 'type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog', detail: 'A file, or /dev/stdout' },
  { name: 'envoy.access_loggers.stdout', type: 'type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog', detail: "Envoy's own stdout" },
  { name: 'envoy.access_loggers.stderr', type: 'type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StderrAccessLog', detail: "Envoy's own stderr" },
  { name: 'envoy.access_loggers.http_grpc', type: 'type.googleapis.com/envoy.extensions.access_loggers.grpc.v3.HttpGrpcAccessLogConfig', detail: 'Streams to a gRPC service' },
]

const TRANSPORT_SOCKETS: Extension[] = [
  { name: 'envoy.transport_sockets.tls', type: 'type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext', detail: 'TLS this Envoy terminates' },
  { name: 'envoy.transport_sockets.raw_buffer', type: 'type.googleapis.com/envoy.extensions.transport_sockets.raw_buffer.v3.RawBuffer', detail: 'Plaintext' },
]

const ALL_EXTENSIONS = [
  ...HTTP_FILTERS,
  ...NETWORK_FILTERS,
  ...LISTENER_FILTERS,
  ...ACCESS_LOGGERS,
  ...TRANSPORT_SOCKETS,
]

/** `websocket` and `CONNECT` are the two anybody writes; Envoy matches them case-insensitively. */
const UPGRADE_TYPES: Suggestion[] = [
  { value: 'websocket', detail: 'HTTP/1.1 Upgrade, and extended CONNECT on HTTP/2' },
  { value: 'CONNECT', detail: 'Tunnelling' },
]

// ---- the lookup -------------------------------------------------------------------

const enums = (values: readonly string[]): Suggestion[] =>
  values.map((value) => ({ value, detail: ENUM_DETAIL[value] }))

const named = (extensions: Extension[]): Suggestion[] =>
  extensions.map((e) => ({ value: e.name, detail: e.detail }))

/** Every cluster the config defines, so a route can never name one that is not there. */
function clusterNames(model: ConfigModel): Suggestion[] {
  const out: Suggestion[] = []
  for (const cluster of model.clusters) {
    if (cluster.name === undefined) continue
    const where = cluster.usesEds
      ? 'endpoints over EDS'
      : cluster.endpoints.length > 0
        ? `${cluster.endpoints.length} endpoint${cluster.endpoints.length === 1 ? '' : 's'}`
        : undefined
    out.push({ value: cluster.name, detail: where })
  }
  return out
}

/**
 * Route configurations by name, inline ones included.
 *
 * An `rds.route_config_name` normally points at something a management server will deliver
 * and which is therefore not in this file at all — but on a `/config_dump` it is, and on a
 * hand-written bootstrap the inline names are what somebody is copying between listeners.
 */
function routeConfigNames(model: ConfigModel): Suggestion[] {
  const seen = new Set<string>()
  const out: Suggestion[] = []

  const add = (name: string | undefined, detail: string) => {
    if (name === undefined || seen.has(name)) return
    seen.add(name)
    out.push({ value: name, detail })
  }

  for (const config of model.routeConfigs) add(config.name, 'route configuration')
  for (const listener of model.listeners) {
    for (const chain of [...listener.filterChains, listener.defaultFilterChain]) {
      add(chain?.hcm?.routeConfig?.name, `inline in ${listener.name ?? 'a listener'}`)
    }
  }
  return out
}

/**
 * What can go here, given the keys enclosing the caret.
 *
 * `context` is the chain of keys from the document root down to the one whose value is
 * being completed, so `['static_resources', 'clusters', 'type']`. Spelling does not matter —
 * both of Envoy's are normalised — and the chain may be partial, since the caller is reading
 * a syntax tree over a document that is usually mid-edit.
 *
 * An empty result means "nothing useful to say here", which is most keys, and the caller
 * should show no menu at all rather than an empty one.
 */
export function suggestValues(context: readonly string[], model: ConfigModel): Suggestion[] {
  const chain = context.map(toCamel)
  const key = chain[chain.length - 1]
  if (key === undefined) return []

  // Ancestors only — the key itself is not its own container. `under('clusters')` on
  // `['clusters', 'name']` has to be true, and on `['routes', 'route', 'cluster']` false.
  const under = (ancestor: string) => chain.slice(0, -1).includes(ancestor)

  switch (key) {
    case 'cluster':
    case 'clusterName':
      return clusterNames(model)

    case 'routeConfigName':
      return routeConfigNames(model)

    case 'codecType':
      return enums(CODEC_TYPES)
    case 'trafficDirection':
      return enums(TRAFFIC_DIRECTIONS)
    case 'headersWithUnderscoresAction':
      return enums(UNDERSCORE_ACTIONS)
    case 'serverHeaderTransformation':
      return enums(SERVER_HEADER_TRANSFORMATIONS)
    case 'apiType':
      return enums(API_TYPES)
    case 'upgradeType':
      return UPGRADE_TYPES

    // `type` is too common a word to answer unconditionally — it means the discovery type on
    // a cluster and something else wherever else Envoy spells it.
    case 'type':
      return under('clusters') ? enums(CLUSTER_TYPES) : []

    case 'responseCode':
      return under('redirect') ? enums(REDIRECT_RESPONSE_CODES) : []

    // Every `@type` this package has a name for. Not narrowed to the sibling `name`, even
    // though that would usually pin it exactly: the two are written in either order, so
    // narrowing would work when the name came first and silently offer nothing when it did
    // not. The editor's own filtering closes the gap as soon as you type.
    case '@type':
      return ALL_EXTENSIONS.map((e) => ({ value: e.type, detail: e.name }))

    // `name` is the ambiguous one, and the enclosing list is what disambiguates it.
    case 'name': {
      if (under('httpFilters')) return named(HTTP_FILTERS)
      if (under('listenerFilters')) return named(LISTENER_FILTERS)
      if (under('accessLog')) return named(ACCESS_LOGGERS)
      if (under('transportSocket')) return named(TRANSPORT_SOCKETS)
      // After the more specific lists: an HTTP filter also sits under a `filters` entry by
      // way of the connection manager, and answering with network filters there would offer
      // `tcp_proxy` in the middle of an HTTP filter chain.
      if (under('filters')) return named(NETWORK_FILTERS)
      // A weighted cluster names a cluster, in a field spelled like every other name.
      if (under('weightedClusters')) return clusterNames(model)
      return []
    }

    default:
      return []
  }
}
