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
  ClusterRef,
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
  RegexRewrite,
  Route,
  RouteAction,
  RouteConfig,
  RouteForwarding,
  RouteMatch,
  SocketAddress,
  TcpProxy,
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

/** The key this cursor arrived through, spelled the way the config spelled it. */
const writtenAs = (c: Cursor) => String(c.path[c.path.length - 1] ?? '')

/**
 * A `RegexMatchAndSubstitute`, read but not compiled — see `RegexRewrite` for why not.
 *
 * `google_re2` is the same empty marker it is everywhere else Envoy takes a regex, so it is
 * acknowledged here for the same reason: fetching it without touching it left it looking
 * like a field nobody had asked for.
 */
function regexRewrite(c: Cursor | undefined): RegexRewrite | undefined {
  if (!c) return undefined
  const pattern = c.field('pattern')
  pattern?.field('googleRe2')?.acknowledge()
  const regex = pattern?.strAt('regex')
  if (regex === undefined) return undefined
  return { pattern: regex, substitution: c.strAt('substitution') ?? '' }
}

// ---- clusters named by extensions -------------------------------------------------

/**
 * `GrpcService.envoy_grpc.cluster_name`, which is how nearly every extension names an
 * upstream it talks to.
 *
 * The `google_grpc` arm beside it names a target URI rather than a cluster, so there is
 * nothing here to resolve against this config — read and left, like everything else that is
 * real configuration and not a routing fact.
 */
function envoyGrpcCluster(service: Cursor | undefined): string | undefined {
  if (!service) return undefined
  service.field('googleGrpc')?.acknowledge()
  return service.field('envoyGrpc')?.strAt('clusterName')
}

/**
 * Where each extension this package recognises keeps the cluster it talks to.
 *
 * Matched on the `@type`, which is the reliable half — `name` is free text and a config that
 * spells a filter `authz` rather than `envoy.filters.http.ext_authz` is legal and common.
 * The substring is enough: Envoy's type URLs end in a message name that is unique across the
 * extensions worth reading, and matching the full URL would break on the version suffix the
 * day v4 arrives.
 *
 * Each reader takes the extension's `typed_config` and returns every cluster it names, which
 * is usually one and is a list because `jwt_authn` carries a provider map and a real config
 * has several.
 */
const CLUSTER_NAMING_EXTENSIONS: { type: string; read: (c: Cursor) => (string | undefined)[] }[] = [
  {
    // Two arms, and a config uses one or the other: a gRPC authorization service, or an
    // HTTP one whose `server_uri` names the cluster instead.
    type: 'ExtAuthz',
    read: (c) => [
      envoyGrpcCluster(c.field('grpcService')),
      c.field('httpService')?.field('serverUri')?.strAt('cluster'),
    ],
  },
  { type: 'RateLimit', read: (c) => [envoyGrpcCluster(c.field('rateLimitService')?.field('grpcService'))] },
  { type: 'ExternalProcessor', read: (c) => [envoyGrpcCluster(c.field('grpcService'))] },
  {
    // `providers` is a proto map keyed by provider name, so `fields()` rather than `field()`
    // — the same reason `typed_per_filter_config` needs it.
    type: 'JwtAuthentication',
    read: (c) =>
      (c.field('providers')?.fields() ?? []).map(({ cursor }) =>
        cursor.field('remoteJwks')?.field('httpUri')?.strAt('cluster'),
      ),
  },
  {
    // Both gRPC access loggers wrap theirs the same way.
    type: 'GrpcAccessLogConfig',
    read: (c) => [envoyGrpcCluster(c.field('commonConfig')?.field('grpcService'))],
  },
  { type: 'OpenTelemetryConfig', read: (c) => [envoyGrpcCluster(c.field('grpcService'))] },
  // Zipkin and Datadog name a cluster outright rather than wrapping it in a GrpcService.
  { type: 'ZipkinConfig', read: (c) => [c.strAt('collectorCluster')] },
  { type: 'DatadogConfig', read: (c) => [c.strAt('collectorCluster')] },
]

/**
 * Every cluster an extension's `typed_config` names, and nothing else about it.
 *
 * The node is acknowledged either way. That is the point of doing this at all: reading one
 * field out of `ext_authz` is not the same as having an opinion about `ext_authz`, and the
 * block goes on being reported as read-but-not-checked exactly as it did before. What
 * changes is that the cluster it calls stops looking unreachable.
 */
