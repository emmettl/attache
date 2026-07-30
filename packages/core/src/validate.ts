import type { Diagnostic } from './diagnostics.js'
import { formatPath } from './source.js'
import type { ConfigModel, Route, RouteConfig, Sourced, VirtualHost } from './types.js'

// The checks that need more than one part of the config at once.
//
// Structural problems — a string where a number belongs, a missing required field — are
// caught during modelling, because that is where the type is known. What is left for here
// is everything relational: a name that refers to nothing, two things claiming the same
// name, a route that can never be reached because of one above it. Envoy's own config
// validation catches some of these at boot and is silent about the rest, and it is the
// rest that this is for.

/** Every route config reachable from a listener, plus any that stand alone. */
function allRouteConfigs(model: ConfigModel): { config: RouteConfig; via: string }[] {
  const out: { config: RouteConfig; via: string }[] = []
  for (const listener of model.listeners) {
    const chains = [...listener.filterChains, listener.defaultFilterChain]
    for (const chain of chains) {
      if (chain?.hcm?.routeConfig) {
        out.push({ config: chain.hcm.routeConfig, via: listener.name ?? formatPath(listener.path) })
      }
    }
  }
  for (const config of model.routeConfigs) out.push({ config, via: 'RDS' })
  return out
}

/** Cluster names named by any route action, with where they were named. */
function clusterReferences(model: ConfigModel): { name: string; at: Sourced }[] {
  const out: { name: string; at: Sourced }[] = []
  for (const { config } of allRouteConfigs(model)) {
    for (const host of config.virtualHosts) {
      for (const route of host.routes) {
        if (route.action.kind === 'cluster') out.push({ name: route.action.cluster, at: route })
        else if (route.action.kind === 'weightedClusters') {
          for (const weighted of route.action.clusters) out.push({ name: weighted.name, at: route })
        }
      }
    }
  }
  return out
}

function duplicates<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (k === undefined || k === '') continue
    const existing = groups.get(k)
    if (existing) existing.push(item)
    else groups.set(k, [item])
  }
  for (const [k, group] of groups) if (group.length < 2) groups.delete(k)
  return groups
}

/**
 * Whether an earlier route makes a later one unreachable.
 *
 * Deliberately conservative: it only says yes when the earlier route matches on the path
 * alone and its prefix covers everything the later one could. A route carrying header or
 * query criteria might not match a given request even when its path does, so it shadows
 * nothing that can be determined from the config alone — and a false accusation of dead
 * config is worse than a missed one, because it teaches people to ignore the tool.
 */
function shadows(earlier: Route, later: Route): boolean {
  if (earlier.match.headers.length > 0 || earlier.match.queryParameters.length > 0) return false
  if (!earlier.match.caseSensitive || !later.match.caseSensitive) return false

  const first = earlier.match.pathSpec
  const second = later.match.pathSpec
  if (first.kind !== 'prefix') return false
  if (second.kind !== 'prefix' && second.kind !== 'path' && second.kind !== 'pathSeparatedPrefix') {
    return false
  }
  return second.value.startsWith(first.value)
}

function checkVirtualHost(host: VirtualHost, into: Diagnostic[]): void {
  host.routes.forEach((route, index) => {
    for (let i = 0; i < index; i++) {
      const earlier = host.routes[i]!
      if (!shadows(earlier, route)) continue
      const covering =
        earlier.match.pathSpec.kind === 'prefix' ? earlier.match.pathSpec.value : ''
      into.push({
        severity: 'warning',
        code: 'route-unreachable',
        message: `This route can never match: route ${i + 1} in \`${host.name ?? 'this virtual host'}\` already matches everything it would.`,
        detail: `Routes are tried in the order they are written, and the first match wins — so the earlier \`prefix: ${covering}\` takes every request this one is for. Moving this route above it is usually what was meant.`,
        path: route.path,
        range: route.range,
      })
      return
    }
  })
}

