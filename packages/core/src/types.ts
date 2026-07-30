import type { ConfigFormat } from './parse.js'
import type { ConfigPath, Range } from './source.js'

// The modelled subset of Envoy's configuration.
//
// A subset, and knowingly so: this covers the listener → filter chain → route → cluster
// spine that determines where a request goes, because that is the question the tool exists
// to answer. Everything else in a config — access loggers, tracing, circuit breakers,
// health checks, most http filters — is read, reported as unmodelled, and otherwise left
// alone. See `Unknown` in `diagnostics.ts` for why that is stated out loud rather than
// quietly skipped.
//
// Field names are camelCase throughout even though bootstrap YAML is conventionally
// snake_case, because Envoy accepts both spellings and something has to be canonical.
// `toCamel` in `source.ts` is the funnel; the spelling the user actually wrote survives in
// diagnostics, which is where it matters.

/** Everything modelled carries where it came from, so the UI can point at it. */
export interface Sourced {
  path: ConfigPath
  range: Range
}

export interface ConfigModel {
  format: ConfigFormat
  listeners: Listener[]
  clusters: Cluster[]
  /**
   * Route configurations that are not inline in a listener.
   *
   * Empty for most hand-written bootstraps, where routes live inside the HTTP connection
   * manager. Populated from a `/config_dump`, which lists RDS-delivered route configs
   * separately from the listeners that reference them by name.
   */
  routeConfigs: RouteConfig[]
  /**
   * The bootstrap's own top level — who this Envoy says it is, where its admin port is,
   * and whether it expects to be told about listeners and clusters by somebody else.
   *
   * Absent when the document carried none of it, which includes most `/config_dump`s. The
   * last of the three earns its place rather than merely reducing a count: a bootstrap that
   * fetches clusters over CDS explains a route naming a cluster that is not written here,
   * and `validate.ts` stops calling that an error once it can see the reason.
   */
  bootstrap?: Bootstrap
}

export interface Bootstrap {
  node?: NodeIdentity
  admin?: AdminInterface
  dynamicResources?: DynamicResources
}

/** How this Envoy identifies itself to a management server. */
export interface NodeIdentity extends Sourced {
  id?: string
  cluster?: string
}

export interface AdminInterface extends Sourced {
  address?: SocketAddress
}

/**
 * What arrives over xDS instead of being written in the file.
 *
 * Read for what it implies about the rest of the config rather than for its own sake: with
 * CDS configured, a cluster the routes name and the file does not define is the ordinary
 * shape of dynamic configuration rather than a dangling reference, and saying otherwise
 * would be a confident accusation about a config this cannot see all of.
 */
export interface DynamicResources extends Sourced {
  /** Listeners are delivered by LDS rather than written here. */
  usesLds: boolean
  usesCds: boolean
  /** The cluster the xDS stream is opened to, when any of the sources names one. */
  xdsCluster?: string
}

// ---- listeners ------------------------------------------------------------------

export interface Listener extends Sourced {
  name?: string
  address?: SocketAddress
  /**
   * The other addresses this listener also binds.
   *
   * Modelled rather than merely read because it is a routing fact and nothing else: a
   * listener with `additional_addresses` accepts connections on every port in the list, and
   * a tester that knew only about `address` answered "nothing is listening on port 8443"
   * about a listener sitting two lines above the port it was asked about.
   */
  additionalAddresses: SocketAddress[]
  /**
   * INBOUND or OUTBOUND. A sidecar sets it and a front proxy usually does not, so it is
   * often the quickest way to tell which kind of config you have been handed.
   */
  trafficDirection?: string
  perConnectionBufferLimitBytes?: number
  /**
   * `bind_to_port: false` — the listener never takes a socket of its own.
   *
   * Worth having by name: it is how a virtual listener is reached only by another listener
   * redirecting to it, so "nothing is listening on that port" is the expected state rather
   * than a mistake.
   */
  bindToPort?: boolean
  statPrefix?: string
  /** How long the listener filters get before the connection proceeds regardless. */
  listenerFiltersTimeout?: string
  continueOnListenerFiltersTimeout?: boolean
  enableReusePort?: boolean
  tcpBacklogSize?: number
  /** Access loggers on the listener itself, by name — separate from any HCM's. */
  accessLogNames: string[]
  /**
   * Listener filter names in order — the TLS inspector, the HTTP inspector, original_dst.
   *
   * Worth having by name even though their configuration is not modelled, because the TLS
   * inspector is what makes SNI available to filter chain matching in the first place. A
   * listener matching chains on `server_names` without one is a config whose chain
   * selection will not do what it reads as doing.
   */
  listenerFilterNames: string[]
  filterChains: FilterChain[]
  /** Used when no `filterChains` entry matches. */
  defaultFilterChain?: FilterChain
}

