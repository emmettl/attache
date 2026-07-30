import type { Graph, GraphNode, NodeKind } from '@attache/core'

// Turning the graph into coordinates.
//
// Layered left to right, because the config already is one: a request meets a listener,
// then a filter chain, then a route config, a virtual host, a route, a cluster, an
// endpoint. Every edge points one column rightwards, so this is a proper DAG with the
// layering handed to us — no need to discover it with a force simulation, which would
// spend a dependency and a lot of animation arriving somewhere less readable and different
// every time you looked.
//
// What layering does NOT give you is the order WITHIN a column, and that is the whole
// difference between a diagram and a plate of spaghetti. Hence the barycentre passes
// below.
//
// Search lives in this file too, next to `layoutGraph`, because the two are not really
// separable: hiding what a search excluded is a layout question, not a styling one. Filter
// the nodes on the way out and the barycentre ordering has already reserved a row for
// everything you removed, so you get the same wall with holes in it. `layoutGraph` takes
// the search's answer as an `include` set instead, and lays out only what survives.

export const COLUMNS: { kind: NodeKind; title: string }[] = [
  { kind: 'listener', title: 'Listeners' },
  { kind: 'filterChain', title: 'Filter chains' },
  { kind: 'routeConfig', title: 'Route configs' },
  { kind: 'virtualHost', title: 'Virtual hosts' },
  { kind: 'route', title: 'Routes' },
  { kind: 'cluster', title: 'Clusters' },
  { kind: 'endpoint', title: 'Endpoints' },
]

export const NODE_W = 188
export const NODE_H = 52
export const GAP_Y = 14
/** Horizontal room between columns. This is where the edges live, so it is generous. */
const GAP_X = 82
const PAD_X = 18
const PAD_TOP = 34

export interface PositionedNode extends GraphNode {
  x: number
  y: number
  column: number
}

export interface PositionedEdge {
  from: string
  to: string
  label?: string
  dangling?: boolean
  /** A cubic bezier from the right edge of `from` to the left edge of `to`. */
  path: string
  /** Midpoint, for placing the label. */
  labelX: number
  labelY: number
}

export interface Layout {
  nodes: PositionedNode[]
  edges: PositionedEdge[]
  /** Which column headers to draw, and where. Empty columns are skipped entirely. */
  headers: { title: string; x: number }[]
  width: number
  height: number
}

const columnOf = (kind: NodeKind): number => COLUMNS.findIndex((c) => c.kind === kind)

/**
 * Both edge directions as adjacency lists, over a stated set of nodes.
 *
 * Edges with an end outside `present` are dropped rather than followed to a node that is
 * not there. That is what makes laying out a subset safe: `graph.edges` is built against
 * the whole graph and knows nothing about a filter applied afterwards.
 */
function adjacency(
  graph: Graph,
  present: ReadonlySet<string>,
): { parents: Map<string, string[]>; children: Map<string, string[]> } {
  const parents = new Map<string, string[]>()
  const children = new Map<string, string[]>()
  const link = (into: Map<string, string[]>, key: string, value: string) => {
    const existing = into.get(key)
    if (existing) existing.push(value)
    else into.set(key, [value])
  }
  for (const edge of graph.edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue
    link(children, edge.from, edge.to)
    link(parents, edge.to, edge.from)
  }
  return { parents, children }
}

export interface GraphSearch {
  /** Nodes whose own label or detail contains the query. */
  matched: Set<string>
  /** `matched`, closed over ancestors and descendants. What the search should keep. */
  relevant: Set<string>
}

