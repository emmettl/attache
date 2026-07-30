import { docsForKind } from '@attache/core'
import { useEffect, useMemo, useState } from 'react'
import { NODE_H, NODE_W, layoutGraph, searchGraph } from './graphLayout.js'
import { useStore, type LineRange } from './store.js'

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
//
// Search exists because the drawing stops working at scale. A production config with fifty
// services lays out as a wall of identical cards, and every question you might ask of it —
// what reaches this cluster, which listener serves this hostname — is answered by about
// eight nodes out of two hundred. So the search does not filter to what matched; it filters
// to the PATH through what matched, which is `searchGraph`'s job, and this file only decides
// how to show it.

type Mode = 'highlight' | 'hide'

export function GraphView() {
  const graph = useStore((s) => s.graph)
  const revealLine = useStore((s) => s.revealLine)
  const setHighlight = useStore((s) => s.setHighlight)
  const setMask = useStore((s) => s.setMask)
  const [hovered, setHovered] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<Mode>('highlight')
  const [showEndpoints, setShowEndpoints] = useState(true)

  // Matching runs against the WHOLE graph, endpoint toggle or not. The toggle is about how
  // much of the drawing you want to look at; it is not a statement that endpoint addresses
  // have stopped being searchable. Typing `10.0.0.1` with endpoints hidden should still
  // surface the cluster that has it, and it does, because the endpoint is still in here to
  // be matched and to pull its ancestors in — it simply is not drawn afterwards.
  const search = useMemo(() => searchGraph(graph, query), [graph, query])

  const include = useMemo(() => {
    if (search === null && showEndpoints) return undefined
    const keep = new Set<string>()
    for (const node of graph.nodes) {
      if (!showEndpoints && node.kind === 'endpoint') continue
      if (search !== null && mode === 'hide' && !search.relevant.has(node.id)) continue
      keep.add(node.id)
    }
    return keep
  }, [graph, search, mode, showEndpoints])

  const layout = useMemo(() => layoutGraph(graph, include), [graph, include])

  /**
   * The parts of the source that are NOT relevant, for the editor to grey out.
   *
   * This is deliberately the inverse of what you would reach for first. Keeping the ranges
   * of the relevant nodes and masking everything else sounds equivalent and is not, because
   * node ranges NEST: a listener's range spans lines 4 to 26 and every route it serves lives
   * inside that span. Keep the listener because it is on the path and you have kept every
   * route under it, so the mask can never narrow anything WITHIN a listener — which is
   * precisely where a config with fifty services needs narrowing. Inverting it makes each
   * excluded node grey exactly its own lines: an irrelevant route greys four lines inside a
   * listener that stays legible, and a wholly irrelevant listener greys its whole block.
   * There is no arithmetic over nested intervals anywhere, which is the other half of why
   * this is the right way round.
   *
   * That only holds because `searchGraph` closes the relevant set over ANCESTORS. Given
   * that, an excluded node can never contain an included one — if a child is relevant its
   * parent is too — so a mask range can never swallow something the search decided to keep.
   * Weaken the closure to matches-and-descendants and this silently starts greying out the
   * very lines the user searched for, with nothing in the graph to show that it happened.
   *
   * Dangling placeholders are left out. Their range is BORROWED from whatever referred to
   * them — a missing cluster points at the route that named it, an RDS stand-in at the
   * connection manager — so masking one greys lines belonging to a node that may well be
   * relevant itself. They own no source, so they mask none.
   */
  const maskRanges = useMemo<LineRange[] | null>(() => {
    if (search === null) return null
    return graph.nodes
      .filter((node) => !search.relevant.has(node.id) && node.problem !== 'dangling')
      .map((node) => ({ startLine: node.range.line, endLine: node.range.endLine }))
  }, [graph, search])

  useEffect(() => {
    setMask(maskRanges)
  }, [maskRanges, setMask])

  // Leaving the tab has to lift the mask. The editor is on screen whichever tab is showing,
  // and a source pane still half greyed out by a search on a panel nobody can see is a
  // permanently broken-looking editor with no visible cause.
  useEffect(() => () => setMask(null), [setMask])

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

  if (graph.nodes.length === 0) {
    return (
      <div className="panel-body">
        <p className="muted">Nothing to draw yet — this config has no listeners or clusters.</p>
      </div>
    )
  }

  // Only highlight mode has anything to dim: in hide mode the irrelevant nodes are not in
  // the layout at all, so everything drawn is relevant by construction.
  const relevant = search !== null && mode === 'highlight' ? search.relevant : null

  // Search dimming and hover dimming land on the same class, and search wins where they
  // disagree. They have to be ranked rather than merged, because the relevant set is closed
  // over ancestors and descendants but NOT over siblings: hovering a virtual host that the
  // search kept lights its routes, and some of those routes are the ones the search just
  // ruled out. Letting the hover raise them would undo the filter a hop at a time, which is
  // the opposite of what hovering is for once you have asked a question of the graph.
  const nodeState = (id: string) => {
    if (relevant !== null && !relevant.has(id)) return 'dim'
    if (lit === null) return ''
    return lit.has(id) ? 'lit' : 'dim'
  }

  const edgeState = (from: string, to: string) => {
    if (relevant !== null && (!relevant.has(from) || !relevant.has(to))) return 'dim'
    if (hovered === null) return ''
    return from === hovered || to === hovered ? 'lit' : 'dim'
  }

  return (
    <div className="panel-body graph-panel">
      <div className="graph-scroll">
        {layout.nodes.length === 0 ? (
          <p className="muted">
            Nothing in this config matches <code>{query.trim()}</code> — searched every node's
            name and detail.
          </p>
        ) : (
          <>
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
                  className={`graph-node ${node.kind} ${node.problem ?? ''} ${nodeState(node.id)} ${
                    search?.matched.has(node.id) ? 'hit' : ''
                  }`}
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
              Hover a node to trace what it reaches and band it in the source.
              <span className="key-swatch dangling" /> referred to, not defined here
              <span className="key-swatch orphan" /> nothing routes here
            </p>
          </>
        )}

        {/* The reference for whatever is under the cursor. Envoy's docs are generated from the
            protos and hard to navigate — landing on the right message is most of the value, so
            the link follows the hover rather than making you go and find it. */}
        {hovered !== null &&
          (() => {
            const node = layout.nodes.find((n) => n.id === hovered)
            const docs = node && docsForKind(node.kind)
            return docs ? (
              <p className="graph-doc">
                <a href={docs.url} target="_blank" rel="noreferrer noopener">
                  Envoy reference: {docs.title} ↗
                </a>
              </p>
            ) : null
          })()}
      </div>

      <SearchPanel
        query={query}
        setQuery={setQuery}
        mode={mode}
        setMode={setMode}
        showEndpoints={showEndpoints}
        setShowEndpoints={setShowEndpoints}
        shown={search === null ? graph.nodes.length : search.relevant.size}
        total={graph.nodes.length}
      />
    </div>
  )
}

