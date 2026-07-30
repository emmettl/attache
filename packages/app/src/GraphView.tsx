import { useMemo, useState } from 'react'
import { NODE_H, NODE_W, layoutGraph } from './graphLayout.js'
import { useStore } from './store.js'

// The config drawn as a graph, with the edges actually drawn.
//
// This used to be columns of cards that listed their targets as text — "→ api_service" —
// which is a table wearing a graph's clothes. The whole reason to draw an Envoy config is
// that the connections are the part you cannot see in the file: a route names a cluster in
// a string, and the two can sit four hundred lines apart. A line between them is the point.
//
// Positions come from `graphLayout.ts`. Nodes are HTML on top of an SVG edge layer rather
// than SVG text, because text in SVG can neither wrap nor ellipsise, and cluster names are
// exactly the sort of thing that overflows.

export function GraphView() {
  const graph = useStore((s) => s.graph)
  const revealLine = useStore((s) => s.revealLine)
  const setHighlight = useStore((s) => s.setHighlight)
  const [hovered, setHovered] = useState<string | null>(null)

  const layout = useMemo(() => layoutGraph(graph), [graph])

  /** Everything one hop from the hovered node, plus the node itself. */
  const lit = useMemo(() => {
    if (hovered === null) return null
    const near = new Set<string>([hovered])
    for (const edge of layout.edges) {
      if (edge.from === hovered) near.add(edge.to)
      if (edge.to === hovered) near.add(edge.from)
    }
    return near
  }, [hovered, layout.edges])

  if (layout.nodes.length === 0) {
    return (
      <div className="panel-body">
        <p className="muted">Nothing to draw yet — this config has no listeners or clusters.</p>
      </div>
    )
  }

  const nodeState = (id: string) => (lit === null ? '' : lit.has(id) ? 'lit' : 'dim')
  const edgeState = (from: string, to: string) =>
    hovered === null ? '' : from === hovered || to === hovered ? 'lit' : 'dim'

  return (
    <div className="panel-body graph-scroll">
      <div
        className="graph-canvas"
        style={{ width: layout.width, height: layout.height }}
        onMouseLeave={() => {
          setHovered(null)
          setHighlight(null)
        }}
      >
        <svg className="graph-edges" width={layout.width} height={layout.height}>
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 1 L7 4 L0 7 z" fill="currentColor" />
            </marker>
          </defs>

          {layout.edges.map((edge, i) => (
            <g
              key={i}
              className={`edge ${edge.dangling ? 'dangling' : ''} ${edgeState(edge.from, edge.to)}`}
            >
              <path d={edge.path} markerEnd="url(#arrow)" />
              {edge.label && edgeState(edge.from, edge.to) === 'lit' && (
                <text x={edge.labelX} y={edge.labelY - 7} textAnchor="middle">
                  {edge.label}
                </text>
              )}
            </g>
          ))}
        </svg>

        {layout.headers.map((header) => (
          <span key={header.title} className="graph-header" style={{ left: header.x }}>
            {header.title}
          </span>
        ))}

        {layout.nodes.map((node) => (
          <button
            key={node.id}
            className={`graph-node ${node.kind} ${node.problem ?? ''} ${nodeState(node.id)}`}
            style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
            onMouseEnter={() => {
              setHovered(node.id)
              // The node's range spans its whole block, so this bands the entire listener
              // or cluster rather than just the line its name is on.
              setHighlight({ startLine: node.range.line, endLine: node.range.endLine })
            }}
            onFocus={() => {
              setHovered(node.id)
              setHighlight({ startLine: node.range.line, endLine: node.range.endLine })
            }}
            onClick={() => revealLine(node.range.line)}
            title={
              node.problem === 'dangling'
                ? `${node.label} — referred to, but not defined in this config`
                : node.problem === 'orphan'
                  ? `${node.label} — nothing routes here`
                  : node.label
            }
          >
            <span className="graph-label">{node.label}</span>
            {node.detail && <span className="graph-detail">{node.detail}</span>}
          </button>
        ))}
      </div>

      <p className="graph-key">
        Hover a node to trace what it reaches.
        <span className="key-swatch dangling" /> referred to, not defined here
        <span className="key-swatch orphan" /> nothing routes here
      </p>
    </div>
  )
}