export interface SocketAddress extends Sourced {
  address?: string
  portValue?: number
}

export interface FilterChain extends Sourced {
  name?: string
  match?: FilterChainMatch
  /** The HTTP connection manager in this chain, if it has one. TCP chains do not. */
  hcm?: HttpConnectionManager
  /**
   * The TCP proxy in this chain, if it has one. Mutually exclusive with `hcm` in practice.
   *
   * Modelled because a `tcp_proxy` chain IS the routing — it names its upstream directly,
   * with no route table in between. Leaving it out did not merely omit a detail: an entire
   * class of listener went to nowhere at all. The graph drew the chain as a dead end, the
   * route tester had no answer for a connection arriving on it, and the cluster it forwards
   * every byte to was reported as one nothing routes to.
   */
  tcpProxy?: TcpProxy
  /** Network filter names in order, including the HCM. For the graph, and for context. */
  filterNames: string[]
  /** Downstream TLS, when the chain terminates it. Absent means plaintext. */
  tls?: TlsContext
}

/** `tcp_proxy`: a chain that forwards bytes to one upstream, chosen without a route table. */
export interface TcpProxy extends Sourced {
  statPrefix?: string
  /** The upstream, when it names one outright. */
  cluster?: string
  /** The other arm: split by weight, decided per connection. */
  weightedClusters: WeightedCluster[]
}

/**
 * A cluster named by something that is not a route.
 *
 * Envoy's extensions talk to clusters: `ext_authz` calls one on every request, a gRPC access
 * logger streams to one, `jwt_authn` fetches its keys from one. Those are real edges in the
 * config — the cluster is defined here, referred to here, and reached at runtime — and until
 * they were read this package could not see any of them.
 *
 * The cost of not seeing them was not a missing feature, it was two wrong answers. A cluster
 * reached only by `ext_authz` was reported as one nothing routes to, and the detail on that
 * finding had to hedge — "a cluster can be reached by a filter" — because the tool genuinely
 * could not tell. Now it can, for the extensions it knows.
 *
 * Deliberately shallow: this is the ONE field in each extension that names a cluster. What
 * the extension does with that cluster is not modelled and is still reported as read but not
 * checked, exactly as before.
 */
export interface ClusterRef extends Sourced {
  /** The cluster name, as written. */
  cluster: string
  /** What names it — `envoy.filters.http.ext_authz`, `envoy.access_loggers.http_grpc`. */
  by: string
}

/**
 * The parts of a TLS context worth knowing about without reading the keys.
 *
 * Modelled because SNI-based filter chain matching only works on a chain that actually
 * terminates TLS — a `server_names` match on a plaintext chain is a common and completely
 * silent mistake. Nothing here holds key material; see `redact.ts` for that.
 */
export interface TlsContext extends Sourced {
  /** `envoy.transport_sockets.tls`, or whatever was written. */
  socketName?: string
  /** How many inline/file certificates are configured. */
  certificateCount: number
  /** Certificates delivered by SDS, by name. */
  sdsSecretNames: string[]
  alpnProtocols: string[]
  /** Downstream only: whether clients must present a certificate. */
  requireClientCertificate: boolean
}

