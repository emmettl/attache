import type {
  ConfigModel,
  FilterChain,
  Listener,
  Route,
  RouteAction,
  RouteConfig,
  VirtualHost,
} from './types.js'

// Where does this request actually go?
//
// The question the tool exists to answer, and the one a config does not answer by being
// read. Envoy's selection is a cascade — listener, then filter chain, then virtual host,
// then route — and only the last of those is in the order the file is written. The other
// three are decided by specificity rules that live in Envoy's source and its docs, not in
// anybody's YAML.
//
// So the return value is not a cluster name. It is every decision, each with the
// alternatives it beat and why, because "it went to the wrong place" is almost never a
// question about the winner and almost always a question about the loser.

export interface TestRequest {
  /** `:authority` — the Host header. Port included if the client sent one. */
  authority: string
  /** `:path`, query string and all. Split out where matching calls for it. */
  path: string
  /** `:method`. */
  method: string
  /** The local port the connection arrived on. Selects the listener. */
  port?: number
  /** SNI, for filter chain selection on a TLS listener. */
  serverName?: string
  /** Everything else. Lower-cased on the way in. */
  headers: Record<string, string>
}

export type Outcome =
  | 'matched'
  | 'no-listener'
  | 'no-filter-chain'
  | 'not-http'
  | 'routes-elsewhere'
  | 'no-virtual-host'
  | 'no-route'

export interface Attempt<T> {
  candidate: T
  index: number
  matched: boolean
  /** Why it lost. Absent on the winner. */
  reason?: string
}

export type DomainPrecedence = 'exact' | 'suffix-wildcard' | 'prefix-wildcard' | 'any'

export interface MatchResult {
  outcome: Outcome
  /**
   * What happened, in a sentence — occasionally two, when the winning route also turns an
   * HTTP filter off, which is worth a clause of its own rather than a subordinate one.
   */
  explanation: string
  /**
   * Where this answer may differ from Envoy's, and why. Empty when nothing was skipped.
   * Non-empty means the result is a best effort, and the UI should say so.
   */
  caveats: string[]

  listener?: Listener
  listenerAttempts: Attempt<Listener>[]

  filterChain?: FilterChain
  chainAttempts: Attempt<FilterChain>[]

  routeConfig?: RouteConfig

  virtualHost?: VirtualHost
  hostAttempts: Attempt<VirtualHost>[]
  /** Which domain pattern selected the virtual host, and at what precedence. */
  domainMatch?: { pattern: string; precedence: DomainPrecedence }

  route?: Route
  routeIndex?: number
  routeAttempts: Attempt<Route>[]

  /** The upstream, when the winning route names one outright. */
  cluster?: string
}

// ---- small helpers ----------------------------------------------------------------

/** The path with any query string removed. */
export function pathOnly(path: string): string {
  const cut = path.indexOf('?')
  return cut === -1 ? path : path.slice(0, cut)
}

/**
 * The query string as a lookup.
 *
 * Hand-rolled rather than `URLSearchParams`, which is a host global and not part of the
 * language: this package compiles without `DOM` in its `lib` precisely so that it cannot
 * reach for one by accident, and making an exception for a twelve-line parser would give
 * that up for nothing.
 *
 * First value wins on a repeated key, which is what Envoy does.
 */
function queryOf(path: string): Map<string, string> {
  const out = new Map<string, string>()
  const cut = path.indexOf('?')
  if (cut === -1) return out

  for (const pair of path.slice(cut + 1).split('&')) {
    if (pair === '') continue
    const equals = pair.indexOf('=')
    const rawKey = equals === -1 ? pair : pair.slice(0, equals)
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1)
    const key = decode(rawKey)
    if (!out.has(key)) out.set(key, decode(rawValue))
  }
  return out
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '))
  } catch {
    // A stray `%` that is not an escape. Envoy would see the same bytes, so keep them.
    return value
  }
}

const fold = (value: string, caseSensitive: boolean) =>
  caseSensitive ? value : value.toLowerCase()

