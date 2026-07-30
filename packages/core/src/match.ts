import type {
  ConfigModel,
  FilterChain,
  HttpConnectionManager,
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
  /** The chain forwards the connection to an upstream without reading HTTP at all. */
  | 'tcp-proxy'
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
  /**
   * What the connection manager did to the request before any of the routing below.
   *
   * Separate from `caveats` because it is the opposite kind of statement. A caveat says the
   * answer might be wrong; each of these says the answer is right and here is the step that
   * would otherwise make it look wrong — a request to `//api//v1` matching `prefix: /api/v1`
   * is bewildering until you are told the slashes were merged four fields above the route.
   */
  rewrites: string[]

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

/**
 * `/a//b` → `/a/b`, leaving the query alone.
 *
 * Envoy's `merge_slashes`, which runs before route matching and therefore before anything
 * this file does. Only the path is touched: a doubled slash inside a query value is data.
 */
function mergeSlashes(path: string): string {
  const cut = path.indexOf('?')
  const head = cut === -1 ? path : path.slice(0, cut)
  const tail = cut === -1 ? '' : path.slice(cut)
  return `${head.replace(/\/{2,}/g, '/')}${tail}`
}

/**
 * RFC 3986's `remove_dot_segments`, which is what Envoy's `normalize_path` performs.
 *
 * Applied rather than merely reported because it decides the answer: `/api/../admin` reaches
 * an `/admin` route on a listener that normalises and an `/api` route on one that does not,
 * and that difference is the whole question somebody is asking the tester.
 */
function removeDotSegments(path: string): string {
  const cut = path.indexOf('?')
  const head = cut === -1 ? path : path.slice(0, cut)
  const tail = cut === -1 ? '' : path.slice(cut)
  if (!head.startsWith('/')) return path

  const segments = head.split('/')
  const out: string[] = []
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i]!
    const last = i === segments.length - 1
    if (segment === '.') {
      // A trailing `.` or `..` leaves the directory slash behind: `/a/b/..` is `/a/`.
      if (last) out.push('')
      continue
    }
    if (segment === '..') {
      out.pop()
      if (last) out.push('')
      continue
    }
    out.push(segment)
  }
  return `/${out.join('/')}${tail}`
}

/**
 * `:authority` with the port removed, and the port that was on it.
 *
 * IPv6 literals are why this is not a `split(':')`: `[::1]:8080` has four colons and only
 * the last one separates a port.
 */
function splitAuthority(authority: string): { host: string; port?: number } {
  const cut = authority.lastIndexOf(':')
  if (cut === -1 || cut < authority.lastIndexOf(']')) return { host: authority }
  const digits = authority.slice(cut + 1)
  // `Number('')` is zero, so a trailing colon would otherwise read as port 0 and get
  // stripped as though the client had sent one.
  if (!/^\d+$/.test(digits)) return { host: authority }
  return { host: authority.slice(0, cut), port: Number(digits) }
}

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
    // Asked before the comparison rather than after it: `matchString` answers `false` for an
    // unmodelled kind, which is indistinguishable from a matcher that was evaluated and did
    // not hold, and the difference is the whole point of the kind existing.
    if (matcher.kind === 'unmodelled') {
      return `its \`${matcher.name}\` header matcher is not evaluated here`
    }

    const name = matcher.name.toLowerCase()
    const value = headers[name]
    const present = value !== undefined
    const compare = (against: string) =>
      matchString(matcher.kind, matcher.value ?? '', against, matcher.ignoreCase)

    let holds: boolean
    if (matcher.kind === 'present') holds = present
    else if (!present) holds = matcher.treatMissingAsEmpty ? compare('') : false
    else holds = compare(value)

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
    if (matcher.kind === 'unmodelled') {
      return matcher.label === undefined
        ? `its \`${matcher.name}\` query matcher is not evaluated here`
        : `its \`${matcher.name}\` query matcher writes \`${matcher.label}\`, which is not evaluated here`
    }
    const value = query.get(matcher.name)
    if (value === undefined) return `the query has no \`${matcher.name}\``
    if (matcher.kind === 'present') continue
    if (!matchString(matcher.kind, matcher.value ?? '', value, matcher.ignoreCase)) {
      return `query \`${matcher.name}\` is \`${value}\``
    }
  }

  return undefined
}

/**
 * One `StringMatcher` arm against one value.
 *
 * `ignoreCase` folds both sides for the four literal arms and is deliberately not applied to
 * the regex, which is where Envoy also stops applying it: RE2 carries its own case rules
 * inside the pattern.
 */
