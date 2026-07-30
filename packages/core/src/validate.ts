import type { Diagnostic } from './diagnostics.js'
import { formatPath } from './source.js'
import type { ConfigModel, Listener, Route, RouteConfig, Sourced, VirtualHost } from './types.js'

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
/**
 * Every place this config names a cluster, wherever it names it from.
 *
 * Routes are the obvious half. The other half is everything that reaches a cluster WITHOUT
 * routing to it — a `tcp_proxy` chain, an authorization filter, a gRPC access logger, a
 * tracing collector — and leaving those out was not a gap in coverage so much as a source of
 * wrong answers. A cluster called only by `ext_authz` came back as one nothing routes to, and
 * a `tcp_proxy` listener's entire upstream did too.
 */
function clusterReferences(model: ConfigModel): { name: string; at: Sourced }[] {
  const out: { name: string; at: Sourced }[] = []

  for (const { config } of allRouteConfigs(model)) {
    for (const host of config.virtualHosts) {
      for (const route of host.routes) {
        if (route.action.kind === 'cluster') out.push({ name: route.action.cluster, at: route })
        else if (route.action.kind === 'weightedClusters') {
          for (const weighted of route.action.clusters) out.push({ name: weighted.name, at: route })
        }
        // Shadow traffic. The response is thrown away, so it decides nothing about where the
        // request goes — but a copy of every matching request is sent, which makes it a
        // reference like any other. Missing it produced both halves of the wrong answer at
        // once: a mirror target that does not exist went unreported, and one that does was
        // reported as a cluster nothing reaches.
        for (const mirror of route.forwarding?.mirrorClusters ?? []) {
          out.push({ name: mirror.cluster, at: mirror })
        }
      }
    }
  }

  for (const listener of model.listeners) {
    for (const chain of [...listener.filterChains, listener.defaultFilterChain]) {
      if (!chain) continue

      const tcp = chain.tcpProxy
      if (tcp) {
        if (tcp.cluster !== undefined) out.push({ name: tcp.cluster, at: tcp })
        for (const weighted of tcp.weightedClusters) out.push({ name: weighted.name, at: tcp })
      }

      for (const ref of chain.hcm?.serviceClusters ?? []) out.push({ name: ref.cluster, at: ref })
    }
  }

  // A `weighted_clusters` entry with no `name` reaches here as the empty string, and the
  // finding it produced read "No cluster named ``" — which points at a real problem and
  // names it in a way nobody can act on. The entry is already covered by the missing-field
  // diagnostic on the entry itself, so it is dropped here rather than reported twice.
  return out.filter((reference) => reference.name !== '')
}

/**
 * Every address a listener binds, as the comparable string a bind conflict is decided on.
 *
 * `0.0.0.0` and an address left out are the same wildcard bind and were being compared as
 * `0.0.0.0:80` against `*:80`, so two listeners that genuinely cannot both start came back
 * clean. `additional_addresses` is here for the same reason: it is a bind like any other.
 */
function bindsOf(listener: Listener): string[] {
  const wildcards = new Set(['0.0.0.0', '::', '[::]'])
  return [listener.address, ...listener.additionalAddresses]
    .map((address) => {
      if (address?.portValue === undefined) return undefined
      const host = address.address
      return `${host === undefined || wildcards.has(host) ? '*' : host}:${address.portValue}`
    })
    .filter((bind): bind is string => bind !== undefined)
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

  // A criterion this package reads and does not evaluate means the earlier route does NOT
  // take every request its path covers, and the route below it is reachable after all.
  // `runtime_fraction` is the case that matters: a canary at fifty per cent sends half the
  // traffic to the route underneath it BY DESIGN, and calling that dead config is exactly
  // the false accusation this function's conservatism exists to avoid. Modelling those
  // criteria without telling this is what introduced the accusation in the first place.
  if (earlier.match.unevaluatedCriteria.length > 0 || earlier.match.hasUnmodelledCriteria) {
    return false
  }

  const first = earlier.match.pathSpec
  const second = later.match.pathSpec
  if (second.kind !== 'prefix' && second.kind !== 'path' && second.kind !== 'pathSeparatedPrefix') {
    return false
  }

  switch (first.kind) {
    case 'prefix':
      // Everything at or below the prefix, as a plain string: `prefix: /api` really does
      // take `/apifoo`, which is the whole reason people are surprised by it.
      return second.value.startsWith(first.value)

    case 'pathSeparatedPrefix':
      // The same, restricted to segment boundaries. `path_separated_prefix: /api` takes
      // `/api` and `/api/...` and nothing else — so it does NOT cover `/apifoo`, and a
      // plain `startsWith` here would invent a shadow that Envoy does not have.
      return second.value === first.value || second.value.startsWith(`${first.value}/`)

    case 'path':
      // An exact path covers exactly itself. Worth catching all the same: the same endpoint
      // written twice is an ordinary merge artefact, and the second one never runs.
      return second.kind === 'path' && second.value === first.value

    default:
      // A regex, a `connect_matcher`, or no path at all. What a regex covers is not a
      // question a string comparison can answer, and guessing would be a confident claim
      // about dead config.
      return false
  }
}

