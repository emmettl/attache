import type { ConfigPath, Range } from './source.js'
import type { ConfigModel, Route } from './types.js'

// The config as a shape rather than as an outline.
//
// An Envoy config is a tree in the file and a graph in reality: a route names a cluster in
// a string, and the two can sit four hundred lines apart with nothing linking them but
// that name matching. Drawing the edge is most of the value here — and so is drawing the
// ones that go nowhere, since a name that refers to nothing looks exactly like a name that
// does when you are reading YAML.

export type NodeKind =
  | 'listener'
  | 'filterChain'
  | 'routeConfig'
  | 'virtualHost'
  | 'route'
  | 'cluster'
  | 'endpoint'

export interface GraphNode {
  id: string
  kind: NodeKind
  label: string
  /** Secondary line — an address, a match, a cluster type. */
  detail?: string
  path: ConfigPath
  range: Range
  /**
   * `dangling`: this refers to something that is not here.
   * `orphan`: nothing here refers to this.
   */
  problem?: 'dangling' | 'orphan'
}

export interface GraphEdge {
  from: string
  to: string
  /** What decides whether this edge is taken — an SNI, a path prefix, a domain. */
  label?: string
  /** True when `to` is a placeholder standing in for something not in this config. */
  dangling?: boolean
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * A filter name with its namespace dropped — `envoy.filters.http.ext_authz` → `ext_authz`.
 *
 * Only for the graph, where a node is under two hundred pixels wide and the prefix is the
 * same on every filter anybody writes, so it costs the whole label to say nothing. The full
 * name is a click away in the source pane, and everywhere that has room keeps it.
 */
const shortFilterName = (name: string): string => name.split('.').pop() ?? name

const describeMatch = (
  spec: { kind: string; value?: string; label?: string },
): string => {
  switch (spec.kind) {
    case 'prefix':
      return `prefix ${spec.value}`
    case 'path':
      return `path ${spec.value}`
    case 'pathSeparatedPrefix':
      return `segment ${spec.value}`
    case 'safeRegex':
      return `regex ${spec.value}`
    case 'none':
      return 'no path match'
    default:
      return spec.label ?? 'unmodelled'
  }
}

/**
 * A route's second line: what it matches on, then what it does that the edges cannot show.
 *
 * A route with a cluster needs nothing here, because the edge leaving it says where it goes.
 * A redirect or a direct response has no edge at all and would otherwise sit in the graph
 * as a dead end with no explanation, and a route that switches a filter off looks exactly
 * like one that does not.
 */
function describeRoute(route: Route): string {
  const bits = [describeMatch(route.match.pathSpec)]

  if (route.action.kind === 'redirect') {
    const to = route.action.hostRedirect ?? route.action.pathRedirect
    bits.push(to === undefined ? 'redirect' : `redirect → ${to}`)
  } else if (route.action.kind === 'directResponse') {
    bits.push(`direct ${route.action.status ?? 'response'}`)
  }

  const off = route.typedPerFilterConfig.filter((f) => f.disabled)
  if (off.length > 0) bits.push(`disables ${off.map((f) => shortFilterName(f.name)).join(', ')}`)

  return bits.join(' · ')
}

export function buildGraph(model: ConfigModel): Graph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const clusterIds = new Map<string, string>()
  const referenced = new Set<string>()
  /**
   * Which node id belongs to which cluster NAME.
   *
   * The orphan pass at the bottom used to ask whether `node.label` had been referenced,
   * which is the name for every cluster that has one and the words "(unnamed cluster)" for
   * every cluster that does not — so an unnamed cluster was reliably accused of being one
   * nothing reaches, on top of the missing-name error it already had.
   */
  const nameOf = new Map<string, string>()