/**
 * `filter_chain_match`, split into what the route tester evaluates and what it does not.
 *
 * The CIDR-based criteria are still not evaluated — they match on the addresses at the ends
 * of the connection, which is not something a request typed into the tester has. What
 * changed is that they are now READ. Leaving them unread reported `source_prefix_ranges`,
 * a field out of Envoy's own listener message, as one Attaché had never heard of, and on a
 * front proxy that steers by source range that is most of what its chain matching says.
 */
export interface FilterChainMatch extends Sourced {
  /** SNI. Supports a leading wildcard, e.g. `*.example.com`. */
  serverNames: string[]
  destinationPort?: number
  transportProtocol?: string
  /**
   * ALPN, which is negotiated during the handshake rather than written in a request.
   *
   * Read, and deliberately not evaluated: the route tester is handed a method, an authority
   * and a path, none of which say what protocol the client offered. It still counts towards
   * specificity, because that is what Envoy does — a chain naming `h2` beats one naming
   * nothing — so a config using it gets Envoy's answer for an h2 client together with a
   * caveat saying which criterion was assumed rather than checked.
   */
  applicationProtocols: string[]
  /**
   * Criteria on this chain that are recognised and deliberately not evaluated, spelled the
   * way they were written — `source_prefix_ranges`, `source_type`.
   *
   * Named rather than counted because the caveat this feeds is the difference between
   * telling somebody which line to go and read and telling them only that the answer might
   * be wrong.
   */
  unevaluatedCriteria: string[]
  /**
   * Whether this chain ALSO matches on something nothing here has heard of at all.
   *
   * Distinct from the list above: that one is a limit this package chose, this one is a
   * limit it discovered. Either way chain selection can differ from Envoy's and the tester
   * says so. Recorded rather than inferred later because by then the unread fields are gone.
   */
  hasUnmodelledCriteria: boolean
}

export interface HttpConnectionManager extends Sourced {
  statPrefix?: string
  /** AUTO, HTTP1, HTTP2, HTTP3 — what this listener will speak downstream. */
  codecType?: string
  /** Routes defined inline. Mutually exclusive with `rdsRouteConfigName`. */
  routeConfig?: RouteConfig
  /** Routes fetched from a management server by this name. */
  rdsRouteConfigName?: string
  httpFilters: string[]
  /**
   * Whether the client's address is taken from the connection or from `x-forwarded-for`.
   *
   * Modelled because it decides what `x-forwarded-for` and `x-envoy-external-address` say
   * to everything upstream, and because getting it wrong on an edge proxy is how a whole
   * fleet ends up rate-limiting on the address of its own load balancer.
   */
  useRemoteAddress?: boolean
  addUserAgent?: boolean
  /**
   * How many hops of `x-forwarded-for` to trust, counting from the right.
   *
   * The other half of `use_remote_address`, and useless without it: together they decide
   * which address in the chain Envoy calls the client, which is what every rate limit and
   * every access log line downstream is keyed on.
   */
  xffNumTrustedHops?: number
  skipXffAppend?: boolean
  /**
   * What Envoy does to the path BEFORE it matches a route. All three change where a request
   * goes, which is why they are here rather than filed with the rest of the HTTP settings.
   *
   * `normalizePath` removes `.` and `..` segments; `mergeSlashes` collapses runs of `/`;
   * `pathWithEscapedSlashesAction` decides what happens to an escaped slash. The first two
   * are string operations with one reading, and the route tester applies them. The third
   * involves percent-decoding and possibly a redirect, so it is stated rather than applied.
   */
  normalizePath?: boolean
  mergeSlashes?: boolean
  pathWithEscapedSlashesAction?: string
  /**
   * Whether the port comes off `:authority` before routing, and under what condition.
   *
   * `stripAnyHostPort` removes any port; `stripMatchingHostPort` removes it only when it is
   * the port this listener is bound to. Neither is the default, which is the part that
   * surprises people: a virtual host claiming `foo.com` does not match a request to
   * `foo.com:8443` unless one of these is set or the route config ignores the port.
   */
  stripAnyHostPort?: boolean
  stripMatchingHostPort?: boolean
  /** The `via` header this proxy adds, and the `Server` header it sends. */
  via?: string
  serverName?: string
  generateRequestId?: boolean
  preserveExternalRequestId?: boolean
  alwaysSetRequestIdInResponse?: boolean
  proxy100Continue?: boolean
  /** SANITIZE, FORWARD_ONLY, APPEND_FORWARD, SANITIZE_SET, ALWAYS_FORWARD_ONLY. */
  forwardClientCertDetails?: string
  maxRequestHeadersKb?: number
  /**
   * Timeouts as they were written — `300s`, `0s`. Not parsed into milliseconds: `0s` and
   * absent mean different things to Envoy, and a number could not tell them apart.
   */
  idleTimeout?: string
  streamIdleTimeout?: string
  requestTimeout?: string
  requestHeadersTimeout?: string
  drainTimeout?: string
  delayedCloseTimeout?: string
  /** From `common_http_protocol_options`, beside the idle timeout already read there. */
  maxConnectionDuration?: string
  maxStreamDuration?: string
  maxHeadersCount?: number
  /** ALLOW, REJECT_REQUEST, DROP_HEADER — what happens to `x_underscored_headers`. */
  headersWithUnderscoresAction?: string
  /** OVERWRITE, APPEND_IF_ABSENT, PASS_THROUGH. */
  serverHeaderTransformation?: string
  http1?: Http1Options
  http2?: Http2Options
  internalAddress?: InternalAddressConfig
  /** Access loggers by name. What each one writes, and where, is not modelled. */
  accessLogNames: string[]
  /**
   * Clusters this connection manager's own machinery talks to, rather than routes to.
   *
   * Its HTTP filters, its gRPC access loggers and its tracing provider. Collected here
   * rather than beside each because every consumer wants the same thing from them — is this
   * cluster reachable, and what reaches it — and none wants to know which of the three
   * places it came from.
   */
  serviceClusters: ClusterRef[]
  /** Protocol upgrades this listener will accept — `websocket`, `CONNECT`. */
  upgrades: UpgradeConfig[]
}

