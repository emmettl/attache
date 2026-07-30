import type { DiagnosticCode } from './diagnostics.js'
import type { NodeKind } from './graph.js'

// Where to read more.
//
// Envoy's reference is generated from the protos and is, by common consent, hard going: the
// page that explains why your virtual host was not selected is a field entry three levels
// into `route_components.proto`, and finding it means already knowing what it is called.
// Landing somebody directly on it is most of the value.
//
// A CURATED map, not synthesised URLs. The anchor scheme is regular enough to tempt you
// into generating links from message names — `envoy-v3-api-msg-<package>-<message>` — and
// that would produce a plausible URL for every message whether or not the page has that
// anchor, which is how you end up shipping links that 200 and then scroll nowhere. Every
// entry below was checked against the live page; `docs.test.ts` keeps them honest offline
// by at least holding the shape.

const BASE = 'https://www.envoyproxy.io/docs/envoy/latest/api-v3/'

const ROUTE_COMPONENTS = 'config/route/v3/route_components.proto'
const LISTENER = 'config/listener/v3/listener.proto'
const LISTENER_COMPONENTS = 'config/listener/v3/listener_components.proto'
const HCM = 'extensions/filters/network/http_connection_manager/v3/http_connection_manager.proto'
const CLUSTER = 'config/cluster/v3/cluster.proto'

export interface DocLink {
  url: string
  /** What the reader will land on, so a link can say where it goes. */
  title: string
}

const link = (page: string, anchor: string, title: string): DocLink => ({
  url: `${BASE}${page}#${anchor}`,
  title,
})

const DOCS = {
  bootstrap: link(
    'config/bootstrap/v3/bootstrap.proto',
    'envoy-v3-api-msg-config-bootstrap-v3-bootstrap',
    'Bootstrap',
  ),
  listener: link(LISTENER, 'envoy-v3-api-msg-config-listener-v3-listener', 'Listener'),
  listenerName: link(LISTENER, 'envoy-v3-api-field-config-listener-v3-listener-name', 'Listener.name'),
  listenerAddress: link(
    LISTENER,
    'envoy-v3-api-field-config-listener-v3-listener-address',
    'Listener.address',
  ),
  filterChains: link(
    LISTENER,
    'envoy-v3-api-field-config-listener-v3-listener-filter-chains',
    'Listener.filter_chains',
  ),
  filterChain: link(
    LISTENER_COMPONENTS,
    'envoy-v3-api-msg-config-listener-v3-filterchain',
    'FilterChain',
  ),
  filterChainMatch: link(
    LISTENER_COMPONENTS,
    'envoy-v3-api-msg-config-listener-v3-filterchainmatch',
    'FilterChainMatch',
  ),
  hcm: link(
    HCM,
    'envoy-v3-api-msg-extensions-filters-network-http-connection-manager-v3-httpconnectionmanager',
    'HttpConnectionManager',
  ),
  httpFilters: link(
    HCM,
    'envoy-v3-api-field-extensions-filters-network-http-connection-manager-v3-httpconnectionmanager-http-filters',
    'HttpConnectionManager.http_filters',
  ),
  rds: link(
    HCM,
    'envoy-v3-api-msg-extensions-filters-network-http-connection-manager-v3-rds',
    'Rds',
  ),
  router: link(
    'extensions/filters/http/router/v3/router.proto',
    'envoy-v3-api-msg-extensions-filters-http-router-v3-router',
    'Router filter',
  ),
  routeConfig: link(
    'config/route/v3/route.proto',
    'envoy-v3-api-msg-config-route-v3-routeconfiguration',
    'RouteConfiguration',
  ),
  virtualHost: link(
    ROUTE_COMPONENTS,
    'envoy-v3-api-msg-config-route-v3-virtualhost',
    'VirtualHost',
  ),
  domains: link(
    ROUTE_COMPONENTS,
    'envoy-v3-api-field-config-route-v3-virtualhost-domains',
    'VirtualHost.domains',
  ),
  routes: link(
    ROUTE_COMPONENTS,
    'envoy-v3-api-field-config-route-v3-virtualhost-routes',
    'VirtualHost.routes',
  ),
  route: link(ROUTE_COMPONENTS, 'envoy-v3-api-msg-config-route-v3-route', 'Route'),
  routeMatch: link(ROUTE_COMPONENTS, 'envoy-v3-api-msg-config-route-v3-routematch', 'RouteMatch'),
  routeCluster: link(
    ROUTE_COMPONENTS,
    'envoy-v3-api-field-config-route-v3-routeaction-cluster',
    'RouteAction.cluster',
  ),
  cluster: link(CLUSTER, 'envoy-v3-api-msg-config-cluster-v3-cluster', 'Cluster'),
  clusterName: link(CLUSTER, 'envoy-v3-api-field-config-cluster-v3-cluster-name', 'Cluster.name'),
  clusterType: link(CLUSTER, 'envoy-v3-api-field-config-cluster-v3-cluster-type', 'Cluster.type'),
  endpoint: link(
    'config/endpoint/v3/endpoint.proto',
    'envoy-v3-api-msg-config-endpoint-v3-clusterloadassignment',
    'ClusterLoadAssignment',
  ),
  tls: link(
    'extensions/transport_sockets/tls/v3/tls.proto',
    'envoy-v3-api-msg-extensions-transport-sockets-tls-v3-downstreamtlscontext',
    'DownstreamTlsContext',
  ),
} as const

/** Every link, for the test that checks they still resolve. */
export const ALL_DOCS: readonly DocLink[] = Object.values(DOCS)

/**
 * The reference page for a finding.
 *
 * Not every code has one, and that is deliberate rather than unfinished: a YAML syntax
 * error is not an Envoy question, and pointing at Envoy's schema for it would be sending
 * somebody somewhere unhelpful with the confidence of a link.
 */
export function docsForCode(code: DiagnosticCode): DocLink | undefined {
  switch (code) {
    case 'cluster-not-found':
      return DOCS.routeCluster
    case 'cluster-unused':
    case 'duplicate-cluster-name':
      return DOCS.clusterName
    case 'duplicate-listener-name':
      return DOCS.listenerName
    case 'duplicate-listener-address':
      return DOCS.listenerAddress
    case 'duplicate-domain':
      return DOCS.domains
    case 'route-unreachable':
      return DOCS.routes
    case 'no-route-config':
      return DOCS.hcm
    case 'route-config-not-found':
    case 'dynamic-resource-not-resolvable':
      return DOCS.rds
    case 'router-not-last':
      return DOCS.httpFilters
    case 'no-filter-chains':
      return DOCS.filterChains
    case 'sni-without-tls':
      return DOCS.filterChainMatch
    case 'not-a-map':
      return DOCS.bootstrap
    case 'bad-enum':
      return DOCS.clusterType
    default:
      // wrong-type, missing-required, empty-list and yaml-error are about the shape of what
      // was written rather than about a particular Envoy message, so there is no one page
      // that would answer them.
      return undefined
  }
}

/** The reference page for a thing in the graph. */
export function docsForKind(kind: NodeKind): DocLink | undefined {
  switch (kind) {
    case 'listener':
      return DOCS.listener
    case 'filterChain':
      return DOCS.filterChain
    case 'routeConfig':
      return DOCS.routeConfig
    case 'virtualHost':
      return DOCS.virtualHost
    case 'route':
      return DOCS.route
    case 'cluster':
      return DOCS.cluster
    case 'endpoint':
      return DOCS.endpoint
  }
}

export { DOCS }