/**
 * The floating control, over the canvas rather than above it.
 *
 * It is positioned against the pane and not against the scrolling box, which is the one
 * detail that makes it work: an absolutely positioned child of a scroll container scrolls
 * away with the content, and a search box you have to scroll back to the origin to reach is
 * worse than a stationary one taking up a row. Hence the extra wrapper in `styles.css` —
 * `.graph-panel` is the positioned ancestor and `.graph-scroll` moves underneath it.
 */
function SearchPanel({
  query,
  setQuery,
  mode,
  setMode,
  showEndpoints,
  setShowEndpoints,
  shown,
  total,
}: {
  query: string
  setQuery: (query: string) => void
  mode: Mode
  setMode: (mode: Mode) => void
  showEndpoints: boolean
  setShowEndpoints: (show: boolean) => void
  shown: number
  total: number
}) {
  return (
    <div className="graph-search" role="search">
      <input
        className="filter-search"
        type="search"
        value={query}
        placeholder="Search names and details…"
        aria-label="Search the graph"
        onChange={(event) => setQuery(event.target.value)}
        // Escape clears rather than blurs. The browser's own behaviour on a search input is
        // to clear it and keep focus, which is what somebody pressing Escape here means —
        // but it does not fire in every engine, and a search that half-clears depending on
        // the browser is worse than one that never did.
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            setQuery('')
          }
        }}
      />

      <div className="graph-search-foot">
        {/* "15 nodes" while idle, "6 of 15" once filtering — the word is dropped rather than
            repeated because this row has to hold three controls inside a panel that floats
            over the drawing, and every pixel it grows is drawing it covers. */}
        <span
          className="graph-search-count"
          aria-live="polite"
          title={
            query.trim() === ''
              ? undefined
              : 'Nodes that matched, plus everything up- and downstream of them — the whole path a request takes through them.'
          }
        >
          {query.trim() === '' ? `${total} nodes` : `${shown} of ${total}`}
        </span>

        {/* Highlight is the default because dimming keeps your bearings: you can see WHERE
            the answer sits in the config, which for "does anything else serve this host?" is
            most of the answer. Hide is the one you reach for when the wall is so large that
            even a dimmed version of it is unreadable. */}
        <div className="segmented" role="group" aria-label="What to do with non-matching nodes">
          <button aria-pressed={mode === 'highlight'} onClick={() => setMode('highlight')}>
            Highlight
          </button>
          <button aria-pressed={mode === 'hide'} onClick={() => setMode('hide')}>
            Hide
          </button>
        </div>

        {/* Endpoints are usually half the nodes in a real config and are almost never what
            you navigate BY — you look for a cluster or a hostname and read the addresses
            once you have found it. Dropping the column is the cheapest readability win
            available here. It still defaults to ON: this app's whole position is that it
            says what it is not showing you, and a column silently missing on first load is
            the one kind of omission it should not be making, however useful. A struck
            through chip is the same vocabulary the findings filter already uses. */}
        <button
          className={`chip ${showEndpoints ? '' : 'off'}`}
          aria-pressed={showEndpoints}
          onClick={() => setShowEndpoints(!showEndpoints)}
          title="Draw the endpoints column. Addresses stay searchable either way."
        >
          Endpoints
        </button>
      </div>
    </div>
  )
}