/** `http_protocol_options`: how this listener treats HTTP/1 downstream. */
export interface Http1Options {
  /** Whether Envoy will serve HTTP/1.0 clients at all. Off by default. */
  acceptHttp10?: boolean
  /** The `Host` given to an HTTP/1.0 request that sent none — which is most of them. */
  defaultHostForHttp10?: string
}

/** `http2_protocol_options`: the HTTP/2 settings worth reading back. */
export interface Http2Options {
  maxConcurrentStreams?: number
  /** Extended CONNECT, which is how HTTP/2 carries WebSockets. */
  allowConnect?: boolean
  /**
   * Flow control, in bytes: how much a peer may send before Envoy acknowledges it.
   *
   * Here because they sit beside `max_concurrent_streams` in every tuned config and were
   * being reported as fields nobody recognised on the strength of that alone. Read, not
   * judged — whether 64 KiB is the right window for a given link is a question about that
   * link's bandwidth-delay product, which is not in the config.
   */
  initialStreamWindowSize?: number
  initialConnectionWindowSize?: number
}

/**
 * What counts as an internal request.
 *
 * This is not trivia: it decides whether Envoy will trust and forward the internal-only
 * `x-envoy-*` headers, and it works together with `use_remote_address` to decide which hop
 * in `x-forwarded-for` is treated as the client. A config that sets one without the other
 * usually means something the person writing it did not intend.
 */
export interface InternalAddressConfig {
  /** Whether unix domain sockets count as internal. */
  unixSockets?: boolean
  /** CIDR ranges treated as internal, as `address/prefix`. */
  cidrRanges: string[]
}

export interface UpgradeConfig {
  /** `websocket`, `CONNECT`, `spdy/3` — matched case-insensitively by Envoy. */
  type: string
  /** Envoy defaults this to true; a config that writes `false` is switching it off. */
  enabled?: boolean
}

// ---- routes ---------------------------------------------------------------------