/** RE2 is anchored at both ends for route matching; JS regexes are not. */
function fullMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`).test(value)
  } catch {
    // An invalid regex matches nothing rather than throwing out of the matcher. It is
    // already reported as a diagnostic; taking the whole route test down for it would
    // hide every other answer on the page.
    return false
  }
}

// ---- domains ----------------------------------------------------------------------

interface DomainScore {
  pattern: string
  precedence: DomainPrecedence
  /** Longer wildcards beat shorter ones. */
  length: number
}

/**
 * Envoy's virtual host domain search order.
 *
 * From most to least specific: an exact name, then a suffix wildcard (`*.foo.com`), then a
 * prefix wildcard (`foo.*`), then the catch-all `*` — and within the wildcard classes, the
 * longest pattern wins. This is emphatically NOT declaration order, which is the single
 * most common wrong intuition about Envoy routing: moving a virtual host up the file
 * changes nothing, and people lose afternoons to that.
 */
function scoreDomain(pattern: string, authority: string): DomainScore | null {
  const domain = pattern.toLowerCase()
  const host = authority.toLowerCase()

  if (domain === '*') return { pattern, precedence: 'any', length: 0 }
  if (domain === host) return { pattern, precedence: 'exact', length: domain.length }

  if (domain.startsWith('*') && domain.length > 1) {
    const rest = domain.slice(1)
    // `*.foo.com` must not match `foo.com` itself: the wildcard stands for at least one
    // character, so the host has to be strictly longer than what follows the star.
    if (host.length > rest.length && host.endsWith(rest)) {
      return { pattern, precedence: 'suffix-wildcard', length: rest.length }
    }
    return null
  }

  if (domain.endsWith('*') && domain.length > 1) {
    const rest = domain.slice(0, -1)
    if (host.length > rest.length && host.startsWith(rest)) {
      return { pattern, precedence: 'prefix-wildcard', length: rest.length }
    }
    return null
  }

  return null
}

const PRECEDENCE_RANK: Record<DomainPrecedence, number> = {
  exact: 3,
  'suffix-wildcard': 2,
  'prefix-wildcard': 1,
  any: 0,
}

function bestDomain(host: VirtualHost, authority: string): DomainScore | null {
  let best: DomainScore | null = null
  for (const pattern of host.domains) {
    const score = scoreDomain(pattern, authority)
    if (!score) continue
    if (
      best === null ||
      PRECEDENCE_RANK[score.precedence] > PRECEDENCE_RANK[best.precedence] ||
      (PRECEDENCE_RANK[score.precedence] === PRECEDENCE_RANK[best.precedence] &&
        score.length > best.length)
    ) {
      best = score
    }
  }
  return best
}

// ---- route matching ---------------------------------------------------------------

/** Why a route did not match, or undefined if it did. */
function whyNotRoute(route: Route, request: TestRequest): string | undefined {
  const spec = route.match.pathSpec
  const sensitive = route.match.caseSensitive
  const path = fold(pathOnly(request.path), sensitive)

  switch (spec.kind) {
    case 'prefix': {
      if (!path.startsWith(fold(spec.value, sensitive))) {
        return `the path is not under \`${spec.value}\``
      }
      break
    }
    case 'path': {
      if (path !== fold(spec.value, sensitive)) return `the path is not exactly \`${spec.value}\``
      break
    }
    case 'pathSeparatedPrefix': {
      const prefix = fold(spec.value, sensitive)
      if (path !== prefix && !path.startsWith(`${prefix}/`)) {
        return `the path is not \`${spec.value}\` or a path segment below it`
      }
      break
    }
    case 'safeRegex': {
      if (!fullMatch(spec.value, pathOnly(request.path))) {
        return `the path does not match \`${spec.value}\``
      }
      break
    }
    case 'unmodelled':
      return `its \`${spec.label}\` is not evaluated here`
    case 'none':
      return 'it has no path to match on'
  }

  // Pseudo-headers are matchable like any other, and matching on `:method` is the ordinary
  // way to route a POST differently from a GET — so they go in the same bag.
  const headers: Record<string, string> = {
    ...request.headers,
    ':authority': request.authority,
    ':path': request.path,
    ':method': request.method,
  }

  for (const matcher of route.match.headers) {
    const name = matcher.name.toLowerCase()
    const value = headers[name]
    const present = value !== undefined

    let holds: boolean
    if (matcher.kind === 'present') holds = present
    else if (!present) holds = matcher.treatMissingAsEmpty ? matchString(matcher.kind, matcher.value ?? '', '') : false
    else holds = matchString(matcher.kind, matcher.value ?? '', value)

    if (matcher.kind === 'unmodelled') {
      return `its \`${matcher.name}\` header matcher is not evaluated here`
    }

    if (holds === matcher.invert) {
      return matcher.invert
        ? `header \`${matcher.name}\` matches \`${matcher.value ?? ''}\`, and this route requires it not to`
        : present
          ? `header \`${matcher.name}\` is \`${value}\``
          : `header \`${matcher.name}\` is missing`
    }
  }

  const query = queryOf(request.path)
  for (const matcher of route.match.queryParameters) {
    const value = query.get(matcher.name)
    if (matcher.kind === 'present') {
      if (value === undefined) return `the query has no \`${matcher.name}\``
      continue
    }
    if (matcher.kind === 'unmodelled') {
      return `its \`${matcher.name}\` query matcher is not evaluated here`
    }
    if (value === undefined) return `the query has no \`${matcher.name}\``
    if (!matchString(matcher.kind, matcher.value ?? '', value)) {
      return `query \`${matcher.name}\` is \`${value}\``
    }
  }

  return undefined
}

