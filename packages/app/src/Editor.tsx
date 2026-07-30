import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { useStore } from './store.js'

// The source pane.
//
// CodeMirror rather than a textarea, and the deciding factor was not syntax colouring —
// that is a tokeniser and a mirrored backdrop, three kilobytes. It was autocompletion,
// which on a textarea means measuring the caret's pixel position, positioning a popup,
// intercepting keys without fighting native editing, and inserting text without destroying
// the undo stack. That is an editor, badly. `packages/app/package.json` records what the
// dependency actually costs and why this set of imports rather than the `codemirror`
// bundle.
//
// Everything below stays inside this file. The store still speaks in line numbers, so
// nothing else in the app knows an editor was swapped in.

/** Set the banded block, or clear it. Line numbers are 1-based, as the core reports them. */
const setBand = StateEffect.define<{ startLine: number; endLine: number } | null>()
/** Lines carrying a diagnostic, worst severity first. */
const setMarks = StateEffect.define<Map<number, string>>()

const bandLine = Decoration.line({ class: 'cm-band' })
const bandStart = Decoration.line({ class: 'cm-band cm-band-start' })
const bandEnd = Decoration.line({ class: 'cm-band cm-band-end' })

/** A line decoration per line in [startLine, endLine], clamped to the document. */
function bandFor(state: EditorState, block: { startLine: number; endLine: number } | null) {
  if (!block) return Decoration.none
  const first = Math.max(1, Math.min(block.startLine, state.doc.lines))
  const last = Math.max(first, Math.min(block.endLine, state.doc.lines))

  const spans = []
  for (let line = first; line <= last; line++) {
    const at = state.doc.line(line).from
    // First and last get their own class so the band can be rounded at the ends rather
    // than looking like an unterminated column of colour.
    const which = line === first ? bandStart : line === last ? bandEnd : bandLine
    spans.push(which.range(at))
  }
  return Decoration.set(spans)
}

const bandField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBand)) return bandFor(tr.state, effect.value)
    }
    // A band is a range of LINE NUMBERS, and an edit moves lines. Mapping through the
    // change keeps it over the text it was pointing at rather than over whatever slid into
    // those coordinates.
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      // The type guard is load-bearing, not decoration. Every field sees EVERY effect in a
      // transaction, so without it this reads the payload of the band effect too and tries
      // to iterate an object — which is exactly how it failed the first time.
      if (!effect.is(setMarks)) continue

      const spans = []
      // Decoration.set requires its ranges sorted by position; line numbers come out of a
      // Map in insertion order, which is diagnostic order, which is not that.
      for (const [line, severity] of [...effect.value].sort((a, b) => a[0] - b[0])) {
        if (line < 1 || line > tr.state.doc.lines) continue
        spans.push(
          Decoration.line({ class: `cm-diag cm-diag-${severity}` }).range(
            tr.state.doc.line(line).from,
          ),
        )
      }
      return Decoration.set(spans)
    }
    return tr.docChanged ? value.map(tr.changes) : value
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Colours by CSS variable rather than by literal.
 *
 * CodeMirror compiles a HighlightStyle into a stylesheet once, so a theme baked in here
 * could not follow `prefers-color-scheme`. Pointing at variables defined in `styles.css`
 * hands that back to CSS, which is where the rest of the app's theming already lives.
 */
const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syn-key)' },
  { tag: tags.definitionKeyword, color: 'var(--syn-key)' },
  { tag: [tags.propertyName, tags.definition(tags.propertyName)], color: 'var(--syn-key)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: tags.number, color: 'var(--syn-number)' },
  { tag: [tags.bool, tags.null, tags.atom], color: 'var(--syn-atom)' },
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [tags.punctuation, tags.separator], color: 'var(--syn-punct)' },
  { tag: tags.meta, color: 'var(--syn-meta)' },
  { tag: tags.invalid, color: 'var(--error)' },
])

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'transparent', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: 'var(--line-height)', overflow: 'auto' },
  '.cm-content': { padding: '0.6rem 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--bg-sunken)',
    color: 'var(--ink-soft)',
    border: 'none',
    borderRight: '1px solid var(--line)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 0.55rem 0 1rem', minWidth: '2.4rem' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },
})

export function Editor() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const reveal = useStore((s) => s.reveal)
  const highlightBlock = useStore((s) => s.highlight)
  const diagnostics = useStore((s) => s.analysis.diagnostics)

  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  // Read inside the update listener, which is created once and would otherwise close over
  // the first render's `setText`.
  const onChange = useRef(setText)
  onChange.current = setText

  useEffect(() => {
    if (!host.current) return

    const extensions: Extension[] = [
      lineNumbers(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      yaml(),
      syntaxHighlighting(highlight),
      bandField,
      markField,
      theme,
      EditorView.lineWrapping,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange.current(update.state.doc.toString())
      }),
    ]

    const instance = new EditorView({
      state: EditorState.create({ doc: useStore.getState().text, extensions }),
      parent: host.current,
    })
    view.current = instance
    return () => {
      instance.destroy()
      view.current = null
    }
  }, [])

  // Push text in only when it did NOT come from typing — an example being loaded, a shared
  // link, a restored session. Comparing against the current doc is what stops every
  // keystroke round-tripping through the store and back as a full document replacement,
  // which would flatten the undo history and move the cursor to the end.
  useEffect(() => {
    const instance = view.current
    if (!instance || instance.state.doc.toString() === text) return
    instance.dispatch({
      changes: { from: 0, to: instance.state.doc.length, insert: text },
    })
  }, [text])

  useEffect(() => {
    view.current?.dispatch({ effects: setBand.of(highlightBlock) })
  }, [highlightBlock])

  useEffect(() => {
    const worst = new Map<number, string>()
    const rank: Record<string, number> = { error: 3, warning: 2, info: 1 }
    for (const d of diagnostics) {
      const current = worst.get(d.range.line)
      if (!current || rank[d.severity]! > rank[current]!) worst.set(d.range.line, d.severity)
    }
    view.current?.dispatch({ effects: setMarks.of(worst) })
  }, [diagnostics])

  // Keyed on `nonce` rather than the line alone, so clicking the same finding twice scrolls
  // back to it instead of doing nothing the second time.
  useEffect(() => {
    const instance = view.current
    if (!reveal || !instance) return
    const line = Math.max(1, Math.min(reveal.line, instance.state.doc.lines))
    const at = instance.state.doc.line(line).from
    instance.dispatch({
      selection: { anchor: at },
      effects: EditorView.scrollIntoView(at, { y: 'center' }),
    })
    instance.focus()
  }, [reveal])

  return <div className="editor" ref={host} />
}