export interface RouteConfig extends Sourced {
  name?: string
  virtualHosts: VirtualHost[]
  /**
   * Whether the port in `:authority` is ignored when matching virtual host domains.
   *
   * A routing fact, and one of the few places a single boolean four levels up decides
   * whether a request 404s: with it unset, `foo.com:8443` is matched against the domain
   * list verbatim, and a virtual host claiming `foo.com` does not claim it.
   */
  ignorePortInHostMatching?: boolean
  ignorePathParametersInPathMatching?: boolean
  /**
   * `validate_clusters` — whether Envoy refuses the config when a route names a cluster it
   * does not have. Read because it says what a dangling reference will actually do here.
   */
  validateClusters?: boolean
  mostSpecificHeaderMutationsWins?: boolean
  maxDirectResponseBodySizeBytes?: number
}

export interface VirtualHost extends Sourced {
  name?: string
  /** Authority patterns: exact, `*.suffix`, `prefix.*`, or `*`. */
  domains: string[]
  routes: Route[]
  /** NONE, EXTERNAL_ONLY, ALL — whether this host redirects plaintext requests. */
  requireTls?: string
  includeRequestAttemptCount?: boolean
  includeAttemptCountInResponse?: boolean
  perRequestBufferLimitBytes?: number
  /**
   * HTTP filters this virtual host reconfigures or switches off, by name.
   *
   * The same routing-adjacent fact as the one on a route, at the level above it: turning
   * `ext_authz` off for a whole virtual host is how an internal-only host is kept out of the
   * authorization path, and it is just as invisible from any route's match.
   */
  typedPerFilterConfig: PerFilterOverride[]
}

export interface Route extends Sourced {
  name?: string
  match: RouteMatch
  action: RouteAction
  /**
   * What the `route` action does to the request on its way upstream. Absent unless the
   * route proxies at all — a redirect or a direct response never gets that far.
   */
  forwarding?: RouteForwarding
  /**
   * HTTP filters this route reconfigures or switches off, by name.
   *
   * Routing-adjacent enough to belong here rather than being left with the other
   * unmodelled filter configuration. Turning `ext_authz` off for one route is how a health
   * endpoint is kept out of the authorization path, and it is invisible from the route's
   * match — so "why was this request not authorized" has no answer in the part of the
   * config somebody would think to read.
   */
  typedPerFilterConfig: PerFilterOverride[]
}

/** Everything a `route` action does besides choosing the upstream. */
export interface RouteForwarding {
  /**
   * As written — `15s`. Kept as text because `0s` disables the timeout entirely and is a
   * deliberate thing to write, which a parsed number would render indistinguishable from a
   * field somebody left out.
   */
  timeout?: string
  idleTimeout?: string
  /** The matched prefix is replaced with this before the request leaves. */
  prefixRewrite?: string
  /** The `Host` the upstream sees, when the route rewrites it. */
  hostRewriteLiteral?: string
  /** The other two arms of the same oneof. */
  hostRewriteHeader?: string
  autoHostRewrite?: boolean
  appendXForwardedHost?: boolean
  /** The other arm of the path rewrite oneof. Mutually exclusive with `prefixRewrite`. */
  regexRewrite?: RegexRewrite
  /** Whether a `retry_policy` is configured at all, which is most of what is worth saying. */
  hasRetryPolicy: boolean
  /** What it retries on — `5xx`, `reset,connect-failure`. */
  retryOn?: string
  numRetries?: number
  /**
   * Clusters this route also sends a copy of every matching request to.
   *
   * `request_mirror_policies` is shadow traffic: the response is discarded, so it decides
   * nothing about where the request goes, but the cluster is genuinely reached and genuinely
   * defined here. Leaving it unread was the same bug `ext_authz` and `tcp_proxy` each had —
   * a cluster this config calls on every request, reported as one nothing reaches.
   */
  mirrorClusters: ClusterRef[]
}