export function validate(model: ConfigModel): Diagnostic[] {
  const out: Diagnostic[] = []

  // ---- names that refer to nothing ----------------------------------------------

  const clusterNames = new Set(
    model.clusters.map((c) => c.name).filter((n): n is string => n !== undefined),
  )
  const referenced = clusterReferences(model)

  for (const reference of referenced) {
    if (clusterNames.has(reference.name)) continue
    out.push({
      severity: 'error',
      code: 'cluster-not-found',
      message: `No cluster named \`${reference.name}\`.`,
      detail:
        'Envoy rejects a config whose route names a cluster that is not defined. If this cluster is delivered over CDS rather than written here, that is expected — but nothing in this config says so.',
      path: reference.at.path,
      range: reference.at.range,
    })
  }

  const referencedNames = new Set(referenced.map((r) => r.name))
  for (const cluster of model.clusters) {
    if (cluster.name === undefined || referencedNames.has(cluster.name)) continue
    out.push({
      severity: 'warning',
      code: 'cluster-unused',
      message: `Nothing routes to \`${cluster.name}\`.`,
      detail:
        'Not an error — a cluster can be reached by a filter, by an RDS-delivered route, or by nothing at all. Worth a look if you expected traffic to reach it.',
      path: cluster.path,
      range: cluster.range,
    })
  }

  // ---- names claimed twice --------------------------------------------------------

  for (const [name, group] of duplicates(model.clusters, (c) => c.name)) {
    for (const cluster of group.slice(1)) {
      out.push({
        severity: 'error',
        code: 'duplicate-cluster-name',
        message: `There is already a cluster named \`${name}\`.`,
        path: cluster.path,
        range: cluster.range,
      })
    }
  }

  for (const [name, group] of duplicates(model.listeners, (l) => l.name)) {
    for (const listener of group.slice(1)) {
      out.push({
        severity: 'error',
        code: 'duplicate-listener-name',
        message: `There is already a listener named \`${name}\`.`,
        path: listener.path,
        range: listener.range,
      })
    }
  }

  for (const [where, group] of duplicates(model.listeners, (l) =>
    l.address?.portValue === undefined ? undefined : `${l.address.address ?? '*'}:${l.address.portValue}`,
  )) {
    for (const listener of group.slice(1)) {
      out.push({
        severity: 'error',
        code: 'duplicate-listener-address',
        message: `Another listener is already bound to ${where}.`,
        detail:
          'Two listeners on one address is a bind conflict at startup. If you meant to serve different traffic on the same port, that is what filter chain matching is for — one listener, several chains.',
        path: listener.path,
        range: listener.range,
      })
    }
  }

  // ---- routes ---------------------------------------------------------------------

  for (const { config } of allRouteConfigs(model)) {
    for (const [domain, group] of duplicates(
      config.virtualHosts.flatMap((h) => h.domains.map((d) => ({ domain: d, host: h }))),
      (entry) => entry.domain,
    )) {
      for (const entry of group.slice(1)) {
        out.push({
          severity: 'error',
          code: 'duplicate-domain',
          message: `\`${domain}\` is claimed by more than one virtual host in \`${config.name ?? 'this route config'}\`.`,
          detail:
            'Envoy requires domains to be unique across the virtual hosts of a route configuration, and refuses to load one where they are not.',
          path: entry.host.path,
          range: entry.host.range,
        })
      }
    }

    for (const host of config.virtualHosts) checkVirtualHost(host, out)
  }

  // ---- listeners with nowhere to route --------------------------------------------

  const knownRouteConfigNames = new Set(
    model.routeConfigs.map((r) => r.name).filter((n): n is string => n !== undefined),
  )

  for (const listener of model.listeners) {
    for (const chain of [...listener.filterChains, listener.defaultFilterChain]) {
      const hcm = chain?.hcm
      if (!hcm) continue

      if (hcm.routeConfig === undefined && hcm.rdsRouteConfigName === undefined) {
        out.push({
          severity: 'error',
          code: 'no-route-config',
          message: 'This HTTP connection manager has no routes.',
          detail:
            'An HCM needs either an inline `route_config` or an `rds` block naming one. Without either it can accept a connection and then has nothing to do with the request.',
          path: hcm.path,
          range: hcm.range,
        })
        continue
      }

      if (hcm.rdsRouteConfigName === undefined) continue

      if (knownRouteConfigNames.has(hcm.rdsRouteConfigName)) continue

      // In a config dump, every route config Envoy actually holds is present — so a name
      // that resolves to nothing there is a real dangling reference. In a bootstrap the
      // route config is expected to arrive from a management server, and its absence is
      // simply the shape of dynamic configuration.
      if (model.format === 'config-dump') {
        out.push({
          severity: 'error',
          code: 'route-config-not-found',
          message: `No route configuration named \`${hcm.rdsRouteConfigName}\` in this dump.`,
          path: hcm.path,
          range: hcm.range,
        })
      } else {
        out.push({
          severity: 'info',
          code: 'dynamic-resource-not-resolvable',
          message: `Routes come from RDS as \`${hcm.rdsRouteConfigName}\`, so they are not in this file.`,
          detail:
            'Nothing here can be checked against them, and the route tester will have no routes for this listener. Paste a `/config_dump` from a running Envoy to see the routes it actually holds.',
          path: hcm.path,
          range: hcm.range,
        })
      }
    }
  }

  return out
}
