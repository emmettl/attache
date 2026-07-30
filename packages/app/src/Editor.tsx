import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import { tags } from '@lezer/highlight'
import { useEffect, useRef } from 'react'
import { valueCompletions } from './completion.js'
import { useStore, type LineRange } from './store.js'

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
const setBand = StateEffect.define<LineRange | null>()
/** Lines carrying a diagnostic, worst severity first. */
const setMarks = StateEffect.define<Map<number, string>>()
/** Set the greyed-out blocks, or clear them. */
const setMaskBlocks = StateEffect.define<LineRange[] | null>()

const bandLine = Decoration.line({ class: 'cm-band' })
const bandStart = Decoration.line({ class: 'cm-band cm-band-start' })
const bandEnd = Decoration.line({ class: 'cm-band cm-band-end' })

/** A line decoration per line in [startLine, endLine], clamped to the document. */
function bandFor(state: EditorState, block: LineRange | null) {
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

const maskedLine = Decoration.line({ class: 'cm-masked' })

/**
 * A line decoration per line covered by any of the blocks.
 *
 * The blocks arrive unmerged and freely overlapping — they are the source ranges of a set
 * of config objects, and those nest: an irrelevant route sits inside a listener whose other
 * routes are not irrelevant, so a whole listener's span and one route inside it can both be
 * in the list. Collecting line NUMBERS into a set and then emitting one decoration each
 * dissolves that: overlap costs nothing, nesting costs nothing, and no interval arithmetic
 * has to be right. It also gives the sorted order `Decoration.set` requires, which the
 * blocks themselves are in no particular order to provide.
 */
function maskFor(state: EditorState, blocks: LineRange[] | null) {
  if (!blocks || blocks.length === 0) return Decoration.none

  const lines = new Set<number>()
  for (const block of blocks) {
    const first = Math.max(1, Math.min(block.startLine, state.doc.lines))
    const last = Math.max(first, Math.min(block.endLine, state.doc.lines))
    for (let line = first; line <= last; line++) lines.add(line)
  }

  return Decoration.set(
    [...lines].sort((a, b) => a - b).map((line) => maskedLine.range(state.doc.line(line).from)),
  )
}

/**
 * The mask, as a second decoration layer beside the band.
 *
 * Two fields rather than one that knows about both, because they answer to different things
 * and change at different times: the band follows a hover and is a single block, the mask
 * follows a filter and is a set of them. CodeMirror merges the classes of every line
 * decoration landing on a line, so a banded line inside a masked region gets both and the
 * stylesheet decides how they compose — which is where that belongs, and it is why
 * `styles.css` has a rule for the pair rather than the band quietly losing under the wash.
 */
const maskField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setMaskBlocks)) return maskFor(tr.state, effect.value)
    }
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

  // ---- completion ----------------------------------------------------------------
  //
  // Themed here rather than in `styles.css`, because CodeMirror injects the autocomplete
  // base theme into <head> at the same specificity a stylesheet rule can reach — so which
  // one wins is decided by injection order, and it goes CodeMirror's way. Its default is a
  // light-mode popup, which in dark mode is a white box full of white text.
  '.cm-tooltip.cm-tooltip-autocomplete': {
    border: '1px solid var(--line)',
    borderRadius: '6px',
    backgroundColor: 'var(--bg-raised)',
    boxShadow: 'var(--shadow-2)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--mono)',
    fontSize: '12.5px',
    maxHeight: '16rem',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'baseline',
    gap: '0.75rem',
    padding: '0.2rem 0.5rem',
    color: 'var(--ink)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
    color: 'var(--ink)',
  },
  // The part of the value matching what was typed. Weight rather than a second colour: these
  // rows already carry a value and a gloss, and a third ink would be decoration.
  '.cm-completionLabel': { flex: 'none' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
  // Pushed right and softened, so a column of values stays scannable down its left edge and
  // the explanations sit out of the way of it.
  '.cm-completionDetail': {
    marginLeft: 'auto',
    fontStyle: 'normal',
    fontFamily: 'var(--sans)',
    fontSize: '0.72rem',
    color: 'var(--ink-soft)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
})

export function Editor() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const reveal = useStore((s) => s.reveal)
  const highlightBlock = useStore((s) => s.highlight)
  const mask = useStore((s) => s.mask)
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
      /**
       * Value completion. See `completion.ts` for why it is values and never field names.
       *
       * `override` rather than a language-registered source, because that is the whole set:
       * there is no fallback to word-completion from the document, which would offer every
       * identifier already typed as though it were a candidate — including, in a YAML file,
       * every field name in it. The one deliberate limit here would be undone by the default.
       *
       * Left on while typing, and that is safe here in a way it would not usually be. The
       * source answers `null` everywhere except the handful of value positions it genuinely
       * knows — a cluster reference, a discovery type, a filter name — so the menu cannot
       * appear uninvited in the middle of a hostname or a path. Alt+Space is for reopening
       * it after Escape, and for the empty value where there is no prefix to trigger on.
       */
      autocompletion({
        override: [valueCompletions(() => useStore.getState().analysis.model)],
        icons: false,
      }),
      /**
       * Option+Space does not always arrive as a space.
       *
       * On macOS it inserts a non-breaking space, and depending on the browser and the
       * keyboard layout `event.key` comes through as U+00A0 rather than U+0020 — at which
       * point CodeMirror is matching "Alt- " against a binding for "Alt-Space" and the
       * shortcut silently does nothing on the platform most likely to be running this.
       *
       * `event.code` is the physical key and is not affected by any of that. Registered
       * before the keymap so it wins, and narrow enough that nothing else can reach it.
       */
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (!event.altKey || event.ctrlKey || event.metaKey || event.code !== 'Space') return false
          event.preventDefault()
          return startCompletion(view)
        },
      }),
      // Before `defaultKeymap`, which binds Escape and the arrow keys the menu also wants.
      keymap.of([
        { key: 'Alt-Space', run: startCompletion },
        // The conventional one everywhere that is not a Mac, and harmless there.
        { key: 'Ctrl-Space', run: startCompletion },
        // Tab accepts, but ONLY with the menu open — `acceptCompletion` returns false
        // otherwise, so the binding falls through and Tab still indents.
        { key: 'Tab', run: acceptCompletion },
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      yaml(),
      syntaxHighlighting(highlight),
      bandField,
      maskField,
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
    view.current?.dispatch({ effects: setMaskBlocks.of(mask) })
  }, [mask])

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
