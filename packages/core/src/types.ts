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
}

// ---- listeners ------------------------------------------------------------------

export interface Listener extends Sourced {
  name?: string
  address?: SocketAddress
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
  /** Network filter names in order, including the HCM. For the graph, and for context. */
  filterNames: string[]
}

/**
 * The subset of `filter_chain_match` that the route tester evaluates.
 *
 * `prefix_ranges` and the other CIDR-based criteria are deliberately absent: they match on
 * connection source and destination IP, which the tester does not ask for, and modelling a
 * criterion that is never evaluated would make chain selection look more considered than
 * it is. They surface as unmodelled fields instead.
 */
export interface FilterChainMatch extends Sourced {
  /** SNI. Supports a leading wildcard, e.g. `*.example.com`. */
  serverNames: string[]
  destinationPort?: number
  transportProtocol?: string
  applicationProtocols: string[]
  /**
   * Whether this chain also matches on criteria the route tester does not evaluate.
   *
   * When true, chain selection here can differ from Envoy's, and the tester says so.
   * Recorded rather than inferred later because by then the unread fields are gone.
   */
  hasUnmodelledCriteria: boolean
}

export interface HttpConnectionManager extends Sourced {
  statPrefix?: string
  /** Routes defined inline. Mutually exclusive with `rdsRouteConfigName`. */
  routeConfig?: RouteConfig
  /** Routes fetched from a management server by this name. */
  rdsRouteConfigName?: string
  httpFilters: string[]
}

// ---- routes ---------------------------------------------------------------------

export interface RouteConfig extends Sourced {
  name?: string
  virtualHosts: VirtualHost[]
}

export interface VirtualHost extends Sourced {
  name?: string
  /** Authority patterns: exact, `*.suffix`, `prefix.*`, or `*`. */
  domains: string[]
  routes: Route[]
}

export interface Route extends Sourced {
  name?: string
  match: RouteMatch
  action: RouteAction
}

/** Envoy's `path_specifier` oneof, plus the secondary criteria. */
export interface RouteMatch extends Sourced {
  pathSpec: PathSpecifier
  /** Defaults to true, as Envoy does. */
  caseSensitive: boolean
  headers: HeaderMatcher[]
  queryParameters: QueryMatcher[]
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
  | { kind: 'redirect' }
  | { kind: 'directResponse'; status?: number }
  /** An action this package does not model, or none at all. */
  | { kind: 'unmodelled'; label: string }

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
}

export interface QueryMatcher extends Sourced {
  name: string
  kind: 'present' | 'exact' | 'prefix' | 'suffix' | 'contains' | 'safeRegex' | 'unmodelled'
  value?: string
}

// ---- clusters -------------------------------------------------------------------

export interface Cluster extends Sourced {
  name?: string
  /** STRICT_DNS, EDS, STATIC, LOGICAL_DNS, ORIGINAL_DST — or absent, meaning STATIC. */
  type?: string
  lbPolicy?: string
  /** As written — `0.25s`, `5s`. Not parsed; kept so the graph can show it. */
  connectTimeout?: string
  endpoints: Endpoint[]
  /** True when endpoints come from EDS, so an empty `endpoints` is expected. */
  usesEds: boolean
}

export interface Endpoint extends Sourced {
  address?: string
  portValue?: number
}