function serviceClusters(typed: Cursor | undefined, by: string | undefined): ClusterRef[] {
  if (!typed) return []
  const type = typed.strAt('@type') ?? ''
  const entry = CLUSTER_NAMING_EXTENSIONS.find((e) => type.includes(e.type))

  const found = entry ? entry.read(typed) : []
  typed.acknowledge()

  return found
    .filter((cluster): cluster is string => cluster !== undefined && cluster !== '')
    .map((cluster) => ({ ...sourced(typed), cluster, by: by ?? type }))
}

/**
 * `tcp_proxy`, read for the one thing it decides: which upstream the bytes go to.
 *
 * Everything else on it — idle timeouts, tunnelling, its own access logs — is acknowledged
 * in one go rather than reported field by field, the same treatment any other filter's
 * configuration gets. The cluster is the exception because it is not filter configuration at
 * all, it is the routing.
 */
function tcpProxy(c: Cursor): TcpProxy {
  const weighted = c.field('weightedClusters')
  const clusters: WeightedCluster[] = (weighted?.field('clusters')?.items() ?? []).map((w) => ({
    name: w.strAt('name') ?? '',
    weight: w.numAt('weight'),
  }))

  const proxy = {
    ...sourced(c),
    statPrefix: c.strAt('statPrefix'),
    cluster: c.strAt('cluster'),
    weightedClusters: clusters,
  }
  if (c.hasUnread()) c.acknowledge()
  return proxy
}

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
  let ignoreCase = false

  const stringMatch = c.field('stringMatch')
  if (stringMatch) {
    // Carried through to the matcher rather than merely fetched. Envoy applies it to the
    // four literal arms and explicitly not to `safe_regex`, so it is cleared again below
    // when the regex arm is the one that answers.
    ignoreCase = stringMatch.field('ignoreCase')?.bool() ?? false
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
          // RE2 carries its own case rules inside the pattern, so Envoy documents
          // `ignore_case` as having no effect here. Honouring it anyway would be this
          // package inventing a behaviour and then being confidently wrong about it.
          ignoreCase = false
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
    if (present !== undefined) {
      return {
        ...sourced(c),
        name,
        kind: 'present',
        invert: invert !== present,
        treatMissingAsEmpty,
        ignoreCase: false,
      }
    }
  }

  // A `range_match` is the one arm left: recognised, not evaluated, and reported as such
  // rather than as a field this package has never heard of.
  const rangeMatch = c.field('rangeMatch')
  if (rangeMatch) rangeMatch.acknowledge()
  else if (value === undefined && kind === 'unmodelled') {
    // A matcher with a name and nothing else IS a presence check — but only when there is
    // genuinely nothing else. Every arm above has been asked for by now, so anything still
    // unread is an arm nobody here recognises, and calling that a presence check is a
    // confident wrong answer where an admitted gap was available: it made a route with an
    // unread criterion match every request carrying the header, silently.
    kind = c.hasUnread() ? 'unmodelled' : 'present'
  }

  return { ...sourced(c), name, kind, value, invert, treatMissingAsEmpty, ignoreCase }
}

function queryMatcher(c: Cursor): QueryMatcher {
  const name = c.strAt('name') ?? ''
  // Read up front rather than in an early return, so that the arms below are asked for even
  // when this one answers — `hasUnread()` at the bottom is only meaningful once every arm
  // this package knows has been fetched.
  const present = c.field('presentMatch')?.bool()

  const stringMatch = c.field('stringMatch')
  if (stringMatch) {
    const ignoreCase = stringMatch.field('ignoreCase')?.bool() ?? false
    for (const field of ['exact', 'prefix', 'suffix', 'contains'] as const) {
      const found = stringMatch.strAt(field)
      if (found !== undefined) return { ...sourced(c), name, kind: field, value: found, ignoreCase }
    }
    const safeRegex = stringMatch.field('safeRegex')
    if (safeRegex) {
      safeRegex.field('googleRe2')?.acknowledge()
      const regex = safeRegex.strAt('regex')
      if (regex !== undefined) {
        return { ...sourced(c), name, kind: 'safeRegex', value: regex, ignoreCase: false }
      }
    }
  }

  if (present === true) return { ...sourced(c), name, kind: 'present', ignoreCase: false }

  // `present_match: false` is not evaluated, and that is a decision rather than an omission.
  // Envoy's proto documents the field as "specifies whether a query parameter should be
  // present", which reads as "it must be absent"; its router keys the check on which arm of
  // the oneof was set, under which writing `false` behaves exactly like writing `true`. Two
  // readings that disagree on every request is precisely the case this package answers by
  // naming the field rather than by picking one and sounding sure.
  if (present === false) {
    return { ...sourced(c), name, kind: 'unmodelled', ignoreCase: false, label: 'present_match: false' }
  }

  // As on a header matcher: a name and nothing else is a presence check, an unread arm is
  // not. This one returned `present` for anything it did not recognise, which meant the
  // `unmodelled` kind in the type was unreachable and a route carrying a matcher out of a
  // newer Envoy matched on the parameter merely being there.
  return c.hasUnread()
    ? { ...sourced(c), name, kind: 'unmodelled', ignoreCase: false }
    : { ...sourced(c), name, kind: 'present', ignoreCase: false }
}

