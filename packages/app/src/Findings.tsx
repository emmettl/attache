import { formatPath } from '@attache/core'
import { useStore } from './store.js'

// What the tool has to say, and what it has declined to say — side by side, on purpose.
//
// The unrecognised list is not a footnote. A checker that models a subset of Envoy's schema
// is only worth trusting if the size of the part it did not check is as visible as the part
// it did, and putting that count anywhere less prominent than the findings themselves would
// quietly convert "I found nothing" into "there is nothing", which is the one claim this
// app must never make.

export function Findings() {
  const diagnostics = useStore((s) => s.analysis.diagnostics)
  const unknowns = useStore((s) => s.analysis.unknowns)
  const revealLine = useStore((s) => s.revealLine)

  return (
    <div className="panel-body">
      {diagnostics.length === 0 ? (
        <p className="muted">
          Nothing wrong in the part of this config Attaché models. That is not the same as a
          valid config — see the {unknowns.length} unrecognised {unknowns.length === 1 ? 'field' : 'fields'} below.
        </p>
      ) : (
        <ul className="findings">
          {diagnostics.map((d, i) => (
            <li key={i} className={`finding ${d.severity}`}>
              <button className="finding-head" onClick={() => revealLine(d.range.line)}>
                <span className={`badge ${d.severity}`}>{d.severity}</span>
                <span className="finding-message">{d.message}</span>
                <span className="line-ref">line {d.range.line}</span>
              </button>
              {d.detail && <p className="finding-detail">{d.detail}</p>}
              {d.path.length > 0 && <code className="finding-path">{formatPath(d.path)}</code>}
            </li>
          ))}
        </ul>
      )}

      <details className="unknowns" open={diagnostics.length === 0}>
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
              <button onClick={() => revealLine(u.range.line)}>
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