/**
 * What a query selects — and the answer is never just "the nodes that matched".
 *
 * A search that kept only the matches would be useless on the config this exists for. Type
 * a cluster name and the matching node is a card floating on its own, with the one thing
 * you actually wanted to know — how a request gets to it — filtered away. What you meant by
 * typing a cluster name is "show me this cluster IN CONTEXT": the routes that reach it, the
 * virtual host above them, the route configuration, the filter chain, the listener, and the
 * endpoints underneath. That is the whole path through the graph, in both directions.
 *
 * So the answer is the transitive closure of the matches over ancestors and descendants.
 * Sideways does not count: a sibling route under the same virtual host is not on the path
 * to anything you asked about, and pulling in siblings would drag back most of the graph
 * within two hops — the closure of a listener's descendants is everything the listener
 * serves, and a match anywhere under it would resurrect all of it.
 *
 * The two directions are walked with SEPARATE visited sets and unioned at the end. Sharing
 * one is the obvious economy and it is wrong: a node can be an ancestor of one match and a
 * descendant of another, and if the upward walk has already marked it seen, the downward
 * walk stops there and silently loses everything below it.
 *
 * The ancestor half of this is load-bearing outside the graph — `GraphView` derives the
 * source-pane mask from the nodes this did NOT return, and that inversion is only
 * well-defined because an excluded node can never contain an included one. See the comment
 * on the mask there before weakening this to matches-plus-descendants or anything similar.
 *
 * Returns `null` for a blank query, which means "no search", not "nothing matched" — the
 * caller has to tell those apart to know whether to filter at all.
 */
export function searchGraph(graph: Graph, query: string): GraphSearch | null {
  const needle = query.trim().toLowerCase()
  if (needle === '') return null

  const matched = new Set<string>()
  for (const node of graph.nodes) {
    // `detail` is searched as well as `label`, and it is where half the things a person
    // would type actually live: an endpoint's address, a route's `prefix /gru/api`, a
    // virtual host's `*.foo.com`, a cluster's `EDS`. Matching names alone would mean the
    // search only finds what somebody happened to name, and Envoy configs are full of
    // routes and chains that are never named at all.
    if (
      node.label.toLowerCase().includes(needle) ||
      (node.detail !== undefined && node.detail.toLowerCase().includes(needle))
    ) {
      matched.add(node.id)
    }
  }

  const { parents, children } = adjacency(graph, new Set(graph.nodes.map((n) => n.id)))

  /** Everything reachable from the matches along one direction, matches included. */
  const reach = (adjacent: Map<string, string[]>): Set<string> => {
    const seen = new Set(matched)
    const pending = [...matched]
    while (pending.length > 0) {
      for (const next of adjacent.get(pending.pop()!) ?? []) {
        // Guarding on `seen` rather than trusting the graph to be acyclic: this walks
        // whatever `buildGraph` produced, and a hang is a worse way to find out that
        // something upstream started emitting a cycle than a slightly wide match set.
        if (seen.has(next)) continue
        seen.add(next)
        pending.push(next)
      }
    }
    return seen
  }

  return { matched, relevant: new Set([...reach(parents), ...reach(children)]) }
}

/**
 * Order each column by the average position of what it connects to.
 *
 * The classic barycentre heuristic. Sweeping forward puts each node near its parents;
 * sweeping back puts it near its children; alternating a few times settles most graphs
 * into something with few crossings. It is not optimal — minimising crossings exactly is
 * NP-hard — but the shapes an Envoy config makes are shallow and close to a tree, and two
 * round trips are enough to stop the edges tangling.
 *
 * Nodes with nothing to average over keep the order `buildGraph` produced, which is source
 * order, which is the order the person wrote them in.
 */
function order(columns: string[][], parents: Map<string, string[]>, children: Map<string, string[]>): void {
  const indexIn = (column: string[], id: string) => column.indexOf(id)

  const sweep = (column: string[], neighbours: Map<string, string[]>, against: string[]) => {
    const score = new Map<string, number>()
    column.forEach((id, fallback) => {
      const linked = (neighbours.get(id) ?? [])
        .map((other) => indexIn(against, other))
        .filter((i) => i >= 0)
      // No neighbour in the adjacent column? Keep where you are, rather than being sorted
      // to the top by a default of zero.
      score.set(id, linked.length === 0 ? fallback : linked.reduce((a, b) => a + b, 0) / linked.length)
    })
    column.sort((a, b) => score.get(a)! - score.get(b)!)
  }

  for (let pass = 0; pass < 2; pass++) {
    for (let c = 1; c < columns.length; c++) {
      if (columns[c - 1]!.length > 0) sweep(columns[c]!, parents, columns[c - 1]!)
    }
    for (let c = columns.length - 2; c >= 0; c--) {
      if (columns[c + 1]!.length > 0) sweep(columns[c]!, children, columns[c + 1]!)
    }
  }
}

