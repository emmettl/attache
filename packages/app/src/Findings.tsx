import { docsForCode, formatPath, type Severity } from '@attache/core'
import { useMemo, useState } from 'react'
import { useStore } from './store.js'

// What the tool has to say, and what it has declined to say — side by side, on purpose.
//
// The unrecognised list is not a footnote. A checker that models a subset of Envoy's schema
// is only worth trusting if the size of the part it did not check is as visible as the part
// it did, and putting that count anywhere less prominent than the findings themselves would
// quietly convert "I found nothing" into "there is nothing", which is the one claim this
// app must never make.

const SEVERITIES: Severity[] = ['error', 'warning', 'info']

export function Findings() {
  const diagnostics = useStore((s) => s.analysis.diagnostics)
  const unknowns = useStore((s) => s.analysis.unknowns)
  const revealLine = useStore((s) => s.revealLine)
  const setHighlight = useStore((s) => s.setHighlight)

  const [hidden, setHidden] = useState<Set<Severity>>(new Set())
  const [query, setQuery] = useState('')

  const counts = useMemo(() => {
    const out: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
    for (const d of diagnostics) out[d.severity]++
    return out
  }, [diagnostics])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return diagnostics.filter((d) => {
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
          valid config — see the {unknowns.length} unrecognised{' '}
          {unknowns.length === 1 ? 'field' : 'fields'} below.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted">{diagnostics.length} findings, none matching this filter.</p>
      ) : (
        <ul className="findings">
          {shown.map((d, i) => {
            const docs = docsForCode(d.code)
            return (
              <li
                key={i}
                className={`finding ${d.severity}`}
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
          {unknowns.length} {unknowns.length === 1 ? 'field' : 'fields'} Attaché does not model
          {unknowns.length > 0 && ' — not checked either way'}
        </summary>
        <p className="muted">
          Attaché models the listener → filter chain → route → cluster spine, because that is
          what decides where a request goes. Everything below is real Envoy configuration that
          it read past without an opinion. Its being here is not a complaint about your config.
        </p>
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
      </details>
    </div>
  )
}
