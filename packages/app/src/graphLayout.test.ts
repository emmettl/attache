import { analyse, buildGraph } from '@attache/core'
import { describe, expect, test } from 'vitest'
import { GAP_Y, NODE_H, NODE_W, layoutGraph, searchGraph } from './graphLayout.js'

const graphOf = (text: string) => buildGraph(analyse(text).model)

const FRONT_PROXY = `
static_resources:
  listeners:
  - name: ingress
    address: { socket_address: { address: 0.0.0.0, port_value: 10000 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: local_route
            virtual_hosts:
            - name: backend
              domains: ["*"]
              routes:
              - match: { prefix: "/api" }
                route: { cluster: api_service }
              - match: { prefix: "/" }
                route: { cluster: web_service }
  clusters:
  - name: api_service
    load_assignment:
      cluster_name: api_service
      endpoints:
      - lb_endpoints:
        - endpoint: { address: { socket_address: { address: api, port_value: 8080 } } }
  - name: web_service
`

describe('laying out a config', () => {
  const layout = layoutGraph(graphOf(FRONT_PROXY))
  const find = (label: string) => layout.nodes.find((n) => n.label === label)!

  test('flows left to right, one kind per column', () => {
    expect(find('ingress').column).toBeLessThan(find('local_route').column)
    expect(find('local_route').column).toBeLessThan(find('backend').column)
    expect(find('backend').column).toBeLessThan(find('api_service').column)
  })

  test('every edge points forwards, so nothing doubles back', () => {
    const column = new Map(layout.nodes.map((n) => [n.id, n.column]))
    for (const edge of layout.edges) {
      expect(column.get(edge.from)!).toBeLessThan(column.get(edge.to)!)
    }
  })

  test('nodes in a column do not overlap', () => {
    const byColumn = new Map<number, number[]>()
    for (const node of layout.nodes) {
      byColumn.set(node.column, [...(byColumn.get(node.column) ?? []), node.y])
    }
    for (const tops of byColumn.values()) {
      const sorted = [...tops].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(NODE_H)
      }
    }
  })

  test('every node fits inside the reported canvas', () => {
    for (const node of layout.nodes) {
      expect(node.x + NODE_W).toBeLessThanOrEqual(layout.width)
      expect(node.y + NODE_H).toBeLessThanOrEqual(layout.height)
    }
  })

  test('edges are drawn between the nodes they connect', () => {
    const edge = layout.edges.find((e) => e.to === find('api_service').id)!
    expect(edge.path).toMatch(/^M [\d.]+ [\d.]+ C /)
    // Leaves the right-hand side of the source, arrives at the left of the target.
    const source = layout.nodes.find((n) => n.id === edge.from)!
    expect(edge.path).toContain(`M ${source.x + NODE_W} `)
  })

  test('a dangling reference keeps its flag through the layout', () => {
    const dangling = layoutGraph(
      graphOf(`
static_resources:
  listeners:
  - name: l
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: v
              domains: ["*"]
              routes: [{ match: { prefix: "/" }, route: { cluster: nowhere } }]
  clusters: []
`),
    )
    expect(dangling.nodes.find((n) => n.label === 'nowhere')?.problem).toBe('dangling')
    expect(dangling.edges.some((e) => e.dangling)).toBe(true)
  })

  test('empty columns are dropped rather than left as a gap', () => {
    // No clusters and no endpoints, so those two columns should not reserve space.
    const sparse = layoutGraph(
      graphOf(`
static_resources:
  listeners:
  - name: only
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains: []
  clusters: []
`),
    )
    expect(sparse.headers.map((h) => h.title)).toEqual(['Listeners'])
    expect(sparse.width).toBeLessThan(layout.width)
  })

  test('an empty config lays out to nothing, without dividing by zero', () => {
    const empty = layoutGraph({ nodes: [], edges: [] })
    expect(empty.nodes).toEqual([])
    expect(empty.headers).toEqual([])
    expect(Number.isFinite(empty.height)).toBe(true)
  })
})