function matchString(
  kind: 'exact' | 'prefix' | 'suffix' | 'contains' | 'safeRegex' | 'present' | 'unmodelled',
  pattern: string,
  value: string,
): boolean {
  switch (kind) {
    case 'exact':
      return value === pattern
    case 'prefix':
      return value.startsWith(pattern)
    case 'suffix':
      return value.endsWith(pattern)
    case 'contains':
      return value.includes(pattern)
    case 'safeRegex':
      return fullMatch(pattern, value)
    case 'present':
      return true
    case 'unmodelled':
      return false
  }
}

// ---- filter chains ------------------------------------------------------------------

/** SNI supports one leading wildcard, and an exact name beats it. */
function serverNameRank(patterns: string[], sni: string | undefined): number | null {
  if (patterns.length === 0) return 0 // no criterion — matches anything, least specific
  if (sni === undefined) return null
  const host = sni.toLowerCase()
  let best: number | null = null
  for (const pattern of patterns) {
    const domain = pattern.toLowerCase()
    if (domain === host) return 1000
    if (domain.startsWith('*.')) {
      const rest = domain.slice(1)
      if (host.length > rest.length && host.endsWith(rest)) {
        best = Math.max(best ?? 0, rest.length)
      }
    }
  }
  return best
}

/**
 * Envoy narrows chains one criterion at a time, most specific first, rather than scoring
 * them all at once. The order below is Envoy's, restricted to the criteria this package
 * models — destination port, SNI, transport protocol, application protocol. The ones it
 * skips are all CIDR-based, and a chain that uses them is flagged rather than guessed at.
 */