function checkVirtualHost(host: VirtualHost, into: Diagnostic[]): void {
  host.routes.forEach((route, index) => {
    for (let i = 0; i < index; i++) {
      const earlier = host.routes[i]!
      if (!shadows(earlier, route)) continue
      // Named as it was written, now that three kinds of matcher can be the one covering
      // this route. Saying `prefix:` about a `path_separated_prefix` would send somebody
      // looking for a line that is not there.
      const spec = earlier.match.pathSpec
      const covering =
        spec.kind === 'prefix'
          ? `prefix: ${spec.value}`
          : spec.kind === 'pathSeparatedPrefix'
            ? `path_separated_prefix: ${spec.value}`
            : spec.kind === 'path'
              ? `path: ${spec.value}`
              : 'match'
      into.push({
        severity: 'warning',
        code: 'route-unreachable',
        message: `This route can never match: route ${i + 1} in \`${host.name ?? 'this virtual host'}\` already matches everything it would.`,
        detail: `Routes are tried in the order they are written, and the first match wins — so the earlier \`${covering}\` takes every request this one is for. Moving this route above it is usually what was meant.`,
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

  /**
   * Whether a cluster this file does not define could still turn up at runtime.
   *
   * The old wording of the finding below said "if this cluster is delivered over CDS rather
   * than written here, that is expected — but nothing in this config says so", which was
   * true right up until `dynamic_resources` was modelled. Now something does say so, and
   * continuing to call it an error would be the tool ignoring evidence sitting in the same
   * file at error severity, which is the word that means "I am sure".
   *
   * A `/config_dump` is the opposite case and stays an error: it lists every cluster the
   * running Envoy actually holds, CDS-delivered ones included, so a name that resolves to
   * nothing there really does resolve to nothing.
   */
  const clustersMayArriveLater =
    model.format !== 'config-dump' && (model.bootstrap?.dynamicResources?.usesCds ?? false)
  const xds = model.bootstrap?.dynamicResources?.xdsCluster

  /**
   * One finding per REFERENCE, not per missing name — and that is a decision rather than an
   * oversight.
   *
   * Three routes naming a cluster that is not here produce three findings, which reads like
   * three copies of one typo. Deduplicating on the name would produce one, and it would have
   * to point at one of the three routes: the editor would underline that route and leave the
   * other two looking fine, and the person fixing it would repair the line they were shown
   * and ship the other two.
   *
   * Each of those routes is independently broken and each needs its own edit unless the
   * cluster arrives. So the count is not inflated — it is the number of places that have to
   * change.
   */
  for (const reference of referenced) {
    if (clusterNames.has(reference.name)) continue
    out.push({
      severity: clustersMayArriveLater ? 'info' : 'error',
      code: 'cluster-not-found',
      message: clustersMayArriveLater
        ? `\`${reference.name}\` is not defined in this file, and this bootstrap takes its clusters from CDS.`
        : `No cluster named \`${reference.name}\`.`,
      detail: clustersMayArriveLater
        ? `The definition is expected to arrive over CDS${xds === undefined ? '' : ` from \`${xds}\``}, so nothing here can check it — and nothing here can tell you it is really being served either. Paste a \`/config_dump\` from the running Envoy to see the clusters it actually holds.`
        : 'Envoy rejects a config whose route names a cluster that is not defined. Nothing in this config says the cluster is delivered over CDS, so as written the reference goes nowhere.',
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
      message: `Nothing reaches \`${cluster.name}\`.`,
      // The hedge this used to carry — "a cluster can be reached by a filter" — was there
      // because filters were not read, so the warning could not tell an unused cluster from
      // one an authorization filter calls on every request. Those are read now, along with
      // tcp_proxy and the gRPC loggers, so what is left to be uncertain about is what
      // genuinely is not in the file: routes that arrive over RDS.
      detail:
        'Not an error — routes that arrive over RDS are not in this file, so a cluster they name looks unreached from here. Attaché has checked the routes, tcp_proxy chains, and the filters and loggers that call a cluster directly. Worth a look if you expected traffic to reach it.',
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

  // A listener can bind more than one address, so the pairing is flattened before it is
  // grouped: one entry per (listener, bind) rather than one per listener.
  const binds = model.listeners.flatMap((listener) =>
    // `bind_to_port: false` is a virtual listener — it never takes a socket, so it cannot
    // conflict with anything, and saying it does would be a confident accusation about the
    // one shape where sharing a port is the entire point.
    listener.bindToPort === false
      ? []
      : bindsOf(listener).map((bind) => ({ listener, bind })),
  )

  for (const [where, group] of duplicates(binds, (entry) => entry.bind)) {
    for (const { listener } of group.slice(1)) {
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

  // ---- transport and filter order --------------------------------------------------

  const ROUTER = 'envoy.filters.http.router'

  for (const listener of model.listeners) {
    if (listener.filterChains.length === 0 && listener.defaultFilterChain === undefined) {
      out.push({
        severity: 'error',
        code: 'no-filter-chains',
        message: `\`${listener.name ?? 'This listener'}\` has no filter chains.`,
        detail:
          'A listener with nothing to hand a connection to will accept it and then do nothing with it. Envoy rejects this at boot.',
        path: listener.path,
        range: listener.range,
      })
    }

    for (const chain of [...listener.filterChains, listener.defaultFilterChain]) {
      if (!chain) continue

      // SNI is read off the TLS handshake, so a chain that never terminates TLS is never
      // offered one to match against. This is silent at boot and looks, from the outside,
      // exactly like a routing bug.
      if ((chain.match?.serverNames.length ?? 0) > 0 && chain.tls === undefined) {
        out.push({
          severity: 'warning',
          code: 'sni-without-tls',
          message: `This chain matches on SNI (${chain.match!.serverNames.join(', ')}) but does not terminate TLS.`,
          detail:
            'Server names come from the TLS handshake. Without a `transport_socket` configuring TLS on this chain there is no SNI to compare against, so the criterion can never be satisfied and the chain will not be selected.',
          path: chain.match!.path,
          range: chain.match!.range,
        })
      }

      if (
        chain.tls !== undefined &&
        chain.tls.certificateCount === 0 &&
        chain.tls.sdsSecretNames.length === 0
      ) {
        out.push({
          severity: 'error',
          code: 'tls-without-certificate',
          message: 'This chain terminates TLS but has no certificate.',
          detail:
            'A downstream TLS context needs either `tls_certificates` or `tls_certificate_sds_secret_configs`. With neither, the handshake has nothing to present.',
          path: chain.tls.path,
          range: chain.tls.range,
        })
      }

      const filters = chain.hcm?.httpFilters
      if (!filters || filters.length === 0) continue

      // The router is the terminal filter: it is what actually dispatches the request
      // upstream. Envoy refuses to start if it is not last, and the mistake is easy to make
      // because appending a new filter to the end of the list is the natural edit.
      const at = filters.indexOf(ROUTER)
      if (at === -1) {
        out.push({
          severity: 'error',
          code: 'no-router-filter',
          message: 'This HTTP filter chain has no router filter.',
          detail: `Without \`${ROUTER}\` nothing dispatches the request upstream, so every route resolves and then goes nowhere.`,
          path: chain.hcm!.path,
          range: chain.hcm!.range,
        })
      } else if (at !== filters.length - 1) {
        out.push({
          severity: 'error',
          code: 'router-not-last',
          message: `The router filter must be last — ${filters.length - 1 - at} filter${filters.length - 1 - at === 1 ? '' : 's'} follow it.`,
          detail: `\`${filters.slice(at + 1).join('`, `')}\` will never run: the router terminates the chain by dispatching upstream, so anything after it is unreachable. Envoy refuses to start on this.`,
          path: chain.hcm!.path,
          range: chain.hcm!.range,
        })
      }
    }
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