  model.clusters.forEach((cluster, index) => {
    const id = `cluster:${index}`
    if (cluster.name !== undefined) {
      clusterIds.set(cluster.name, id)
      nameOf.set(id, cluster.name)
    }
    nodes.push({
      id,
      kind: 'cluster',
      label: cluster.name ?? '(unnamed cluster)',
      detail: [cluster.type ?? 'STATIC', cluster.lbPolicy].filter(Boolean).join(' · '),
      path: cluster.path,
      range: cluster.range,
    })

    cluster.endpoints.forEach((endpoint, endpointIndex) => {
      const endpointId = `${id}:endpoint:${endpointIndex}`
      nodes.push({
        id: endpointId,
        kind: 'endpoint',
        label: `${endpoint.address ?? '?'}:${endpoint.portValue ?? '?'}`,
        // The locality and the asserted health, which is what a failover config is made of
        // and what an address alone cannot tell you. `HEALTHY` is left off: it is the
        // default assertion and repeating it on every endpoint says nothing.
        detail:
          [
            endpoint.locality,
            endpoint.healthStatus === 'HEALTHY' ? undefined : endpoint.healthStatus,
            endpoint.priority === undefined || endpoint.priority === 0
              ? undefined
              : `priority ${endpoint.priority}`,
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · ') || undefined,
        path: endpoint.path,
        range: endpoint.range,
      })
      edges.push({ from: id, to: endpointId })
    })
  })

  /** A stand-in for a cluster named by a route but defined nowhere in this config. */
  const missingCluster = (name: string, at: { path: ConfigPath; range: Range }): string => {
    const id = `missing:${name}`
    if (!nodes.some((n) => n.id === id)) {
      nodes.push({
        id,
        kind: 'cluster',
        label: name,
        detail: 'not defined here',
        path: at.path,
        range: at.range,
        problem: 'dangling',
      })
    }
    return id
  }

  const addRouteConfig = (
    config: (typeof model.routeConfigs)[number],
    id: string,
    fromId: string | null,
    edgeLabel?: string,
  ) => {
    nodes.push({
      id,
      kind: 'routeConfig',
      label: config.name ?? '(inline routes)',
      path: config.path,
      range: config.range,
    })
    if (fromId) edges.push({ from: fromId, to: id, label: edgeLabel })

    config.virtualHosts.forEach((host, hostIndex) => {
      const hostId = `${id}:vhost:${hostIndex}`
      nodes.push({
        id: hostId,
        kind: 'virtualHost',
        label: host.name ?? `(virtual host ${hostIndex + 1})`,
        detail: host.domains.join(', '),
        path: host.path,
        range: host.range,
      })
      edges.push({ from: id, to: hostId, label: host.domains.join(', ') })

      host.routes.forEach((route, routeIndex) => {
        const routeId = `${hostId}:route:${routeIndex}`
        nodes.push({
          id: routeId,
          kind: 'route',
          label: route.name ?? `route ${routeIndex + 1}`,
          detail: describeRoute(route),
          path: route.path,
          range: route.range,
        })
        edges.push({ from: hostId, to: routeId, label: describeMatch(route.match.pathSpec) })

        const targets: { name: string; label?: string }[] =
          route.action.kind === 'cluster'
            ? [{ name: route.action.cluster }]
            : route.action.kind === 'weightedClusters'
              ? route.action.clusters.map((c) => ({
                  name: c.name,
                  label: c.weight === undefined ? undefined : `weight ${c.weight}`,
                }))
              : []

        // Shadow traffic is drawn as an edge like any other, labelled for what it is. The
        // request does not go there in the sense the rest of the graph means, but a copy of
        // it does, and a cluster this config sends every matching request to is not one the
        // picture should be leaving out.
        for (const mirror of route.forwarding?.mirrorClusters ?? []) {
          targets.push({ name: mirror.cluster, label: 'mirror' })
        }

        for (const target of targets) {
          if (target.name === '') continue
          referenced.add(target.name)
          const existing = clusterIds.get(target.name)
          const to = existing ?? missingCluster(target.name, route)
          edges.push({ from: routeId, to, label: target.label, dangling: existing === undefined })
        }
      })
    })
  }

  model.listeners.forEach((listener, listenerIndex) => {
    const listenerId = `listener:${listenerIndex}`
    nodes.push({
      id: listenerId,
      kind: 'listener',
      label: listener.name ?? `(listener ${listenerIndex + 1})`,
      // Direction earns the space: a sidecar's inbound and outbound listeners are otherwise
      // told apart only by remembering which port is which, and a config full of them is
      // exactly the config somebody opened this to make sense of.
      detail:
        [
          listener.address === undefined
            ? undefined
            : `${listener.address.address ?? '*'}:${listener.address.portValue ?? '?'}`,
          listener.trafficDirection === undefined || listener.trafficDirection === 'UNSPECIFIED'
            ? undefined
            : listener.trafficDirection.toLowerCase(),
        ]
          .filter((part): part is string => part !== undefined)
          .join(' · ') || undefined,
      path: listener.path,
      range: listener.range,
    })

    const chains = [
      ...listener.filterChains.map((chain, index) => ({ chain, index, fallback: false })),
      ...(listener.defaultFilterChain
        ? [{ chain: listener.defaultFilterChain, index: listener.filterChains.length, fallback: true }]
        : []),
    ]

    for (const { chain, index, fallback } of chains) {
      const chainId = `${listenerId}:chain:${index}`
      const criteria = [
        chain.match?.serverNames.length ? `SNI ${chain.match.serverNames.join(', ')}` : null,
        chain.match?.destinationPort !== undefined ? `port ${chain.match.destinationPort}` : null,
        chain.match?.transportProtocol ? chain.match.transportProtocol : null,
        fallback ? 'fallback' : null,
      ].filter((c): c is string => c !== null)

      nodes.push({
        id: chainId,
        kind: 'filterChain',
        label: chain.name ?? (fallback ? 'default chain' : `chain ${index + 1}`),
        detail: chain.filterNames.join(' → ') || undefined,
        path: chain.path,
        range: chain.range,
      })
      edges.push({ from: listenerId, to: chainId, label: criteria.join(' · ') || undefined })

      /**
       * A cluster this chain reaches, drawn from the chain itself.
       *
       * Two quite different things arrive here and both belong on the same edge. A
       * `tcp_proxy` target IS the routing — there is no route table between the chain and
       * the cluster, so the edge is the whole story of where a connection goes. A service
       * cluster is the opposite: `ext_authz` or a gRPC access logger talking to something
       * off to the side, which the request does not travel to but which the config
       * genuinely depends on. Labelled differently and drawn the same, because the question
       * they both answer is "what reaches this cluster", and a graph that showed one and
       * not the other would be quietly answering it wrongly.
       */
      const reach = (name: string, label: string, at: { path: ConfigPath; range: Range }) => {
        referenced.add(name)
        const existing = clusterIds.get(name)
        const to = existing ?? missingCluster(name, at)
        edges.push({ from: chainId, to, label, dangling: existing === undefined })
      }

      const tcp = chain.tcpProxy
      if (tcp) {
        if (tcp.cluster !== undefined) reach(tcp.cluster, 'tcp', tcp)
        for (const weighted of tcp.weightedClusters) {
          reach(weighted.name, weighted.weight === undefined ? 'tcp' : `tcp · weight ${weighted.weight}`, tcp)
        }
      }

      const hcm = chain.hcm
      if (!hcm) continue

      // Shortened to the last segment: a column of cards reading
      // `envoy.filters.http.ext_authz` is a column of one repeated prefix.
      for (const ref of hcm.serviceClusters) {
        reach(ref.cluster, ref.by.split('.').pop() ?? ref.by, ref)
      }

      if (hcm.routeConfig) {
        addRouteConfig(hcm.routeConfig, `${chainId}:routes`, chainId)
      } else if (hcm.rdsRouteConfigName !== undefined) {
        const named = model.routeConfigs.findIndex((r) => r.name === hcm.rdsRouteConfigName)
        if (named === -1) {
          const id = `rds:${hcm.rdsRouteConfigName}`
          if (!nodes.some((n) => n.id === id)) {
            nodes.push({
              id,
              kind: 'routeConfig',
              label: hcm.rdsRouteConfigName,
              detail: 'from RDS, not in this config',
              path: hcm.path,
              range: hcm.range,
              problem: 'dangling',
            })
          }
          edges.push({ from: chainId, to: id, label: 'RDS', dangling: true })
        } else {
          edges.push({ from: chainId, to: `standalone:${named}`, label: 'RDS' })
        }
      }
    }
  })

  // Route configs that came in on their own — from a `/config_dump`, these are the ones
  // Envoy holds via RDS, and the listeners above link to them by name.
  model.routeConfigs.forEach((config, index) => {
    addRouteConfig(config, `standalone:${index}`, null)
  })

  for (const node of nodes) {
    if (node.kind !== 'cluster' || node.problem) continue
    const name = nameOf.get(node.id)
    // A cluster with no name cannot be referred to by name, so nothing about it can be
    // concluded from nothing referring to it. The missing `name` is already an error.
    if (name !== undefined && !referenced.has(name)) node.problem = 'orphan'
  }

  return { nodes, edges }
}
