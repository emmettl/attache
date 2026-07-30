import type { ConfigPath, Range } from './source.js'
import type { ConfigModel } from './types.js'

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

export function buildGraph(model: ConfigModel): Graph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const clusterIds = new Map<string, string>()
  const referenced = new Set<string>()

  model.clusters.forEach((cluster, index) => {
    const id = `cluster:${index}`
    if (cluster.name !== undefined) clusterIds.set(cluster.name, id)
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
          detail: describeMatch(route.match.pathSpec),
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

        for (const target of targets) {
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
      detail:
        listener.address === undefined
          ? undefined
          : `${listener.address.address ?? '*'}:${listener.address.portValue ?? '?'}`,
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

      const hcm = chain.hcm
      if (!hcm) continue

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
    if (!referenced.has(node.label)) node.problem = 'orphan'
  }

  return { nodes, edges }
}