describe('the relevance closure', () => {
  const graph = graphOf(FRONT_PROXY)
  const labelsOf = (ids: Set<string>) =>
    graph.nodes
      .filter((n) => ids.has(n.id))
      .map((n) => n.label)
      .sort()

  test('a cluster name surfaces the whole path to it, above and below', () => {
    // The point of the feature. Matching only the cluster would leave a card on its own,
    // with the one thing you wanted to know — how a request gets there — filtered away.
    const found = searchGraph(graph, 'api_service')!
    expect(labelsOf(found.matched)).toEqual(['api_service'])
    expect(labelsOf(found.relevant)).toEqual(
      ['api:8080', 'api_service', 'backend', 'chain 1', 'ingress', 'local_route', 'route 1'].sort(),
    )
  })

  test('a sibling that did not match stays out', () => {
    // Closure is over ancestors and descendants, NOT siblings. `route 2` hangs off the same
    // virtual host as the match and leads somewhere else entirely; pulling it in because a
    // shared parent came in would drag most of the graph back within two hops.
    const found = searchGraph(graph, 'api_service')!
    expect(labelsOf(found.relevant)).not.toContain('route 2')
    expect(labelsOf(found.relevant)).not.toContain('web_service')
  })

  test('an endpoint address reaches all the way up to the listener', () => {
    const found = searchGraph(graph, '8080')!
    expect(labelsOf(found.matched)).toEqual(['api:8080'])
    expect(labelsOf(found.relevant)).toContain('ingress')
  })

  test('detail is searched as well as label, case-insensitively', () => {
    // None of these are names. A path prefix, a listener's address and a cluster's type all
    // live in `detail`, and they are most of what somebody actually has to hand.
    expect(labelsOf(searchGraph(graph, '/api')!.matched)).toEqual(['route 1'])
    expect(labelsOf(searchGraph(graph, '0.0.0.0:10000')!.matched)).toEqual(['ingress'])
    expect(labelsOf(searchGraph(graph, 'static')!.matched)).toEqual(['api_service', 'web_service'])
    expect(labelsOf(searchGraph(graph, 'API_SERVICE')!.matched)).toEqual(['api_service'])
  })

  test('a blank query is not the same as a query that matched nothing', () => {
    // `null` means "not searching" and has to be distinguishable from an empty result, or
    // an unfilled search box filters the entire graph away.
    expect(searchGraph(graph, '')).toBeNull()
    expect(searchGraph(graph, '   ')).toBeNull()
    expect(searchGraph(graph, 'no-such-thing')!.relevant.size).toBe(0)
  })

  test('nothing excluded ever contains something included', () => {
    // The precondition the source mask rests on. The mask is the union of the ranges of the
    // EXCLUDED nodes, which is only a sound way to grey out irrelevant config if an excluded
    // node's block can never have an included node's block inside it. Ancestor closure is
    // what buys that, so this is really a test of the closure rather than of the mask.
    //
    // Dangling placeholders are skipped for the same reason the mask skips them: their range
    // belongs to whatever referred to them, not to them.
    const real = graph.nodes.filter((n) => n.problem !== 'dangling')

    for (const query of ['api_service', '/api', '8080', 'backend', 'web_service', 'chain']) {
      const found = searchGraph(graph, query)!
      for (const outer of real) {
        if (found.relevant.has(outer.id)) continue
        for (const inner of real) {
          if (inner === outer || !found.relevant.has(inner.id)) continue
          const contains =
            outer.range.line <= inner.range.line && outer.range.endLine >= inner.range.endLine
          expect(contains, `"${outer.label}" is masked but contains "${inner.label}"`).toBe(false)
        }
      }
    }
  })
})