function selectChain(
  listener: Listener,
  request: TestRequest,
): { chosen?: FilterChain; attempts: Attempt<FilterChain>[]; caveats: string[] } {
  const caveats: string[] = []
  const attempts: Attempt<FilterChain>[] = []

  interface Candidate {
    chain: FilterChain
    index: number
    port: number
    sni: number
    transport: number
    application: number
  }

  const candidates: Candidate[] = []

  listener.filterChains.forEach((chain, index) => {
    const match = chain.match
    if (match?.hasUnmodelledCriteria) {
      caveats.push(
        `Filter chain ${index + 1} also matches on criteria this tester does not evaluate (source or destination IP ranges), so Envoy might not pick the chain shown.`,
      )
    }

    if (!match) {
      candidates.push({ chain, index, port: 0, sni: 0, transport: 0, application: 0 })
      return
    }

    if (match.destinationPort !== undefined && match.destinationPort !== request.port) {
      attempts.push({
        candidate: chain,
        index,
        matched: false,
        reason: `it wants destination port ${match.destinationPort}`,
      })
      return
    }

    const sni = serverNameRank(match.serverNames, request.serverName)
    if (sni === null) {
      attempts.push({
        candidate: chain,
        index,
        matched: false,
        reason:
          request.serverName === undefined
            ? `it wants SNI ${match.serverNames.join(' or ')} and the request sent none`
            : `its SNI ${match.serverNames.join(' or ')} does not cover \`${request.serverName}\``,
      })
      return
    }

    if (
      match.transportProtocol !== undefined &&
      match.transportProtocol !== (request.serverName === undefined ? 'raw_buffer' : 'tls')
    ) {
      attempts.push({
        candidate: chain,
        index,
        matched: false,
        reason: `it wants transport protocol \`${match.transportProtocol}\``,
      })
      return
    }

    candidates.push({
      chain,
      index,
      port: match.destinationPort === undefined ? 0 : 1,
      sni,
      transport: match.transportProtocol === undefined ? 0 : 1,
      application: match.applicationProtocols.length === 0 ? 0 : 1,
    })
  })

  if (candidates.length === 0) {
    if (listener.defaultFilterChain) {
      return { chosen: listener.defaultFilterChain, attempts, caveats }
    }
    return { attempts, caveats }
  }

  const order: (keyof Candidate)[] = ['port', 'sni', 'transport', 'application']
  let narrowed = candidates
  for (const criterion of order) {
    const best = Math.max(...narrowed.map((c) => c[criterion] as number))
    narrowed = narrowed.filter((c) => (c[criterion] as number) === best)
  }

  const winner = narrowed[0]!
  for (const candidate of candidates) {
    attempts.push({
      candidate: candidate.chain,
      index: candidate.index,
      matched: candidate.index === winner.index,
      reason:
        candidate.index === winner.index ? undefined : 'another chain matched more specifically',
    })
  }
  attempts.sort((a, b) => a.index - b.index)

  return { chosen: winner.chain, attempts, caveats }
}

// ---- the whole cascade ----------------------------------------------------------------

const empty = (outcome: Outcome, explanation: string, extra: Partial<MatchResult> = {}): MatchResult => ({
  outcome,
  explanation,
  caveats: [],
  listenerAttempts: [],
  chainAttempts: [],
  hostAttempts: [],
  routeAttempts: [],
  ...extra,
})

