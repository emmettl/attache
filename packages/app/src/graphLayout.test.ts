import { analyse, buildGraph } from '@attache/core'
import { describe, expect, test } from 'vitest'
import { NODE_H, NODE_W, layoutGraph } from './graphLayout.js'

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
