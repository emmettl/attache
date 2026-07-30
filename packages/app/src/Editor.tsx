import { useEffect, useMemo, useRef } from 'react'
import { useStore } from './store.js'

// A textarea with a gutter and a highlight layer, and deliberately not a code editor.
//
// CodeMirror or Monaco would bring syntax highlighting, and would also bring several
// hundred kilobytes and a dependency tree to the one package whose selling point is that
// `npx @attache/app` fetches a single small tarball and runs.
//
// The band highlighting — hover a node in the graph, see which part of the config it is —
// does not need one either. Bands sit in a layer BEHIND a transparent-backgrounded
// textarea, and because they cover whole lines they need no per-character measurement: a
// line number times the line height is the whole calculation. That keeps the one hard part
// of faking an editor, matching text metrics between two elements, out of this entirely.
//
// Syntax colouring is the thing this approach cannot do, since the text is still the
// textarea's own. That would need a mirrored backdrop rendering the text as spans, which is
// a real editor's worth of alignment bugs. Worth it only if reading the config here becomes
// the main activity rather than the thing you do between paste and fix.

const LINE_HEIGHT = 20
/** Matches the `.source` padding, so a band lines up with the text it is behind. */
const TEXT_PAD_TOP = 9.6

export function Editor() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const reveal = useStore((s) => s.reveal)
  const diagnostics = useStore((s) => s.analysis.diagnostics)

  const highlight = useStore((s) => s.highlight)

  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const bandRef = useRef<HTMLDivElement>(null)

  const lines = useMemo(() => text.split('\n').length, [text])

  /** Worst severity per line, so the gutter shows an error over a warning on the same line. */
  const marks = useMemo(() => {
    const out = new Map<number, 'error' | 'warning' | 'info'>()
    const rank = { error: 3, warning: 2, info: 1 }
    for (const d of diagnostics) {
      const current = out.get(d.range.line)
      if (!current || rank[d.severity] > rank[current]) out.set(d.range.line, d.severity)
    }
    return out
  }, [diagnostics])

  // `nonce` rather than the line number alone: clicking the same finding twice should
  // scroll back to it, and an effect keyed on the line would not fire the second time.
  useEffect(() => {
    if (!reveal) return
    const area = areaRef.current
    if (!area) return

    const target = Math.max(0, (reveal.line - 1) * LINE_HEIGHT - area.clientHeight / 3)
    area.scrollTo({ top: target, behavior: 'smooth' })

    // Put the caret on the line too, so the next keystroke lands where the eye is.
    const offset = text.split('\n').slice(0, reveal.line - 1).join('\n').length
    area.focus({ preventScroll: true })
    area.setSelectionRange(offset, offset)
  }, [reveal, text])

  // Scrolling the band layer is done by hand rather than by letting it scroll with the
  // textarea, because it must not have scrollbars of its own — two scrollbars on one pane
  // is the giveaway that something is faking it.
  const syncScroll = (top: number, left: number) => {
    if (gutterRef.current) gutterRef.current.scrollTop = top
    if (bandRef.current) bandRef.current.style.transform = `translate(${-left}px, ${-top}px)`
  }

  return (
    <div className="editor">
      <div className="gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={`gutter-line ${marks.get(i + 1) ?? ''}`}>
            {i + 1}
          </div>
        ))}
      </div>

      <div className="source-wrap">
        <div className="bands" aria-hidden="true">
          <div ref={bandRef} className="bands-inner">
            {highlight && (
              <div
                className="band"
                style={{
                  top: TEXT_PAD_TOP + (highlight.startLine - 1) * LINE_HEIGHT,
                  height: (highlight.endLine - highlight.startLine + 1) * LINE_HEIGHT,
                }}
              />
            )}
          </div>
        </div>

        <textarea
          ref={areaRef}
          className="source"
          value={text}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          aria-label="Envoy configuration"
          onChange={(event) => setText(event.target.value)}
          onScroll={(event) =>
            syncScroll(event.currentTarget.scrollTop, event.currentTarget.scrollLeft)
          }
        />
      </div>
    </div>
  )
}