export function matchRequest(model: ConfigModel, request: TestRequest): MatchResult {
  const caveats: string[] = []

  // ---- listener ---------------------------------------------------------------
  const listenerAttempts: Attempt<Listener>[] = model.listeners.map((listener, index) => {
    const port = listener.address?.portValue
    const matched = request.port === undefined ? model.listeners.length === 1 : port === request.port
    return {
      candidate: listener,
      index,
      matched,
      reason: matched ? undefined : `it listens on port ${port ?? 'nothing this tester can read'}`,
    }
  })

  const listener = listenerAttempts.find((a) => a.matched)?.candidate
  if (!listener) {
    return empty(
      'no-listener',
      request.port === undefined
        ? 'This config has more than one listener, so the request needs a port to pick between them.'
        : `Nothing is listening on port ${request.port}.`,
      { listenerAttempts },
    )
  }

  // ---- filter chain -----------------------------------------------------------
  const chain = selectChain(listener, request)
  caveats.push(...chain.caveats)

  if (!chain.chosen) {
    return {
      ...empty('no-filter-chain', 'No filter chain on this listener accepts the connection.'),
      caveats,
      listener,
      listenerAttempts,
      chainAttempts: chain.attempts,
    }
  }

  const base = {
    caveats,
    listener,
    listenerAttempts,
    filterChain: chain.chosen,
    chainAttempts: chain.attempts,
  }

  const hcm = chain.chosen.hcm
  if (!hcm) {
    return {
      ...empty('not-http', 'This filter chain has no HTTP connection manager, so there are no HTTP routes to match.'),
      ...base,
    }
  }

  // ---- route config -----------------------------------------------------------
  let routeConfig = hcm.routeConfig
  if (!routeConfig && hcm.rdsRouteConfigName !== undefined) {
    routeConfig = model.routeConfigs.find((r) => r.name === hcm.rdsRouteConfigName)
  }

  if (!routeConfig) {
    return {
      ...empty(
        'routes-elsewhere',
        hcm.rdsRouteConfigName === undefined
          ? 'This HTTP connection manager has no routes at all.'
          : `Routes for this listener arrive over RDS as \`${hcm.rdsRouteConfigName}\`, and are not in this config.`,
      ),
      ...base,
    }
  }

  // ---- virtual host -----------------------------------------------------------
  const scored = routeConfig.virtualHosts.map((host, index) => ({
    host,
    index,
    score: bestDomain(host, request.authority),
  }))

  let winner: (typeof scored)[number] | undefined
  for (const entry of scored) {
    if (!entry.score) continue
    if (
      !winner?.score ||
      PRECEDENCE_RANK[entry.score.precedence] > PRECEDENCE_RANK[winner.score.precedence] ||
      (PRECEDENCE_RANK[entry.score.precedence] === PRECEDENCE_RANK[winner.score.precedence] &&
        entry.score.length > winner.score.length)
    ) {
      winner = entry
    }
  }

  const hostAttempts: Attempt<VirtualHost>[] = scored.map((entry) => ({
    candidate: entry.host,
    index: entry.index,
    matched: entry.index === winner?.index,
    reason:
      entry.index === winner?.index
        ? undefined
        : entry.score
          ? `\`${winner!.score!.pattern}\` on \`${winner!.host.name ?? 'another virtual host'}\` is more specific than \`${entry.score.pattern}\``
          : `none of its domains cover \`${request.authority}\``,
  }))

  if (!winner) {
    return {
      ...empty(
        'no-virtual-host',
        `No virtual host in \`${routeConfig.name ?? 'this route config'}\` claims \`${request.authority}\` — Envoy would return 404.`,
      ),
      ...base,
      routeConfig,
      hostAttempts,
    }
  }

  const withHost = {
    ...base,
    routeConfig,
    virtualHost: winner.host,
    hostAttempts,
    domainMatch: { pattern: winner.score!.pattern, precedence: winner.score!.precedence },
  }

  // ---- route ------------------------------------------------------------------
  const routeAttempts: Attempt<Route>[] = []
  for (const [index, route] of winner.host.routes.entries()) {
    const why = whyNotRoute(route, request)
    routeAttempts.push({ candidate: route, index, matched: why === undefined, reason: why })
    if (why !== undefined) continue

    const action = route.action
    const cluster =
      action.kind === 'cluster'
        ? action.cluster
        : action.kind === 'weightedClusters'
          ? action.clusters[0]?.name
          : undefined

    if (action.kind === 'weightedClusters') {
      caveats.push(
        `The winning route splits traffic across ${action.clusters.map((c) => `\`${c.name}\``).join(', ')} by weight, so which upstream a given request reaches is decided at request time.`,
      )
    }
    if (action.kind === 'clusterHeader') {
      caveats.push(
        `The winning route takes its cluster from the \`${action.header}\` header, so the upstream cannot be read from the config.`,
      )
    }

    return {
      ...empty('matched', ''),
      ...withHost,
      caveats,
      route,
      routeIndex: index,
      routeAttempts,
      cluster,
      explanation: describe(route, index, winner.host, request, cluster),
    }
  }

  return {
    ...empty(
      'no-route',
      `\`${winner.host.name ?? 'The matching virtual host'}\` has no route for \`${request.method} ${request.path}\` — Envoy would return 404.`,
    ),
    ...withHost,
    caveats,
    routeAttempts,
  }
}

/** Envoy's `RedirectResponseCode` names, as the status numbers people think in. */
const REDIRECT_CODES: Record<string, number> = {
  MOVED_PERMANENTLY: 301,
  FOUND: 302,
  SEE_OTHER: 303,
  TEMPORARY_REDIRECT: 307,
  PERMANENT_REDIRECT: 308,
}

/**
 * Where a redirect actually sends this request.
 *
 * The tester used to say a route "redirects rather than proxying" and stop, which is the
 * least useful true sentence available about it: somebody who has just tested a request
 * against a redirect route wants the `Location` it would get back, and every part of that is
 * sitting in the config beside the part that was already being read.
 *
 * Envoy fills in whatever the redirect does not name from the request itself, so this does
 * too — the host, the path and the scheme are the incoming ones unless overridden. That
 * makes the answer specific to the request being tested rather than a restatement of the
 * config, which is the whole difference between this tester and reading the YAML.
 */
