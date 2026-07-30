import { useEffect, useMemo, useRef } from 'react'
import { useStore } from './store.js'

// A textarea with a gutter, and deliberately not a code editor.
//
// CodeMirror or Monaco would bring syntax highlighting, and would also bring several
// hundred kilobytes and a dependency tree to the one package whose selling point is that
// `npx @attache/app` fetches a single small tarball and runs. What the editor here has to
// do is show line numbers, mark the lines something was said about, and scroll to one when
// it is clicked — and that is a gutter, a scroll handler and a ref.
//
// Worth revisiting if editing ever becomes the main activity. It is not: the common path is
// paste a config in, read what came back, go and fix it somewhere else.

const LINE_HEIGHT = 20

export function Editor() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const reveal = useStore((s) => s.reveal)
  const diagnostics = useStore((s) => s.analysis.diagnostics)

  const areaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)

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

  return (
    <div className="editor">
      <div className="gutter" ref={gutterRef} aria-hidden="true">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={`gutter-line ${marks.get(i + 1) ?? ''}`}>
            {i + 1}
          </div>
        ))}
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
        onScroll={(event) => {
          if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop
        }}
      />
    </div>
  )
}
