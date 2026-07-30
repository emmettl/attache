import type { GraphNode, NodeKind } from '@attache/core'
import { useMemo } from 'react'
import { useStore } from './store.js'

// The config drawn as what it is.
//
// Laid out in columns by kind rather than by a force simulation or a layered graph
// algorithm: an Envoy config is already a cascade — listener, chain, routes, virtual host,
// route, cluster, endpoint — and a layout that discovers that for itself would spend a
// dependency and a lot of animation arriving where a CSS grid starts. Columns also stay
// readable at a hundred routes, which a spring layout does not.

const COLUMNS: { kind: NodeKind; title: string }[] = [
  { kind: 'listener', title: 'Listeners' },
  { kind: 'filterChain', title: 'Filter chains' },
  { kind: 'routeConfig', title: 'Route configs' },
  { kind: 'virtualHost', title: 'Virtual hosts' },
  { kind: 'route', title: 'Routes' },
  { kind: 'cluster', title: 'Clusters' },
  { kind: 'endpoint', title: 'Endpoints' },
]

export function GraphView() {
  const graph = useStore((s) => s.graph)
  const revealLine = useStore((s) => s.revealLine)

  const byKind = useMemo(() => {
    const out = new Map<NodeKind, GraphNode[]>()
    for (const node of graph.nodes) {
      const list = out.get(node.kind)
      if (list) list.push(node)
      else out.set(node.kind, [node])
    }
    return out
  }, [graph])

  /** What each node points at, so a card can name its own outgoing edges. */
  const outgoing = useMemo(() => {
    const labels = new Map<string, string>(graph.nodes.map((n) => [n.id, n.label]))
    const out = new Map<string, { to: string; label?: string; dangling?: boolean }[]>()
    for (const edge of graph.edges) {
      const entry = { to: labels.get(edge.to) ?? edge.to, label: edge.label, dangling: edge.dangling }
      const list = out.get(edge.from)
      if (list) list.push(entry)
      else out.set(edge.from, [entry])
    }
    return out
  }, [graph])

  if (graph.nodes.length === 0) {
    return (
      <div className="panel-body">
        <p className="muted">Nothing to draw yet — this config has no listeners or clusters.</p>
      </div>
    )
  }

  return (
    <div className="panel-body graph">
      {COLUMNS.filter((column) => (byKind.get(column.kind)?.length ?? 0) > 0).map((column) => (
        <section key={column.kind} className="graph-column">
          <h3>{column.title}</h3>
          {byKind.get(column.kind)!.map((node) => (
            <button
              key={node.id}
              className={`graph-node ${node.kind} ${node.problem ?? ''}`}
              onClick={() => revealLine(node.range.line)}
            >
              <span className="graph-label">{node.label}</span>
              {node.detail && <span className="graph-detail">{node.detail}</span>}
              {node.problem === 'dangling' && (
                <span className="graph-flag dangling">referred to, not defined here</span>
              )}
              {node.problem === 'orphan' && (
                <span className="graph-flag orphan">nothing routes here</span>
              )}
              {(outgoing.get(node.id) ?? []).length > 0 && (
                <span className="graph-edges">
                  {(outgoing.get(node.id) ?? []).map((edge, i) => (
                    <span key={i} className={`graph-edge ${edge.dangling ? 'dangling' : ''}`}>
                      → {edge.to}
                      {edge.label && <em> ({edge.label})</em>}
                    </span>
                  ))}
                </span>
              )}
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}
