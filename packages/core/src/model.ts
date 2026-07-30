import type { Cursor } from './cursor.js'
import { cursorOver } from './cursor.js'
import type { Diagnostic, Unknown } from './diagnostics.js'
import type { ParseResult } from './parse.js'
import type {
  Cluster,
  ConfigModel,
  Endpoint,
  FilterChain,
  FilterChainMatch,
  HeaderMatcher,
  HeaderMatchKind,
  HttpConnectionManager,
  Listener,
  PathSpecifier,
  QueryMatcher,
  Route,
  RouteAction,
  RouteConfig,
  RouteMatch,
  SocketAddress,
  TlsContext,
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
    // the only engine. Consumed so it does not surface as an unrecognised field.
    safeRegex.field('googleRe2')
    const regex = safeRegex.strAt('regex')
    if (regex !== undefined) return { kind: 'safeRegex', value: regex }
  }

  // Read so they are not reported as unrecognised, but not evaluated.
  if (c.field('connectMatcher')) return { kind: 'unmodelled', label: 'connect_matcher' }
  if (c.field('pathMatchPolicy')) return { kind: 'unmodelled', label: 'path_match_policy' }

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
        safeRegex.field('googleRe2')
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
      safeRegexMatch.field('googleRe2')
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

  // A matcher with a name and nothing else is a presence check.
  if (value === undefined && kind === 'unmodelled' && !c.field('rangeMatch')) {
    kind = 'present'
  }

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

  if (c.field('redirect')) return { kind: 'redirect' }

  const direct = c.field('directResponse')
  if (direct) return { kind: 'directResponse', status: direct.numAt('status') }

  return { kind: 'unmodelled', label: 'no action' }
}

function route(c: Cursor): Route {
  const match = c.require('match', 'Without it Envoy cannot decide whether this route applies.')
  return {
    ...sourced(c),
    name: c.strAt('name'),
    match: match ? routeMatch(match) : { ...sourced(c), pathSpec: { kind: 'none' }, caseSensitive: true, headers: [], queryParameters: [] },
    action: routeAction(c),
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

function httpConnectionManager(c: Cursor): HttpConnectionManager {
  const inline = c.field('routeConfig')
  const rds = c.field('rds')

  return {
    ...sourced(c),
    statPrefix: c.strAt('statPrefix'),
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
  const type = c.field('type')?.enumOf([
    'STATIC',
    'STRICT_DNS',
    'LOGICAL_DNS',
    'EDS',
    'ORIGINAL_DST',
  ] as const)
  const eds = c.field('edsClusterConfig')
  const assignment = c.field('loadAssignment')
  const socket = c.field('transportSocket')

  // Presence, not contents. Whether a cluster has health checking at all is worth showing
  // next to it in the graph; whether the interval is sensible is a judgement this package
  // is not in a position to make, and the fields stay reported as unchecked.
  const healthChecks = c.field('healthChecks')
  const circuitBreakers = c.field('circuitBreakers')
  const outlierDetection = c.field('outlierDetection')
  for (const block of [healthChecks, circuitBreakers, outlierDetection]) block?.unmodelled()

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

/** A plain bootstrap: listeners and clusters live under `static_resources`. */
function fromBootstrap(root: Cursor): {
  listeners: Cursor[]
  clusters: Cursor[]
  routeConfigs: Cursor[]
} {
  const stat = root.field('staticResources')
  return {
    listeners: stat?.field('listeners')?.items() ?? [],
    clusters: stat?.field('clusters')?.items() ?? [],
    routeConfigs: [],
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
} {
  const listeners: Cursor[] = []
  const clusters: Cursor[] = []
  const routeConfigs: Cursor[] = []

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
      const bootstrap = config.field('bootstrap')
      if (bootstrap) {
        const inner = fromBootstrap(bootstrap)
        listeners.push(...inner.listeners)
        clusters.push(...inner.clusters)
      }
    } else {
      // Scoped routes, secrets, endpoints — envelopes this package has no model for.
      config.unmodelled()
    }
  }

  return { listeners, clusters, routeConfigs }
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
  }

  return { model, diagnostics, unknowns: root.collectUnknowns() }
}