export interface PerFilterOverride {
  /** The filter being overridden — `envoy.filters.http.ext_authz`. */
  name: string
  /**
   * Whether the override turns the filter off for this route.
   *
   * Both spellings put it in the same place: `FilterConfig` wraps a config it may be
   * suppressing, and the per-filter messages like `ExtAuthzPerRoute` carry `disabled`
   * directly, so one field read covers both.
   */
  disabled: boolean
  /** The override's `@type`, when it declared one. */
  type?: string
}

/** Envoy's `path_specifier` oneof, plus the secondary criteria. */
export interface RouteMatch extends Sourced {
  pathSpec: PathSpecifier
  /** Defaults to true, as Envoy does. */
  caseSensitive: boolean
  headers: HeaderMatcher[]
  queryParameters: QueryMatcher[]
  /**
   * Criteria on this route that are recognised and deliberately not evaluated, spelled the
   * way they were written — `runtime_fraction`, `grpc`, `tls_context`, `dynamic_metadata`.
   *
   * The same idea as the one on `FilterChainMatch`, and it was needed here for the same
   * reason: none of them can be answered from a method, an authority and a path, so a route
   * carrying one may not be the route Envoy picks. Saying nothing meant the tester returned
   * a confident winner for a route that matches half the time by design.
   */
  unevaluatedCriteria: string[]
  /** Whether the match ALSO turns on something nothing here has heard of at all. */
  hasUnmodelledCriteria: boolean
}

export type PathSpecifier =
  | { kind: 'prefix'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'pathSeparatedPrefix'; value: string }
  | { kind: 'safeRegex'; value: string }
  /** A path_specifier this package does not evaluate — CONNECT, path_match_policy. */
  | { kind: 'unmodelled'; label: string }
  /** No path_specifier at all, which Envoy rejects. */
  | { kind: 'none' }

export type RouteAction =
  | { kind: 'cluster'; cluster: string }
  | { kind: 'weightedClusters'; clusters: WeightedCluster[] }
  /** The upstream is chosen at request time from a header, so it cannot be checked here. */
  | { kind: 'clusterHeader'; header: string }
  | ({ kind: 'redirect' } & RedirectAction)
  | { kind: 'directResponse'; status?: number; body?: ResponseBody }
  /** An action this package does not model, or none at all. */
  | { kind: 'unmodelled'; label: string }

/**
 * Where a redirect sends the request.
 *
 * Every part of this is optional and Envoy fills in whatever the config does not name from
 * the request itself, which is what makes a redirect route so easy to misread: `redirect:
 * { https_redirect: true }` is a complete, working rule and looks from a distance like an
 * empty block. Modelled in full for exactly that reason — the tester used to say a route
 * "redirects rather than proxying" and stop, which is the least useful true sentence
 * available about it.
 */
export interface RedirectAction {
  /** The `Location` host. Absent means the request's own authority. */
  hostRedirect?: string
  portRedirect?: number
  /** Replaces the whole path. Mutually exclusive with `prefixRewrite`. */
  pathRedirect?: string
  /** Replaces the part of the path that the route matched on. */
  prefixRewrite?: string
  /** The third arm of the same oneof: the path put through a regular expression. */
  regexRewrite?: RegexRewrite
  /** `https_redirect: true` is shorthand for `scheme_redirect: https`. */
  httpsRedirect?: boolean
  schemeRedirect?: string
  /** MOVED_PERMANENTLY, FOUND, SEE_OTHER, TEMPORARY_REDIRECT, PERMANENT_REDIRECT. */
  responseCode?: string
  stripQuery?: boolean
}

/**
 * A `RegexMatchAndSubstitute`, kept as the pair of strings it was written as.
 *
 * Deliberately not compiled and never applied. The pattern is RE2 and the substitution
 * writes its capture groups as `\1`, so neither is a JavaScript regular expression, and a
 * tester that ran them through one would be answering a slightly different question than
 * Envoy without saying which parts it got away with.
 *
 * Modelled all the same, because a redirect whose path comes out of a regex has a
 * destination that cannot be read off the config unless the rule is shown — and the
 * alternative on offer was reporting Envoy's documented rewrite field as one nothing here
 * had heard of.
 */
