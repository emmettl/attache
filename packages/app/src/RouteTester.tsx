import { useEffect, useMemo } from 'react'
import { headerNotes, useStore } from './store.js'

// Ask a question about a request, get the decision and everything it beat.
//
// The losers are the point. "It went to the wrong cluster" is almost never answered by
// looking at the route that won — the useful answer is which route took it first, or which
// virtual host was more specific than the one you were reading. So every stage renders its
// rejected candidates with the reason, and the reasons are sentences rather than codes,
// because the person reading them is usually mid-incident.

export function RouteTester() {
  const request = useStore((s) => s.request)
  const setRequest = useStore((s) => s.setRequest)
  const match = useStore((s) => s.match)
  const runMatch = useStore((s) => s.runMatch)
  const revealLine = useStore((s) => s.revealLine)

  const notes = useMemo(() => headerNotes(request.headers), [request.headers])

  useEffect(() => {
    if (!match) runMatch()
  }, [match, runMatch])

  return (
    <div className="panel-body">
      <div className="request-form">
        <label>
          <span>Method</span>
          <input value={request.method} onChange={(e) => setRequest({ method: e.target.value })} />
        </label>
        <label className="wide">
          <span>:authority</span>
          <input
            value={request.authority}
            onChange={(e) => setRequest({ authority: e.target.value })}
          />
        </label>
        <label className="wide">
          <span>:path</span>
          <input value={request.path} onChange={(e) => setRequest({ path: e.target.value })} />
        </label>
        <label>
          <span>Port</span>
          <input value={request.port} onChange={(e) => setRequest({ port: e.target.value })} />
        </label>
        <label>
          <span>SNI</span>
          <input
            value={request.serverName}
            placeholder="none"
            onChange={(e) => setRequest({ serverName: e.target.value })}
          />
        </label>
        <label className="full">
          <span>Headers — one `name: value` per line</span>
          <textarea
            rows={2}
            value={request.headers}
            placeholder="x-canary: yes"
            onChange={(e) => setRequest({ headers: e.target.value })}
          />
        </label>

        {/*
          The lines this box threw away. Dropping them is right — the pseudo-headers have
          their own fields, and a second copy here could only disagree — but dropping them
          in silence is what made `:method: POST` indistinguishable from the tester ignoring
          a `:method` route matcher. One goes nowhere and says nothing; so does the other.

          `aria-live`, because the notes appear as a consequence of typing somewhere else on
          the page: a screen reader user gets no cue that anything arrived below the box
          otherwise.
        */}
        {notes.length > 0 && (
          <ul className="header-notes full" aria-live="polite">
            {notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        )}
      </div>

      {match && (
        <>
          <p className={`verdict ${match.outcome}`}>{match.explanation}</p>

          {/*
            Above the caveats, and styled apart from them, because it is the opposite kind of
            statement. A caveat says the answer might be wrong. A rewrite says the answer is
            right and here is the step that would otherwise make it look wrong — which is the
            more useful half when a request lands somewhere the route table does not appear
            to send it.
          */}
          {match.rewrites.length > 0 && (
            <ul className="rewrites">
              {match.rewrites.map((rewrite, i) => (
                <li key={i}>{rewrite}</li>
              ))}
            </ul>
          )}

          {match.caveats.length > 0 && (
            <ul className="caveats">
              {match.caveats.map((caveat, i) => (
                <li key={i}>{caveat}</li>
              ))}
            </ul>
          )}

          <Stage
            title="Listener"
            attempts={match.listenerAttempts.map((a) => ({
              label: a.candidate.name ?? 'unnamed listener',
              detail: a.candidate.address
                ? `${a.candidate.address.address ?? '*'}:${a.candidate.address.portValue ?? '?'}`
                : undefined,
              matched: a.matched,
              reason: a.reason,
              line: a.candidate.range.line,
            }))}
            onReveal={revealLine}
          />

          <Stage
            title="Filter chain"
            attempts={match.chainAttempts.map((a) => ({
              label: a.candidate.name ?? `chain ${a.index + 1}`,
              detail: a.candidate.match?.serverNames.join(', ') || undefined,
              matched: a.matched,
              reason: a.reason,
              line: a.candidate.range.line,
            }))}
            onReveal={revealLine}
          />

          <Stage
            title="Virtual host"
            note={
              match.domainMatch &&
              `Selected by \`${match.domainMatch.pattern}\` (${label(match.domainMatch.precedence)}). Envoy picks the most specific domain, not the first one written.`
            }
            attempts={match.hostAttempts.map((a) => ({
              label: a.candidate.name ?? `virtual host ${a.index + 1}`,
              detail: a.candidate.domains.join(', '),
              matched: a.matched,
              reason: a.reason,
              line: a.candidate.range.line,
            }))}
            onReveal={revealLine}
          />

          <Stage
            title="Route"
            note="Tried in the order they are written. The first match wins."
            attempts={match.routeAttempts.map((a) => ({
              label: a.candidate.name ?? `route ${a.index + 1}`,
              detail: describeSpec(a.candidate.match.pathSpec),
              matched: a.matched,
              reason: a.reason,
              line: a.candidate.range.line,
            }))}
            onReveal={revealLine}
          />
        </>
      )}
    </div>
  )
}

const label = (precedence: string) =>
  ({
    exact: 'an exact name',
    'suffix-wildcard': 'a suffix wildcard',
    'prefix-wildcard': 'a prefix wildcard',
    any: 'the catch-all',
  })[precedence] ?? precedence

function describeSpec(spec: { kind: string; value?: string; label?: string }): string {
  if (spec.kind === 'prefix') return `prefix ${spec.value}`
  if (spec.kind === 'path') return `path ${spec.value}`
  if (spec.kind === 'pathSeparatedPrefix') return `segment ${spec.value}`
  if (spec.kind === 'safeRegex') return `regex ${spec.value}`
  return spec.label ?? spec.kind
}

interface StageAttempt {
  label: string
  detail?: string
  matched: boolean
  reason?: string
  line: number
}

function Stage({
  title,
  attempts,
  note,
  onReveal,
}: {
  title: string
  attempts: StageAttempt[]
  note?: string | false
  onReveal: (line: number) => void
}) {
  if (attempts.length === 0) return null

  return (
    <section className="stage">
      <h3>{title}</h3>
      {note && <p className="stage-note">{note}</p>}
      <ul>
        {attempts.map((attempt, i) => (
          <li key={i} className={attempt.matched ? 'won' : 'lost'}>
            <button onClick={() => onReveal(attempt.line)}>
              <span className="stage-mark">{attempt.matched ? '✓' : '·'}</span>
              <span className="stage-label">{attempt.label}</span>
              {attempt.detail && <code className="stage-detail">{attempt.detail}</code>}
              {attempt.reason && <span className="stage-reason">— {attempt.reason}</span>}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