/**
 * Route match criteria this package reads and deliberately does not evaluate.
 *
 * The counterpart of `UNEVALUATED_MATCH_CRITERIA` on a filter chain, and it exists for the
 * same reason: none of these can be settled from a method, an authority and a path.
 * `runtime_fraction` matches a share of requests and is decided per request; `grpc` asks
 * what content type the client sent; `tls_context` asks about a certificate this tester
 * never sees; `dynamic_metadata` asks what an earlier filter put there.
 */
const UNEVALUATED_ROUTE_CRITERIA = [
  'runtimeFraction',
  'grpc',
  'tlsContext',
  'dynamicMetadata',
] as const

function routeMatch(c: Cursor): RouteMatch {
  const pathSpec = pathSpecifier(c)
  const caseSensitive = c.field('caseSensitive')?.bool() ?? true
  const headers = (c.field('headers')?.items() ?? []).map(headerMatcher)
  const queryParameters = (c.field('queryParameters')?.items() ?? []).map(queryMatcher)

  const unevaluatedCriteria: string[] = []
  for (const name of UNEVALUATED_ROUTE_CRITERIA) {
    const criterion = c.field(name)
    if (!criterion) continue
    criterion.acknowledge()
    unevaluatedCriteria.push(writtenAs(criterion))
  }

  return {
    ...sourced(c),
    pathSpec,
    caseSensitive,
    headers,
    queryParameters,
    unevaluatedCriteria,
    // Asked last, so "unread" means "not modelled" rather than "not read yet".
    hasUnmodelledCriteria: c.hasUnread(),
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
      regexRewrite: regexRewrite(redirect.field('regexRewrite')),
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

  // Ordinary things a `route` action carries that do not decide which cluster the request
  // reaches. `cors` is the CORS filter's per-route settings, in the place Envoy kept for
  // them before `typed_per_filter_config` existed and still accepts. `hash_policy` chooses
  // an ENDPOINT within the cluster the route already picked, from a header or a cookie that
  // only exists at request time — so it is beyond what a config can be asked. The rest are
  // limits, rate limits and the response code for a cluster that is missing at runtime.
  // Each is read for presence, which is what stops it being reported as a field out of
  // nowhere on every route in a real config.
  for (const name of [
    'cors',
    'hashPolicy',
    'rateLimits',
    'includeVhRateLimits',
    'upgradeConfigs',
    'maxStreamDuration',
    'internalRedirectPolicy',
    'clusterNotFoundResponseCode',
    'priority',
    'metadataMatch',
    'hostRewritePathRegex',
    'pathRewritePolicy',
    'earlyDataPolicy',
    'clusterSpecifierPlugin',
    'retryPolicyTypedConfig',
    'hedgePolicy',
  ] as const) {
    route.field(name)?.acknowledge()
  }

  return {
    timeout: route.strAt('timeout'),
    idleTimeout: route.strAt('idleTimeout'),
    prefixRewrite: route.strAt('prefixRewrite'),
    regexRewrite: regexRewrite(route.field('regexRewrite')),
    hostRewriteLiteral: route.strAt('hostRewriteLiteral'),
    hostRewriteHeader: route.strAt('hostRewriteHeader'),
    autoHostRewrite: route.field('autoHostRewrite')?.bool(),
    appendXForwardedHost: route.field('appendXForwardedHost')?.bool(),
    hasRetryPolicy: retry !== undefined,
    retryOn: retry?.strAt('retryOn'),
    numRetries: retry?.numAt('numRetries'),
    mirrorClusters: (route.field('requestMirrorPolicies')?.items() ?? [])
      .map((policy): ClusterRef | undefined => {
        // The other arm names a cluster header, which is decided per request. The fraction
        // beside it is how much of the traffic is copied, which is real configuration and
        // not a question about whether the cluster is reached at all.
        policy.field('runtimeFraction')?.acknowledge()
        policy.field('traceSampled')?.acknowledge()
        policy.field('disableShadowHostSuffixAppend')?.acknowledge()
        policy.field('clusterHeader')
        const cluster = policy.strAt('cluster')
        return cluster === undefined || cluster === ''
          ? undefined
          : { ...sourced(policy), cluster, by: 'request_mirror_policies' }
      })
      .filter((ref): ref is ClusterRef => ref !== undefined),
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

/**
 * Header mutations, which every level of a route configuration carries its own copy of.
 *
 * Read for presence and no further, at all four levels. What a config adds to a request on
 * its way past is real configuration and plainly not a routing fact — but it is written on
 * essentially every virtual host in production, and having four ordinary Envoy fields
 * reported as unrecognised on each of them is what the unrecognised list is not for.
 */
function headerMutations(c: Cursor): void {
  for (const name of [
    'requestHeadersToAdd',
    'requestHeadersToRemove',
    'responseHeadersToAdd',
    'responseHeadersToRemove',
  ] as const) {
    c.field(name)?.acknowledge()
  }
}

function route(c: Cursor): Route {
  const match = c.require('match', 'Without it Envoy cannot decide whether this route applies.')

  headerMutations(c)
  // The decorator names the span this route produces, `tracing` overrides the sampling for
  // it, and the rest are limits and stat names. All real, none of them about where the
  // request goes.
  for (const name of [
    'decorator',
    'tracing',
    'metadata',
    'perRequestBufferLimitBytes',
    'statPrefix',
  ] as const) {
    c.field(name)?.acknowledge()
  }

  return {
    ...sourced(c),
    name: c.strAt('name'),
    match: match
      ? routeMatch(match)
      : {
          ...sourced(c),
          pathSpec: { kind: 'none' },
          caseSensitive: true,
          headers: [],
          queryParameters: [],
          unevaluatedCriteria: [],
          hasUnmodelledCriteria: false,
        },
    action: routeAction(c),
    forwarding: forwarding(c),
    typedPerFilterConfig: perFilterConfig(c),
  }
}

function virtualHost(c: Cursor): VirtualHost {
  const domains = c.require('domains', 'A virtual host with no domains can never be selected.')

  headerMutations(c)
  for (const name of [
    'retryPolicy',
    'retryPolicyTypedConfig',
    'hedgePolicy',
    'cors',
    'rateLimits',
    'virtualClusters',
    'metadata',
    'matcher',
  ] as const) {
    c.field(name)?.acknowledge()
  }

  return {
    ...sourced(c),
    name: c.strAt('name'),
    domains: (domains?.items() ?? []).map((d) => d.str()).filter((d): d is string => d !== undefined),
    routes: (c.field('routes')?.items() ?? []).map(route),
    requireTls: c.strAt('requireTls'),
    includeRequestAttemptCount: c.field('includeRequestAttemptCount')?.bool(),
    includeAttemptCountInResponse: c.field('includeAttemptCountInResponse')?.bool(),
    perRequestBufferLimitBytes: c.numAt('perRequestBufferLimitBytes'),
    typedPerFilterConfig: perFilterConfig(c),
  }
}

function routeConfig(c: Cursor): RouteConfig {
  headerMutations(c)
  for (const name of ['internalOnlyHeaders', 'vhds', 'clusterSpecifierPlugins', 'metadata'] as const) {
    c.field(name)?.acknowledge()
  }
  // A route configuration can carry per-filter overrides too, at the level above its virtual
  // hosts. Read the same way as everywhere else it appears, and then left alone.
  c.field('typedPerFilterConfig')?.acknowledge()

  return {
    ...sourced(c),
    name: c.strAt('name'),
    virtualHosts: (c.field('virtualHosts')?.items() ?? []).map(virtualHost),
    ignorePortInHostMatching: c.field('ignorePortInHostMatching')?.bool(),
    ignorePathParametersInPathMatching: c.field('ignorePathParametersInPathMatching')?.bool(),
    validateClusters: c.field('validateClusters')?.bool(),
    mostSpecificHeaderMutationsWins: c.field('mostSpecificHeaderMutationsWins')?.bool(),
    maxDirectResponseBodySizeBytes: c.numAt('maxDirectResponseBodySizeBytes'),
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
  // The three places a connection manager reaches a cluster that is not a route: its HTTP
  // filters, its access loggers, and its tracing provider. Each is read for that one field
  // and then acknowledged exactly as it was before — the logger's `filter`, the tracing
  // provider's sampling, the authorization filter's rules are all still nobody's business
  // here. See `serviceClusters` for why reading one field is not the same as judging the
  // extension around it.
  const filters = c.field('httpFilters')?.items() ?? []
  const logs = c.field('accessLog')?.items() ?? []
  const tracing = c.field('tracing')
  const provider = tracing?.field('provider')

  const service: ClusterRef[] = [
    ...filters.flatMap((f) => serviceClusters(f.field('typedConfig'), f.strAt('name'))),
    ...logs.flatMap((log) => {
      // The logger's `filter` decides which requests produce a line. Real configuration,
      // and not something this can check.
      log.field('filter')?.acknowledge()
      return serviceClusters(log.field('typedConfig'), log.strAt('name'))
    }),
    ...serviceClusters(provider?.field('typedConfig'), provider?.strAt('name') ?? 'tracing'),
  ]
  // The provider's `name` is read for the same reason a filter's is — it says WHICH tracer,
  // which is most of what anybody wants from a tracing block at a glance — and reading it is
  // also what stops it arriving as a field nobody recognised. Whatever else either node
  // carries is sampling and tags, which is configuration and not a routing fact.
  if (provider?.hasUnread()) provider.acknowledge()
  if (tracing?.hasUnread()) tracing.acknowledge()

  const common = c.field('commonHttpProtocolOptions')
  const http1 = c.field('httpProtocolOptions')
  const http2 = c.field('http2ProtocolOptions')
  const internal = c.field('internalAddressConfig')

  // Sub-messages that are real configuration and no business of this package's: the body a
  // locally generated error gets, which client certificate details are forwarded, and the
  // extension points for deciding the client's address and mutating headers early.
  for (const name of [
    'localReplyConfig',
    'setCurrentClientCertDetails',
    'schemeHeaderTransformation',
    'originalIpDetectionExtensions',
    'earlyHeaderMutationExtensions',
    'requestIdExtension',
    'streamErrorOnInvalidHttpMessage',
    'pathNormalizationOptions',
  ] as const) {
    c.field(name)?.acknowledge()
  }

  return {
    ...sourced(c),
    statPrefix: c.strAt('statPrefix'),
    codecType: c.field('codecType')?.enumOf(CODEC_TYPES),
    routeConfig: inline ? routeConfig(inline) : undefined,
    rdsRouteConfigName: rds?.strAt('routeConfigName'),
    httpFilters: filters.map((f) => f.strAt('name')).filter((n): n is string => n !== undefined),
    useRemoteAddress: c.field('useRemoteAddress')?.bool(),
    addUserAgent: c.field('addUserAgent')?.bool(),
    xffNumTrustedHops: c.numAt('xffNumTrustedHops'),
    skipXffAppend: c.field('skipXffAppend')?.bool(),
    normalizePath: c.field('normalizePath')?.bool(),
    mergeSlashes: c.field('mergeSlashes')?.bool(),
    pathWithEscapedSlashesAction: c.strAt('pathWithEscapedSlashesAction'),
    stripAnyHostPort: c.field('stripAnyHostPort')?.bool(),
    stripMatchingHostPort: c.field('stripMatchingHostPort')?.bool(),
    via: c.strAt('via'),
    serverName: c.strAt('serverName'),
    generateRequestId: c.field('generateRequestId')?.bool(),
    preserveExternalRequestId: c.field('preserveExternalRequestId')?.bool(),
    alwaysSetRequestIdInResponse: c.field('alwaysSetRequestIdInResponse')?.bool(),
    proxy100Continue: c.field('proxy100Continue')?.bool(),
    forwardClientCertDetails: c.strAt('forwardClientCertDetails'),
    maxRequestHeadersKb: c.numAt('maxRequestHeadersKb'),
    idleTimeout: common?.strAt('idleTimeout'),
    headersWithUnderscoresAction: common
      ?.field('headersWithUnderscoresAction')
      ?.enumOf(UNDERSCORE_ACTIONS),
    maxConnectionDuration: common?.strAt('maxConnectionDuration'),
    maxStreamDuration: common?.strAt('maxStreamDuration'),
    maxHeadersCount: common?.numAt('maxHeadersCount'),
    streamIdleTimeout: c.strAt('streamIdleTimeout'),
    requestTimeout: c.strAt('requestTimeout'),
    requestHeadersTimeout: c.strAt('requestHeadersTimeout'),
    drainTimeout: c.strAt('drainTimeout'),
    delayedCloseTimeout: c.strAt('delayedCloseTimeout'),
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
      initialStreamWindowSize: http2.numAt('initialStreamWindowSize'),
      initialConnectionWindowSize: http2.numAt('initialConnectionWindowSize'),
    },
    internalAddress: internal && internalAddressConfig(internal),
    accessLogNames: logs.map((log) => log.strAt('name')).filter((n): n is string => n !== undefined),
    serviceClusters: service,
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

/**
 * The criteria Envoy narrows filter chains by that this package reads and does not evaluate.
 *
 * Every one of them is about an address at one end of the connection or the other, and the
 * route tester asks for a request rather than a socket, so none of them can be answered
 * here. Read by name regardless: reading is the whole difference between "Attaché has never
 * heard of this field" and "Attaché knows exactly what this is and cannot answer it", and
 * `source_prefix_ranges` — the ordinary way a sidecar tells inbound mesh traffic from
 * everything else — was getting the first sentence.
 */
const UNEVALUATED_MATCH_CRITERIA = [
  'prefixRanges',
  'sourcePrefixRanges',
  'directSourcePrefixRanges',
  'sourcePorts',
  'sourceType',
  'addressSuffix',
  'suffixLen',
] as const

function filterChainMatch(c: Cursor): FilterChainMatch {
  const unevaluatedCriteria: string[] = []
  for (const name of UNEVALUATED_MATCH_CRITERIA) {
    const criterion = c.field(name)
    if (!criterion) continue
    criterion.acknowledge()
    unevaluatedCriteria.push(writtenAs(criterion))
  }

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
    unevaluatedCriteria,
    // Asked after every known field has been read, so "unread" means "not modelled" — and
    // now that the CIDR criteria above are read by name, it means only that.
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

  // Real TLS configuration, read and left alone. Whether this cipher list is the right one,
  // or whether that validation context trusts the CA it ought to, is a question about
  // somebody's threat model and their PKI — not one anything in a browser tab can answer
  // from the config in front of it.
  //
  // The reason they are read at all is that they were not: `tls_params` sits on essentially
  // every listener that terminates TLS in earnest, and being told that Envoy's own
  // minimum-protocol-version field was unrecognised is precisely the overstatement this
  // split exists to stop. The validation context has three spellings and all three are
  // asked for, because which one a config uses says nothing about how well it is understood.
  common?.field('tlsParams')?.acknowledge()
  for (const name of [
    'validationContext',
    'combinedValidationContext',
    'validationContextSdsSecretConfig',
  ] as const) {
    common?.field(name)?.acknowledge()
  }

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

const TCP_PROXY_NAMES = new Set(['envoy.filters.network.tcp_proxy', 'envoy.tcp_proxy'])

function filterChain(c: Cursor): FilterChain {
  const filterNames: string[] = []
  let hcm: HttpConnectionManager | undefined
  let tcp: TcpProxy | undefined

  for (const filter of c.field('filters')?.items() ?? []) {
    const name = filter.strAt('name')
    if (name !== undefined) filterNames.push(name)

    const typed = filter.field('typedConfig')
    if (!typed) continue

    const type = typed.strAt('@type') ?? ''
    if ((name !== undefined && HCM_NAMES.has(name)) || type.includes('HttpConnectionManager')) {
      hcm = httpConnectionManager(typed)
    } else if ((name !== undefined && TCP_PROXY_NAMES.has(name)) || type.includes('TcpProxy')) {
      // The other kind of chain, and the one that used to go nowhere. A `tcp_proxy` names
      // its upstream directly — there is no route table between the chain and the cluster —
      // so not reading it left the whole listener terminating in a filter nobody had looked
      // inside, with its cluster reported as one nothing routes to.
      tcp = tcpProxy(typed)
    } else {
      // Read enough to know it is neither, then stop — one finding naming this filter,
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
    tcpProxy: tcp,
    filterNames,
    tls: socket ? tlsContext(socket) : undefined,
  }
}

function listener(c: Cursor): Listener {
  const address = c.field('address')
  const fallback = c.field('defaultFilterChain')

  // Sockets, balancing and drain behaviour: how the listener takes a connection rather than
  // what it does with one. Real fields, ordinary on a tuned config, and outside the spine
  // this package has an opinion about.
  for (const name of [
    'socketOptions',
    'connectionBalanceConfig',
    'udpListenerConfig',
    'metadata',
    'drainType',
    'freebind',
    'reusePort',
    'useOriginalDst',
    'filterChainMatcher',
    'apiListener',
    'trafficDirectionUnused',
  ] as const) {
    c.field(name)?.acknowledge()
  }

  const logs = c.field('accessLog')?.items() ?? []
  for (const log of logs) {
    log.field('filter')?.acknowledge()
    log.field('typedConfig')?.acknowledge()
  }

  return {
    ...sourced(c),
    name: c.strAt('name'),
    address: address ? socketAddress(address) : undefined,
    // Each entry wraps an address the same way the listener's own does, so the same reader
    // serves both and the tester can treat the list as the set of ports this listener has.
    additionalAddresses: (c.field('additionalAddresses')?.items() ?? [])
      .map((entry) => {
        const inner = entry.field('address')
        return inner ? socketAddress(inner) : undefined
      })
      .filter((a): a is SocketAddress => a !== undefined),
    trafficDirection: c
      .field('trafficDirection')
      ?.enumOf(TRAFFIC_DIRECTIONS),
    perConnectionBufferLimitBytes: c.numAt('perConnectionBufferLimitBytes'),
    bindToPort: c.field('bindToPort')?.bool(),
    statPrefix: c.strAt('statPrefix'),
    listenerFiltersTimeout: c.strAt('listenerFiltersTimeout'),
    continueOnListenerFiltersTimeout: c.field('continueOnListenerFiltersTimeout')?.bool(),
    enableReusePort: c.field('enableReusePort')?.bool(),
    tcpBacklogSize: c.numAt('tcpBacklogSize'),
    accessLogNames: logs.map((log) => log.strAt('name')).filter((n): n is string => n !== undefined),
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

/** `region/zone/sub_zone`, with the parts that were written and no empty separators. */
function localityOf(c: Cursor | undefined): string | undefined {
  if (!c) return undefined
  const parts = [c.strAt('region'), c.strAt('zone'), c.strAt('subZone')].filter(
    (p): p is string => p !== undefined && p !== '',
  )
  return parts.length === 0 ? undefined : parts.join('/')
}

function endpointsOf(c: Cursor): Endpoint[] {
  const out: Endpoint[] = []
  // Redundant with the enclosing cluster's own name, and required to equal it. Read so
  // that a field present in every Envoy example does not show up as unrecognised.
  c.field('clusterName')
  // How Envoy spreads load across the localities below, and how it degrades when they are
  // unhealthy. Read for presence: it is a real policy and not a question about which
  // endpoints exist.
  c.field('policy')?.acknowledge()

  for (const group of c.field('endpoints')?.items() ?? []) {
    // A locality's own weight and priority describe the group rather than any one endpoint,
    // and both are carried down: "this endpoint is in us-east-1a at priority 1" is the
    // sentence somebody reading a failover config is trying to assemble, and it cannot be
    // assembled from the endpoint alone.
    const locality = localityOf(group.field('locality'))
    const priority = group.numAt('priority')
    const groupWeight = group.numAt('loadBalancingWeight')
    group.field('lbEndpointsPolicy')?.acknowledge()
    group.field('leastRequestLbConfig')?.acknowledge()

    for (const lb of group.field('lbEndpoints')?.items() ?? []) {
      // Endpoint metadata is how a subset load balancer picks between them, which is a
      // question about the balancer rather than about the endpoint.
      lb.field('metadata')?.acknowledge()
      const weight = lb.numAt('loadBalancingWeight')
      const healthStatus = lb.strAt('healthStatus')

      const endpoint = lb.field('endpoint')
      // The port health checking uses when it differs from the serving port. Read and left.
      endpoint?.field('healthCheckConfig')?.acknowledge()
      endpoint?.field('additionalAddresses')?.acknowledge()
      const hostname = endpoint?.strAt('hostname')

      const address = endpoint?.field('address')
      if (!address) continue
      const sock = socketAddress(address)
      if (!sock) continue

      out.push({
        ...sock,
        hostname,
        healthStatus,
        loadBalancingWeight: weight ?? groupWeight,
        locality,
        priority,
      })
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
    // The load balancer's own settings, the upstream socket options, and the protocol
    // blocks that predate `typed_extension_protocol_options`. Every one of them is tuning
    // for a cluster whose identity and endpoints are already read above.
    ...(
      [
        'commonLbConfig',
        'lbSubsetConfig',
        'ringHashLbConfig',
        'maglevLbConfig',
        'leastRequestLbConfig',
        'roundRobinLbConfig',
        'loadBalancingPolicy',
        'upstreamConnectionOptions',
        'upstreamBindConfig',
        'transportSocketMatches',
        'dnsResolvers',
        'typedDnsResolverConfig',
        'httpProtocolOptions',
        'http2ProtocolOptions',
        'commonHttpProtocolOptions',
        'upstreamHttpProtocolOptions',
        'preconnectPolicy',
        'metadata',
        'filters',
        // Deprecated, or about the lifecycle of the connection pool rather than about who
        // is in the cluster. Read so they land in "read but not checked", which is what a
        // deprecated field Attaché has no opinion on actually is.
        'protocolSelection',
        'closeConnectionsOnHostHealthFailure',
        'trackClusterStats',
        'trackTimeoutBudgets',
        'waitForWarmOnInit',
        'cleanupInterval',
        'useTcpForDnsLookups',
        'dnsFailureRefreshRate',
        'dnsJitter',
        'connectionPoolPerDownstreamConnection',
      ] as const
    ).map((name) => c.field(name)),
  ]) {
    block?.acknowledge()
  }

  // Scalars, so they cannot be acknowledged into the read-but-not-checked list — a scalar
  // is reported only when nobody asks for it. Read into the model instead, which is the
  // honest half of the same choice: they are available to anything that wants to show them
  // rather than swallowed on the way past.
  return {
    ...sourced(c),
    name: c.require('name', 'Routes and stats refer to a cluster by name.')?.str(),
    type,
    lbPolicy: c.strAt('lbPolicy'),
    connectTimeout: c.strAt('connectTimeout'),
    dnsLookupFamily: c.strAt('dnsLookupFamily'),
    dnsRefreshRate: c.strAt('dnsRefreshRate'),
    respectDnsTtl: c.field('respectDnsTtl')?.bool(),
    perConnectionBufferLimitBytes: c.numAt('perConnectionBufferLimitBytes'),
    maxRequestsPerConnection: c.numAt('maxRequestsPerConnection'),
    ignoreHealthOnHostRemoval: c.field('ignoreHealthOnHostRemoval')?.bool(),
    altStatName: c.strAt('altStatName'),
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

  // The admin interface keeps its own access log, separate from any listener's. Where a log
  // line lands is not something this can follow, so it is read for presence like the rest.
  admin?.field('accessLog')?.acknowledge()
  admin?.field('profilePath')?.acknowledge()
  admin?.field('ignoreGlobalConnLimit')?.acknowledge()

  // How this Envoy describes itself to a management server, beyond the two names that
  // identify it. The locality is what a mesh keys locality-aware routing on and the metadata
  // is whatever the control plane agreed to put there; neither is readable from here.
  for (const name of [
    'metadata',
    'locality',
    'userAgentName',
    'userAgentBuildVersion',
    'extensions',
    'clientFeatures',
    'dynamicParameters',
  ] as const) {
    node?.field(name)?.acknowledge()
  }

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

/**
 * The bootstrap blocks that sit beside `static_resources` and are none of this package's
 * business.
 *
 * Runtime layers, stats sinks, the overload manager, the watchdogs: every one is documented
 * Envoy, ordinary on a real deployment, and about how the process behaves rather than about
 * where a request goes. They are read by name so they land in "read but not checked", which
 * is what they are, instead of in the list that is supposed to read as "one of these might
 * be your typo".
 */
const BOOTSTRAP_BLOCKS = [
  'layeredRuntime',
  'runtime',
  'clusterManager',
  'statsSinks',
  'statsConfig',
  'statsFlushInterval',
  'statsFlushOnAdmin',
  'tracing',
  'overloadManager',
  'watchdog',
  'watchdogs',
  'hdsConfig',
  'flagsPath',
  'defaultRegexEngine',
  'bootstrapExtensions',
  'fatalActions',
  'applicationLogConfig',
  'enableDispatcherStats',
  'headerPrefix',
  'useTcpForDnsLookups',
  'typedDnsResolverConfig',
  'defaultSocketInterface',
  'inlineHeaders',
  'perfTracingFilePath',
] as const

/** A plain bootstrap: listeners and clusters live under `static_resources`. */
function fromBootstrap(root: Cursor): {
  listeners: Cursor[]
  clusters: Cursor[]
  routeConfigs: Cursor[]
  bootstrap?: Bootstrap
} {
  for (const name of BOOTSTRAP_BLOCKS) root.field(name)?.acknowledge()

  const stat = root.field('staticResources')
  // Secrets are certificates and keys. Named, never opened — `redact.ts` is the only thing
  // here that goes near key material, and it walks the raw document rather than the model.
  stat?.field('secrets')?.acknowledge()

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