function redirectTarget(
  action: Extract<RouteAction, { kind: 'redirect' }>,
  route: Route,
  request: TestRequest,
): string {
  const scheme =
    action.schemeRedirect ?? (action.httpsRedirect === true ? 'https' : undefined)

  const host = action.hostRedirect ?? request.authority
  const port = action.portRedirect === undefined ? '' : `:${action.portRedirect}`

  const spec = route.match.pathSpec
  const incoming = action.stripQuery === true ? pathOnly(request.path) : request.path
  const path =
    action.pathRedirect ??
    // `prefix_rewrite` on a redirect replaces the part of the path the route matched, which
    // means the answer depends on the matcher as well as the action. Only a prefix match has
    // a well-defined "part that matched" to swap out; for anything else the honest thing is
    // to leave the path alone rather than guess at what Envoy would splice.
    (action.prefixRewrite !== undefined && spec.kind === 'prefix'
      ? `${action.prefixRewrite}${incoming.slice(spec.value.length)}`
      : incoming)

  return `${scheme === undefined ? '' : `${scheme}://`}${host}${port}${path}`
}

/**
 * What a route's per-filter overrides do, as a sentence, or nothing when it has none.
 *
 * Switching `ext_authz` off for one route is how a health endpoint is kept out of the
 * authorization path, and it leaves no trace in the route's match — so somebody asking why
 * a request sailed past the authorization filter has no way to see it in the part of the
 * config they would think to read. That makes it routing-adjacent enough to belong in the
 * answer rather than in the list of things this package did not look at.
 */
function overrides(route: Route): string {
  const names = (subset: typeof route.typedPerFilterConfig) =>
    subset.map((f) => `\`${f.name}\``).join(', ')

  const off = route.typedPerFilterConfig.filter((f) => f.disabled)
  const changed = route.typedPerFilterConfig.filter((f) => !f.disabled)

  const clauses: string[] = []
  if (off.length > 0) clauses.push(`disables ${names(off)}`)
  if (changed.length > 0) clauses.push(`overrides the configuration of ${names(changed)}`)

  return clauses.length === 0 ? '' : ` This route ${clauses.join(', and ')}.`
}

function describe(
  route: Route,
  index: number,
  host: VirtualHost,
  request: TestRequest,
  cluster?: string,
): string {
  const where = `route ${index + 1}${route.name ? ` (\`${route.name}\`)` : ''} of \`${host.name ?? 'the matching virtual host'}\``
  const also = overrides(route)

  switch (route.action.kind) {
    case 'cluster':
    case 'weightedClusters':
      return `Matched ${where} → cluster \`${cluster}\`.${also}`
    case 'clusterHeader':
      return `Matched ${where}, which picks its cluster from the \`${route.action.header}\` header.${also}`
    case 'redirect': {
      const code = route.action.responseCode
      const status = code === undefined ? '' : ` with ${REDIRECT_CODES[code] ?? code}`
      return `Matched ${where}, which redirects to \`${redirectTarget(route.action, route, request)}\`${status}.${also}`
    }
    case 'directResponse': {
      const body = route.action.body
      const returning =
        body?.inline !== undefined
          ? ` and the body \`${abbreviate(body.inline)}\``
          : body?.filename !== undefined
            ? ` and the contents of \`${body.filename}\``
            : ''
      return `Matched ${where}, which answers directly with ${route.action.status ?? 'a fixed status'}${returning}.${also}`
    }
    case 'unmodelled':
      return `Matched ${where}, whose action this tester does not model.${also}`
  }
}

/**
 * A direct response body, shortened to fit in a sentence.
 *
 * Most of them are a line of JSON or the word "OK", and showing those in full is the point.
 * The ones that are not are usually a whole HTML error page, and a verdict line is not where
 * anybody wants to read one — so it is cut, and cut visibly, rather than being allowed to
 * push the rest of the sentence off screen.
 */
function abbreviate(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= 60 ? flat : `${flat.slice(0, 57)}…`
}