export interface RegexRewrite {
  /** The RE2 pattern, from `pattern.regex`. */
  pattern: string
  /** What matches are replaced with. Empty is legal and means "delete the match". */
  substitution: string
}

/**
 * An Envoy `DataSource`, as far as it can honestly be shown.
 *
 * `inline_string` is the one worth reading back: a direct response body is usually a short
 * JSON error or a health check's "OK", and showing it answers "what does this route
 * actually return" in one line. A filename is a path on a machine this cannot see and
 * `inline_bytes` is base64 nobody wants on screen, so both are named rather than opened.
 */
export interface ResponseBody {
  inline?: string
  filename?: string
}

export interface WeightedCluster {
  name: string
  weight?: number
}

export type HeaderMatchKind =
  | 'present'
  | 'exact'
  | 'prefix'
  | 'suffix'
  | 'contains'
  | 'safeRegex'
  | 'unmodelled'

export interface HeaderMatcher extends Sourced {
  name: string
  kind: HeaderMatchKind
  value?: string
  /** `invert_match`: the matcher above must NOT hold. */
  invert: boolean
  /** Whether a missing header satisfies an inverted matcher. Envoy defaults this false. */
  treatMissingAsEmpty: boolean
  /**
   * `string_match.ignore_case`, which Envoy applies to exact, prefix, suffix and contains
   * and explicitly not to a regex.
   *
   * Carried rather than dropped. It used to be read purely so it would not be reported as an
   * unrecognised field, on the strength of a comment claiming the route tester stated the
   * limitation — which it did not, anywhere, so a matcher written `exact: PROD, ignore_case:
   * true` was quietly failed against a request sending `prod`.
   */
  ignoreCase: boolean
}

export interface QueryMatcher extends Sourced {
  name: string
  kind: 'present' | 'exact' | 'prefix' | 'suffix' | 'contains' | 'safeRegex' | 'unmodelled'
  value?: string
  ignoreCase: boolean
  /** Why the matcher is not evaluated, for the `unmodelled` kind. */
  label?: string
}

// ---- clusters -------------------------------------------------------------------

export interface Cluster extends Sourced {
  name?: string
  /** STRICT_DNS, EDS, STATIC, LOGICAL_DNS, ORIGINAL_DST — or absent, meaning STATIC. */
  type?: string
  lbPolicy?: string
  /** As written — `0.25s`, `5s`. Not parsed; kept so the graph can show it. */
  connectTimeout?: string
  /** AUTO, V4_ONLY, V6_ONLY, V4_PREFERRED, ALL — and the rest of the DNS settings. */
  dnsLookupFamily?: string
  dnsRefreshRate?: string
  respectDnsTtl?: boolean
  perConnectionBufferLimitBytes?: number
  maxRequestsPerConnection?: number
  ignoreHealthOnHostRemoval?: boolean
  /** The name this cluster's stats are emitted under, when it is not the cluster name. */
  altStatName?: string
  endpoints: Endpoint[]
  /** True when endpoints come from EDS, so an empty `endpoints` is expected. */
  usesEds: boolean
  /** Upstream TLS, when this cluster speaks it. */
  tls?: TlsContext
  /** Whether health checking, circuit breaking and outlier detection are configured. */
  hasHealthChecks: boolean
  hasCircuitBreakers: boolean
  hasOutlierDetection: boolean
}

export interface Endpoint extends Sourced {
  address?: string
  portValue?: number
  /** The name this endpoint answers to, when it is not the address. */
  hostname?: string
  /** HEALTHY, UNHEALTHY, DRAINING, TIMEOUT, DEGRADED — as the config asserts it. */
  healthStatus?: string
  /** This endpoint's share of the traffic, and its locality's. */
  loadBalancingWeight?: number
  /** The locality it was declared under, as `region/zone/sub_zone`. */
  locality?: string
  /** Localities are tried in priority order, 0 first. */
  priority?: number
}