function matchString(
  kind: 'exact' | 'prefix' | 'suffix' | 'contains' | 'safeRegex' | 'present' | 'unmodelled',
  pattern: string,
  value: string,
  ignoreCase = false,
): boolean {
  const a = ignoreCase ? value.toLowerCase() : value
  const b = ignoreCase ? pattern.toLowerCase() : pattern

  switch (kind) {
    case 'exact':
      return a === b
    case 'prefix':
      return a.startsWith(b)
    case 'suffix':
      return a.endsWith(b)
    case 'contains':
      return a.includes(b)
    case 'safeRegex':
      return fullMatch(pattern, value)
    case 'present':
      return true
    case 'unmodelled':
      return false
  }
}

// ---- filter chains ------------------------------------------------------------------

/**
 * An exact name beats every wildcard, whatever their lengths.
 *
 * Expressed as a value nothing can reach rather than as a large one. It was 1000, against
 * wildcards scored by the length of what follows the star — so a pattern longer than a
 * thousand characters outranked an exact match. No DNS name gets near that, which makes it
 * a cliff nobody was going to fall off; it is gone because "the exact name wins" should be
 * a fact about the code rather than a fact about how long domains happen to be.
 */
const EXACT_SNI = Number.MAX_SAFE_INTEGER

/** SNI supports one leading wildcard, and an exact name beats it. */
function serverNameRank(patterns: string[], sni: string | undefined): number | null {
  if (patterns.length === 0) return 0 // no criterion — matches anything, least specific
  if (sni === undefined) return null
  const host = sni.toLowerCase()
  let best: number | null = null
  for (const pattern of patterns) {
    const domain = pattern.toLowerCase()
    if (domain === host) return EXACT_SNI
    if (domain.startsWith('*.')) {
      const rest = domain.slice(1)
      if (host.length > rest.length && host.endsWith(rest)) {
        // At least 2, since `rest` keeps the dot — so a wildcard can never score the 0 that
        // means "this chain states no SNI criterion at all".
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

    // Named where they can be named. "Also matches on `source_prefix_ranges`" sends somebody
    // to a line they can read; "matches on criteria this tester does not evaluate (source or
    // destination IP ranges)", which is what this said before, tells them only that the
    // answer might be wrong and leaves them to find out where.
    const unevaluated = [...(match?.unevaluatedCriteria ?? [])]
    // ALPN belongs on that list and was missing from it, which was not a cosmetic gap: a
    // chain naming `h2` counts as more specific than one naming nothing, so it WON — with
    // no caveat — against a request that never said what protocol it spoke. The tester was
    // answering for an HTTP/2 client and presenting it as the answer for every client.
    if ((match?.applicationProtocols.length ?? 0) > 0) unevaluated.push('application_protocols')

    if (unevaluated.length > 0 || match?.hasUnmodelledCriteria) {
      const on =
        unevaluated.length > 0
          ? `${unevaluated.map((n) => `\`${n}\``).join(', ')}, which this tester does not evaluate`
          : 'criteria this tester has no model for'
      caveats.push(
        `Filter chain ${index + 1} also matches on ${on}, so Envoy might not pick the chain shown.`,
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
  rewrites: [],
  listenerAttempts: [],
  chainAttempts: [],
  hostAttempts: [],
  routeAttempts: [],
  ...extra,
})

/**
 * The request as the router sees it, after the connection manager has had it.
 *
 * Only the two transformations with exactly one reading are applied. `path_with_escaped_
 * slashes_action` is stated instead: it percent-decodes and may answer with a redirect
 * rather than a route, and a tester that guessed at which would be inventing an answer where
 * a sentence was available.
 */
function normalise(
  request: TestRequest,
  hcm: HttpConnectionManager,
  listener: Listener,
  rewrites: string[],
  caveats: string[],
): TestRequest {
  let { path, authority } = request

  // `normalize_path` FIRST, then `merge_slashes`, which is the order Envoy's
  // `maybeNormalizePath` runs them in — canonicalPath, and only then mergeSlashes.
  //
  // The order is not cosmetic and this file had it backwards. `/a//../b` resolves to `/a/b`
  // the right way round, because the `..` cancels the empty segment the doubled slash made;
  // collapse first and the `..` eats `a` instead, giving `/b`. Two different routes, and the
  // tester was confidently naming the wrong one on any config that sets both.
  if (hcm.normalizePath === true) {
    const normalised = removeDotSegments(path)
    if (normalised !== path) {
      rewrites.push(`\`normalize_path\` resolved the path to \`${normalised}\` before routing.`)
      path = normalised
    }
  }

  if (hcm.mergeSlashes === true) {
    const merged = mergeSlashes(path)
    if (merged !== path) {
      rewrites.push(`\`merge_slashes\` collapsed the path to \`${merged}\` before routing.`)
      path = merged
    }
  }

  if (hcm.pathWithEscapedSlashesAction !== undefined && /%2f/i.test(path)) {
    caveats.push(
      `This listener sets \`path_with_escaped_slashes_action: ${hcm.pathWithEscapedSlashesAction}\` and the path contains an escaped slash, which this tester does not apply — Envoy may rewrite or redirect this request before any route sees it.`,
    )
  }

  const { host, port } = splitAuthority(authority)
  const stripped =
    hcm.stripAnyHostPort === true ||
    (hcm.stripMatchingHostPort === true && port !== undefined && portsOf(listener).includes(port))
  if (stripped && port !== undefined) {
    rewrites.push(
      `\`${hcm.stripAnyHostPort === true ? 'strip_any_host_port' : 'strip_matching_host_port'}\` removed \`:${port}\` from the authority, so virtual hosts are matched against \`${host}\`.`,
    )
    authority = host
  }

  return { ...request, path, authority }
}

/** Every port a listener accepts on, `address` and `additional_addresses` together. */
function portsOf(listener: Listener): number[] {
  return [listener.address, ...listener.additionalAddresses]
    .map((address) => address?.portValue)
    .filter((port): port is number => port !== undefined)
}

export function matchRequest(model: ConfigModel, request: TestRequest): MatchResult {
  const caveats: string[] = []
  const rewrites: string[] = []

  // ---- listener ---------------------------------------------------------------
  const listenerAttempts: Attempt<Listener>[] = model.listeners.map((listener, index) => {
    const ports = portsOf(listener)
    const matched =
      request.port === undefined ? model.listeners.length === 1 : ports.includes(request.port)
    return {
      candidate: listener,
      index,
      matched,
      reason: matched
        ? undefined
        : ports.length === 0
          ? 'its address is not one this tester can read a port from'
          : `it listens on port ${ports.join(' and ')}`,
    }
  })

  const listener = listenerAttempts.find((a) => a.matched)?.candidate
  if (!listener) {
    return empty(
      'no-listener',
      // Three cases, and they used to be two: a config with NO listeners answered "this
      // config has more than one listener, so the request needs a port to pick between
      // them", which is a sentence about a config nobody was looking at.
      model.listeners.length === 0
        ? 'This config defines no listeners, so there is nothing for a request to arrive on.'
        : request.port === undefined
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

  // `caveats` and `rewrites` go in by reference, so anything pushed onto them further down
  // the cascade is still here when a later branch spreads `base`.
  const base = {
    caveats,
    rewrites,
    listener,
    listenerAttempts,
    filterChain: chain.chosen,
    chainAttempts: chain.attempts,
  }

  /**
   * A `tcp_proxy` chain, which answers the question without any of the machinery below.
   *
   * There is no route table here: the chain names its upstream and every byte goes there.
   * That makes this the shortest true answer the tester ever gives, and until `tcp_proxy` was
   * modelled it could not give it at all — a connection to a TCP listener came back as "no
   * HTTP connection manager, so there are no routes to match", which is accurate about what
   * was not found and silent about the upstream sitting in the config.
   */
  const tcp = chain.chosen.tcpProxy
  if (tcp) {
    const weighted = tcp.weightedClusters
    const cluster = tcp.cluster ?? (weighted.length === 1 ? weighted[0]!.name : undefined)

    const destination =
      cluster !== undefined
        ? `cluster \`${cluster}\``
        : weighted.length > 0
          ? `${weighted.map((w) => `\`${w.name}\`${w.weight === undefined ? '' : ` (${w.weight})`}`).join(' or ')}, by weight`
          : 'an upstream it does not name'

    return {
      ...empty('tcp-proxy', `Matched a TCP proxy chain, which forwards the whole connection to ${destination}.`, { cluster }),
      ...base,
      // Pushed onto the accumulated list rather than passed to `empty`, because `base`
      // carries the caveats chain selection already produced and spreading it afterwards
      // would drop anything handed in. The form asks for a path, a method and headers
      // because most listeners are HTTP; none of them reach a tcp_proxy, and somebody who
      // has just filled all three in deserves to be told so rather than left to infer it.
      caveats: [
        ...caveats,
        'This chain does not read HTTP, so the path, method and headers played no part in this answer — only the port and the SNI, which chose the chain.',
      ],
    }
  }

  const hcm = chain.chosen.hcm
  if (!hcm) {
    return {
      ...empty('not-http', 'This filter chain has no HTTP connection manager, so there are no HTTP routes to match.'),
      ...base,
    }
  }

  // ---- what the connection manager does before it routes ----------------------
  //
  // Envoy rewrites the path and the authority before a route or a virtual host is looked at,
  // and every one of these fields was being read past. The result was a tester that
  // disagreed with the running proxy for reasons sitting in the same filter it had already
  // walked into: `//api//v1` failing to match `prefix: /api/v1` on a listener that merges
  // slashes, and `foo.com:8443` failing to reach a virtual host claiming `foo.com` on one
  // that strips the port.
  request = normalise(request, hcm, listener, rewrites, caveats)

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
  //
  // The domain list is matched against the authority verbatim, port and all, which is the
  // part that catches people out: `foo.com` does not claim `foo.com:8443`. The route config
  // can turn that off, and when it has, the port comes off here.
  let authority = request.authority
  if (routeConfig.ignorePortInHostMatching === true) {
    const { host, port } = splitAuthority(authority)
    if (port !== undefined) {
      rewrites.push(
        `\`ignore_port_in_host_matching\` on \`${routeConfig.name ?? 'this route config'}\` means virtual hosts are matched against \`${host}\` rather than \`${authority}\`.`,
      )
      authority = host
    }
  }

  const scored = routeConfig.virtualHosts.map((host, index) => ({
    host,
    index,
    score: bestDomain(host, authority),
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
          : `none of its domains cover \`${authority}\``,
  }))

  if (!winner) {
    return {
      ...empty(
        'no-virtual-host',
        `No virtual host in \`${routeConfig.name ?? 'this route config'}\` claims \`${authority}\` — Envoy would return 404.`,
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

    // The criteria this tester cannot settle do not stop a route matching — a route with
    // `runtime_fraction: 50%` matches half the time, and half the time is not never. What
    // they stop is the answer being presented as certain, which is what used to happen: the
    // route came back as the confident winner with nothing said about the coin toss.
    const unevaluated = route.match.unevaluatedCriteria
    if (unevaluated.length > 0 || route.match.hasUnmodelledCriteria) {
      const on =
        unevaluated.length > 0
          ? `${unevaluated.map((n) => `\`${n}\``).join(', ')}, which this tester does not evaluate`
          : 'criteria this tester has no model for'
      caveats.push(
        `The winning route also matches on ${on}, so Envoy might fall through to a later route for a given request.`,
      )
    }

    const action = route.action
    // An empty `weighted_clusters` is a config Envoy rejects, and this used to answer it
    // with "→ cluster `undefined`". Naming no cluster at all is the honest form, and
    // `describe` below says so in words.
    const cluster =
      action.kind === 'cluster'
        ? action.cluster || undefined
        : action.kind === 'weightedClusters'
          ? action.clusters[0]?.name || undefined
          : undefined

    if (action.kind === 'weightedClusters' && action.clusters.length > 0) {
      caveats.push(
        `The winning route splits traffic across ${action.clusters.map((c) => `\`${c.name}\``).join(', ')} by weight, so which upstream a given request reaches is decided at request time.`,
      )
    }
    if (action.kind === 'clusterHeader') {
      caveats.push(
        `The winning route takes its cluster from the \`${action.header}\` header, so the upstream cannot be read from the config.`,
      )
    }
    // The destination below is therefore the request's own path, unrewritten. Said out loud
    // rather than silently, and rather than running an RE2 pattern through JavaScript's
    // regex engine and hoping the two agree on this one.
    if (action.kind === 'redirect' && action.regexRewrite !== undefined) {
      caveats.push(
        `The winning route rewrites the redirect path with the regular expression \`${action.regexRewrite.pattern}\` → \`${action.regexRewrite.substitution}\`, which this tester does not apply.`,
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
      return cluster === undefined
        ? `Matched ${where}, which is a \`route\` action that names no cluster.${also}`
        : `Matched ${where} → cluster \`${cluster}\`.${also}`
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
