import { docsForCode, formatPath, type Severity, type Unknown } from '@attache/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from './store.js'

// What the tool has to say, and what it has declined to say — side by side, on purpose.
//
// The unrecognised list is not a footnote. A checker that models a subset of Envoy's schema
// is only worth trusting if the size of the part it did not check is as visible as the part
// it did, and putting that count anywhere less prominent than the findings themselves would
// quietly convert "I found nothing" into "there is nothing", which is the one claim this
// app must never make.
//
// Two lists rather than one, because the single list was making two claims at once and
// leaning on the more alarming of them. A field Attaché has never heard of and a field it
// read and declined to judge are different admissions, and a config full of health checks
// and circuit breakers — which is to say any config that has been in production for a while
// — was being told the tool understood far less of it than it does.

const SEVERITIES: Severity[] = ['error', 'warning', 'info']

export function Findings() {
  const diagnostics = useStore((s) => s.analysis.diagnostics)
  const unknowns = useStore((s) => s.analysis.unknowns)
  const revealLine = useStore((s) => s.revealLine)
  const setHighlight = useStore((s) => s.setHighlight)
  const focus = useStore((s) => s.focus)

  const [hidden, setHidden] = useState<Set<Severity>>(new Set())
  const [query, setQuery] = useState('')
  /** Which finding the editor just asked for, and which firing of the ask this is. */
  const [flash, setFlash] = useState<{ index: number; nonce: number } | null>(null)
  const items = useRef(new Map<number, HTMLLIElement>())

  const counts = useMemo(() => {
    const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
    for (const d of diagnostics) out[d.severity]++
    return out
  }, [diagnostics])

  // Paired with the index into the UNFILTERED list, so a finding keeps the same identity
  // whatever the filter is doing. Without that, focusing one would mean finding it twice —
  // once to know it exists and once to know where the filter has put it.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return diagnostics.map((d, index) => ({ d, index })).filter(({ d }) => {
      if (hidden.has(d.severity)) return false
      if (needle === '') return true
      // The code and the path are searchable as well as the prose, so "cluster-not-found"
      // and "listeners[1]" both work — a filter that matched only the message would make
      // you guess its exact wording.
      return (
        d.message.toLowerCase().includes(needle) ||
        d.code.includes(needle) ||
        (d.detail?.toLowerCase().includes(needle) ?? false) ||
        formatPath(d.path).toLowerCase().includes(needle)
      )
    })
  }, [diagnostics, hidden, query])

  const toggle = (severity: Severity) =>
    setHidden((current) => {
      const next = new Set(current)
      if (next.has(severity)) next.delete(severity)
      else next.add(severity)
      return next
    })

  const filtering = hidden.size > 0 || query.trim() !== ''

  /**
   * The editor asked for the finding on a line. Clear whatever is hiding it, then flash it.
   *
   * The filter gives way, and that is the deliberate part. Somebody who clicks a marker in
   * the gutter has named one specific finding; leaving it hidden behind a search box they
   * typed into five minutes ago would make the marker look broken, and "it did nothing" is
   * a worse outcome than "it showed you what you asked for and dropped a filter to do it".
   */
  useEffect(() => {
    if (!focus) return
    const index = diagnostics.findIndex((d) => d.range.line === focus.line)
    if (index === -1) return
    setHidden(new Set())
    setQuery('')
    setFlash({ index, nonce: focus.nonce })
  }, [focus, diagnostics])

  // Separate from the effect above because the scroll has to happen AFTER the filter reset
  // has re-rendered — until then the element may not be in the list to scroll to.
  useEffect(() => {
    if (!flash) return
    items.current.get(flash.index)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    const timer = setTimeout(() => setFlash(null), 1400)
    return () => clearTimeout(timer)
  }, [flash])

  const unrecognised = useMemo(() => unknowns.filter((u) => u.kind === 'unrecognised'), [unknowns])
  const unvalidated = useMemo(() => unknowns.filter((u) => u.kind === 'unvalidated'), [unknowns])

  return (
    <div className="panel-body">
      {diagnostics.length > 0 && (
        <div className="filters">
          {SEVERITIES.map((severity) => (
            <button
              key={severity}
              className={`chip ${severity} ${hidden.has(severity) ? 'off' : ''}`}
              onClick={() => toggle(severity)}
              aria-pressed={!hidden.has(severity)}
              disabled={counts[severity] === 0}
            >
              {counts[severity]} {severity}
              {counts[severity] === 1 ? '' : 's'}
            </button>
          ))}
          <input
            className="filter-search"
            type="search"
            value={query}
            placeholder="Filter by message, code or path…"
            aria-label="Filter findings"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      )}

      {diagnostics.length === 0 ? (
        <p className="muted">
          Nothing wrong in the part of this config Attaché models. That is not the same as a
          valid config — see the {unknowns.length} {unknowns.length === 1 ? 'field' : 'fields'}{' '}
          below that it did not check.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted">{diagnostics.length} findings, none matching this filter.</p>
      ) : (
        <ul className="findings">
          {shown.map(({ d, index }) => {
            const docs = docsForCode(d.code)
            return (
              <li
                key={index}
                ref={(node) => {
                  if (node) items.current.set(index, node)
                  else items.current.delete(index)
                }}
                className={`finding ${d.severity}${flash?.index === index ? ' flash' : ''}`}
                onMouseEnter={() =>
                  setHighlight({ startLine: d.range.line, endLine: d.range.endLine })
                }
                onMouseLeave={() => setHighlight(null)}
              >
                <button className="finding-head" onClick={() => revealLine(d.range.line)}>
                  <span className={`badge ${d.severity}`}>{d.severity}</span>
                  <span className="finding-message">{d.message}</span>
                  <span className="line-ref">line {d.range.line}</span>
                </button>
                {d.detail && <p className="finding-detail">{d.detail}</p>}
                <div className="finding-foot">
                  {d.path.length > 0 && <code className="finding-path">{formatPath(d.path)}</code>}
                  {docs && (
                    <a
                      className="doc-link"
                      href={docs.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      // The code is the stable identity of a finding and the one thing you
                      // would paste into a search or an issue, so it goes where it can be
                      // read without cluttering the card.
                      title={`Envoy reference: ${docs.title} · ${d.code}`}
                    >
                      {docs.title} ↗
                    </a>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <details className="unknowns" open={diagnostics.length === 0 && !filtering}>
        <summary>
          {unknowns.length} {unknowns.length === 1 ? 'field' : 'fields'} Attaché did not check
        </summary>
        <p className="muted">
          Attaché models the listener → filter chain → route → cluster spine, because that is
          what decides where a request goes. Everything below is real Envoy configuration it
          had no opinion about. Its being here is not a complaint about your config.
        </p>

        <UnknownGroup
          heading={`${unrecognised.length} ${unrecognised.length === 1 ? 'field' : 'fields'} unrecognised`}
          blurb="Outside the model altogether. Attaché cannot tell you whether one of these is a corner of Envoy it has never modelled or a field name you have spelled wrong — only that nothing here asked for it."
          unknowns={unrecognised}
          revealLine={revealLine}
          setHighlight={setHighlight}
        />

        <UnknownGroup
          heading={`${unvalidated.length} read but not checked`}
          blurb="Recognised, and deliberately left alone. Health checks, circuit breakers, the innards of a filter Attaché has already named for you — real configuration whose correctness is not a judgement this can make."
          unknowns={unvalidated}
          revealLine={revealLine}
          setHighlight={setHighlight}
        />
      </details>
    </div>
  )
}

/**
 * One of the two lists, or nothing at all when it is empty.
 *
 * An empty group is dropped rather than rendered with a zero, because a heading reading
 * "0 fields unrecognised" is a green tick with extra steps — and the whole point of this
 * panel is that there is nowhere in it for one of those to appear.
 */
function UnknownGroup({
  heading,
  blurb,
  unknowns,
  revealLine,
  setHighlight,
}: {
  heading: string
  blurb: string
  unknowns: Unknown[]
  revealLine: (line: number) => void
  setHighlight: (block: { startLine: number; endLine: number } | null) => void
}) {
  if (unknowns.length === 0) return null

  return (
    <section className="unknown-group">
      <h3>{heading}</h3>
      <p className="muted">{blurb}</p>
      <ul className="unknown-list">
        {unknowns.map((u, i) => (
          <li key={i}>
            <button
              onClick={() => revealLine(u.range.line)}
              onMouseEnter={() =>
                setHighlight({ startLine: u.range.line, endLine: u.range.endLine })
              }
              onMouseLeave={() => setHighlight(null)}
            >
              <code>{formatPath(u.path)}</code>
              <span className="line-ref">line {u.range.line}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