/**
 * Coordinates for a graph, or for the part of one named by `include`.
 *
 * `include` is not a display filter applied at the end — the whole point of it is that it
 * arrives before the ordering does. Lay out everything and hide the surplus afterwards and
 * the barycentre pass has already sorted rows for nodes that are not going to be drawn, so
 * every column comes out as a comb of gaps and the compaction that made hiding worth doing
 * never happens. Filtering here means the columns only ever contain what survives, and the
 * existing collapse of empty columns then falls out for free: filter every endpoint away
 * and the Endpoints header disappears with them rather than heading a blank stripe.
 *
 * Omit it and nothing is filtered, which is the no-search case.
 */
export function layoutGraph(graph: Graph, include?: ReadonlySet<string>): Layout {
  const visible = include === undefined ? graph.nodes : graph.nodes.filter((n) => include.has(n.id))
  const byId = new Map(visible.map((n) => [n.id, n]))

  const { parents, children } = adjacency(graph, new Set(byId.keys()))

  const columns: string[][] = COLUMNS.map(() => [])
  for (const node of visible) {
    const column = columnOf(node.kind)
    if (column >= 0) columns[column]!.push(node.id)
  }

  order(columns, parents, children)

  // Empty columns are dropped rather than left as a gap, so a config with no endpoints
  // does not render a stripe of nothing on the right.
  const present = columns.map((ids, i) => ({ ids, i })).filter((c) => c.ids.length > 0)

  const tallest = Math.max(1, ...present.map((c) => c.ids.length))
  const height = PAD_TOP + tallest * NODE_H + (tallest - 1) * GAP_Y + PAD_X
  const width = PAD_X + present.length * NODE_W + Math.max(0, present.length - 1) * GAP_X + PAD_X

  const nodes: PositionedNode[] = []
  const position = new Map<string, { x: number; y: number }>()

  present.forEach((column, slot) => {
    const x = PAD_X + slot * (NODE_W + GAP_X)
    const columnHeight = column.ids.length * NODE_H + (column.ids.length - 1) * GAP_Y
    // Columns are centred against each other, so a single cluster sits opposite the routes
    // that reach it rather than pinned to the top.
    const top = PAD_TOP + (height - PAD_TOP - PAD_X - columnHeight) / 2

    column.ids.forEach((id, row) => {
      const y = top + row * (NODE_H + GAP_Y)
      position.set(id, { x, y })
      nodes.push({ ...byId.get(id)!, x, y, column: slot })
    })
  })

  const edges: PositionedEdge[] = []
  for (const edge of graph.edges) {
    const from = position.get(edge.from)
    const to = position.get(edge.to)
    if (!from || !to) continue

    const sx = from.x + NODE_W
    const sy = from.y + NODE_H / 2
    const tx = to.x
    const ty = to.y + NODE_H / 2
    // Control points pushed out horizontally, so edges leave and arrive level and the
    // curve reads as a connection rather than a diagonal slash across the canvas.
    const bend = Math.max(28, (tx - sx) * 0.45)

    edges.push({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      dangling: edge.dangling,
      path: `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`,
      labelX: (sx + tx) / 2,
      labelY: (sy + ty) / 2,
    })
  }

  return {
    nodes,
    edges,
    headers: present.map((column, slot) => ({
      title: COLUMNS[column.i]!.title,
      x: PAD_X + slot * (NODE_W + GAP_X),
    })),
    width,
    height,
  }
}