describe('laying out a subset', () => {
  const graph = graphOf(FRONT_PROXY)
  const whole = layoutGraph(graph)

  test('draws what was included and nothing else', () => {
    const relevant = searchGraph(graph, 'api_service')!.relevant
    const layout = layoutGraph(graph, relevant)
    expect(layout.nodes.every((n) => relevant.has(n.id))).toBe(true)
    expect(layout.nodes.length).toBe(relevant.size)
  })

  test('an edge with an end outside the set is dropped rather than drawn into space', () => {
    const relevant = searchGraph(graph, 'api_service')!.relevant
    const layout = layoutGraph(graph, relevant)
    for (const edge of layout.edges) {
      expect(relevant.has(edge.from) && relevant.has(edge.to)).toBe(true)
    }
  })

  test('what survives is packed, not left sitting in the rows it had', () => {
    // The reason `include` is a parameter of the layout rather than a filter applied to its
    // output. Order the whole graph and then remove nodes and every column comes back as a
    // comb of gaps, because the barycentre pass has already assigned rows to things that are
    // not going to be drawn. Consecutive nodes in a column must be exactly one step apart.
    const kept = new Set(graph.nodes.filter((n) => n.kind !== 'endpoint').map((n) => n.id))
    const layout = layoutGraph(graph, kept)

    const byColumn = new Map<number, number[]>()
    for (const node of layout.nodes) {
      byColumn.set(node.column, [...(byColumn.get(node.column) ?? []), node.y])
    }
    // Non-vacuous: routes and clusters both keep two nodes here.
    expect([...byColumn.values()].some((tops) => tops.length > 1)).toBe(true)
    for (const tops of byColumn.values()) {
      const sorted = [...tops].sort((a, b) => a - b)
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]! - sorted[i - 1]!).toBe(NODE_H + GAP_Y)
      }
    }
  })

  test('a column the filter emptied collapses, like an absent one', () => {
    const kept = new Set(graph.nodes.filter((n) => n.kind !== 'endpoint').map((n) => n.id))
    const layout = layoutGraph(graph, kept)
    expect(layout.headers.map((h) => h.title)).not.toContain('Endpoints')
    expect(layout.width).toBeLessThan(whole.width)
  })

  test('filtering makes the canvas shorter, which is the whole point of hiding', () => {
    // Every column still has something in it here, so the width is unchanged — it is the
    // tallest column that shrinks, from two routes and two clusters down to one of each.
    const layout = layoutGraph(graph, searchGraph(graph, 'api_service')!.relevant)
    expect(layout.height).toBeLessThan(whole.height)
  })

  test('including nothing lays out to nothing, without dividing by zero', () => {
    const layout = layoutGraph(graph, new Set())
    expect(layout.nodes).toEqual([])
    expect(layout.edges).toEqual([])
    expect(layout.headers).toEqual([])
    expect(Number.isFinite(layout.height)).toBe(true)
  })
})

describe('ordering within a column', () => {
  test('children follow the order of their parents', () => {
    // Two listeners, each with its own cluster. The clusters should come out in the same
    // order as the listeners that reach them — that is the barycentre pass doing its job,
    // and without it the second listener's edge crosses the first one's.
    const layout = layoutGraph(
      graphOf(`
static_resources:
  listeners:
  - name: first
    address: { socket_address: { address: 0.0.0.0, port_value: 1 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: va
              domains: ["a.example"]
              routes: [{ match: { prefix: "/" }, route: { cluster: alpha } }]
  - name: second
    address: { socket_address: { address: 0.0.0.0, port_value: 2 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            virtual_hosts:
            - name: vb
              domains: ["b.example"]
              routes: [{ match: { prefix: "/" }, route: { cluster: beta } }]
  clusters:
  - name: alpha
  - name: beta
`),
    )
    const y = (label: string) => layout.nodes.find((n) => n.label === label)!.y
    expect(y('first')).toBeLessThan(y('second'))
    expect(y('alpha')).toBeLessThan(y('beta'))
    expect(y('va')).toBeLessThan(y('vb'))
  })
})
