import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  startCompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { lintGutter, setDiagnostics, type Diagnostic as LintDiagnostic } from '@codemirror/lint'
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, lineNumbers, type DecorationSet } from '@codemirror/view'
import type { Diagnostic } from '@attache/core'
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

/**
 * Our diagnostics, in the shape `@codemirror/lint` wants.
 *
 * `@codemirror/lint` rather than the line-tint field this replaces, and the reason is not
 * that it is prettier. The tint could say a line had something wrong with it and nothing
 * more: no hover, no way back to what was actually said, and no way to tell a complaint
 * about `cluster: ghost_service` from one about the route around it. Lint's model is a span
 * with a message attached, which is what our diagnostics have been carrying all along.
 *
 * NOT `linter()`, which exists to run an async source on a debounce. The analysis is already
 * recomputed synchronously in the store on every keystroke, so the diagnostics are simply
 * pushed in with `setDiagnostics` as they arrive. Adding a 750ms linting delay on top of
 * work that has already been done would only make the editor slower to agree with the panel
 * beside it.
 */
function lintDiagnostics(state: EditorState, diagnostics: readonly Diagnostic[]): LintDiagnostic[] {
  const max = state.doc.length

  return diagnostics
    .map((d): LintDiagnostic => {
      const from = Math.max(0, Math.min(d.range.start, max))
      const line = state.doc.lineAt(from)

      // Clamped to the first line of the range, and this is the whole judgement call in this
      // function. A scalar's range is exactly its value, so `cluster: ghost_service` gets
      // underlined precisely — which is the improvement over tinting the line. But a mapping
      // node's range spans everything under it, so the same code would underline an entire
      // listener, four hundred lines of it, for one missing field. The first line of a block
      // is where the block announces itself, and it is where somebody looking for the marker
      // will look.
      const to = Math.max(from, Math.min(d.range.end, line.to))

      return {
        from,
        // A span that came out empty — a range pointing at the very end of a line, or at a
        // node the parser gave no extent — would be an invisible marker. Falling back to the
        // line means there is always something to hover.
        to: to > from ? to : line.to,
        severity: d.severity,
        message: d.message,
        renderMessage: () => {
          const wrap = document.createElement('div')
          wrap.className = 'cm-diag-tooltip'

          const text = document.createElement('p')
          text.className = 'cm-diag-message'
          text.textContent = d.message
          wrap.append(text)

          // The half that says why it matters. Envoy's failure modes are mostly silent, so
          // for several of these codes the detail is the part worth reading — dropping it
          // from the hover would leave the tooltip strictly less useful than the panel and
          // give somebody a reason to stop trusting it.
          if (d.detail) {
            const why = document.createElement('p')
            why.className = 'cm-diag-detail'
            why.textContent = d.detail
            wrap.append(why)
          }
          return wrap
        },
        actions: [
          {
            name: 'Show in findings',
            apply: () => useStore.getState().focusFinding(d.range.line),
          },
        ],
      }
    })
    // `setDiagnostics` builds a RangeSet, which must be given its ranges in document order.
    // Ours come out in the order the checks ran, which is by kind of check.
    .sort((a, b) => a.from - b.from)
}

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
  // A fixed width, so the config does not shift sideways the moment the first finding
  // appears and back again when it is fixed — the column is there either way, empty or not.
  '.cm-gutter-lint': { width: '1rem', cursor: 'pointer' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0 0.15rem' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--ink) 4%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 26%, transparent)',
  },

  // ---- diagnostics ---------------------------------------------------------------
  //
  // Here rather than in `styles.css`, and that is not a preference. CodeMirror injects the
  // lint package's base theme into <head> at the same specificity a stylesheet rule can
  // reach, so which of the two wins is decided by injection order — which went CodeMirror's
  // way, quietly, leaving a light-mode tooltip with our light-mode ink on it and nothing
  // legible in dark mode. `EditorView.theme` is the mechanism built to outrank a base theme,
  // and it takes CSS variables, so nothing about the theming is given up by moving it.

  // The exact span, underlined. The line tint this replaced could only say "something on
  // this line" — and `route: { cluster: ghost_service }` is one line carrying a complaint
  // and three innocent fields.
  //
  // A STRAIGHT rule rather than lint's wavy default, which is the part of the old objection
  // that was right: a squiggle under YAML reads as damage and fights the indentation the eye
  // is already following. `backgroundImage: none` is what removes the wave, since that is
  // how CodeMirror draws it.
  '.cm-lintRange': { backgroundImage: 'none', paddingBottom: '1px' },
  '.cm-lintRange-error': {
    boxShadow: 'inset 0 -2px 0 -1px var(--error)',
    backgroundColor: 'color-mix(in srgb, var(--error) 12%, transparent)',
  },
  '.cm-lintRange-warning': {
    boxShadow: 'inset 0 -2px 0 -1px var(--warning)',
    backgroundColor: 'color-mix(in srgb, var(--warning) 12%, transparent)',
  },
  '.cm-lintRange-info': {
    boxShadow: 'inset 0 -2px 0 -1px var(--info)',
    backgroundColor: 'color-mix(in srgb, var(--info) 10%, transparent)',
  },

  // Lint's own markers are SVG data URIs in fixed colours, set as `content` on the element,
  // so an orange triangle stays orange whichever theme is on. Replaced with plain shapes:
  // a disc for an error, a triangle for a warning, a rounded bar otherwise — so severity is
  // still readable without relying on colour to carry it.
  '.cm-lint-marker': {
    width: '0.55rem',
    height: '0.55rem',
    margin: 'auto',
    content: 'normal',
    backgroundColor: 'var(--info)',
    borderRadius: '2px',
  },
  '.cm-lint-marker-error': { backgroundColor: 'var(--error)', borderRadius: '50%' },
  '.cm-lint-marker-warning': {
    backgroundColor: 'var(--warning)',
    borderRadius: '1px',
    clipPath: 'polygon(50% 0, 100% 100%, 0 100%)',
  },

  // The hover. `.cm-tooltip` is the box and `.cm-tooltip-lint` is a section INSIDE it — they
  // are two elements, not two classes on one, which is the sort of thing that costs an
  // afternoon if you assume otherwise.
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-raised)',
    border: '1px solid var(--line)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow-2)',
    color: 'var(--ink)',
    maxWidth: '32rem',
    overflow: 'hidden',
  },
  '.cm-tooltip-lint .cm-diagnostic': {
    borderLeft: '3px solid var(--line)',
    padding: '0.45rem 0.6rem',
    // Prose in the editor's monospace reads as output rather than as a sentence somebody
    // wrote, and these are sentences somebody wrote.
    fontFamily: 'var(--sans)',
    fontSize: '0.82rem',
    lineHeight: '1.45',
  },
  '.cm-tooltip-lint .cm-diagnostic-error': { borderLeftColor: 'var(--error)' },
  '.cm-tooltip-lint .cm-diagnostic-warning': { borderLeftColor: 'var(--warning)' },
  '.cm-tooltip-lint .cm-diagnostic-info': { borderLeftColor: 'var(--info)' },
  '.cm-diag-message': { margin: '0' },
  // Why it matters. For several of these codes it is the half worth reading — Envoy fails
  // quietly, so the consequence is rarely obvious from the complaint alone.
  '.cm-diag-detail': { margin: '0.35rem 0 0', color: 'var(--ink-soft)' },
  '.cm-tooltip-lint .cm-diagnosticAction': {
    display: 'inline-block',
    margin: '0.5rem 0 0',
    padding: '0.2rem 0.5rem',
    backgroundColor: 'var(--bg-sunken)',
    border: '1px solid var(--line)',
    borderRadius: '4px',
    color: 'var(--ink)',
    font: 'inherit',
    fontSize: '0.78rem',
    cursor: 'pointer',
  },
  '.cm-tooltip-lint .cm-diagnosticAction:hover': {
    borderColor: 'var(--accent)',
    color: 'var(--accent)',
  },

  // ---- completion ----------------------------------------------------------------
  //
  // Here for the same reason as the diagnostics above, and it bit in the same way: the
  // autocomplete base theme's default is a light-mode popup, which in dark mode is a white
  // box full of white text. The general `.cm-tooltip` rule above is the shared box; these
  // refine it, so they have to come after it.
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

/**
 * Which line is level with this point on the screen.
 *
 * Read off the rendered line-number gutter rather than asked of `posAtCoords`, and that is
 * not the obvious choice, so: `posAtCoords` answers from CodeMirror's height map, which is
 * an estimate until the view has measured. On a config whose first line WRAPS — a long
 * `@type` URL, so most real ones — the estimate is short by a row per wrapped line, and the
 * very first click after a page load lands two lines above the marker that was clicked.
 * Clicks after that are correct, which is the worst version of a bug: it works every time
 * you go looking for it.
 *
 * The gutter elements have already been laid out by the browser at the moment of the click,
 * wrapping and all, so their rectangles are not an estimate. The zero-height entry is
 * CodeMirror's hidden width-measuring spacer, which is what the height check skips.
 */
function lineAtClientY(view: EditorView, clientY: number): number | undefined {
  for (const element of view.dom.querySelectorAll('.cm-lineNumbers > .cm-gutterElement')) {
    const box = element.getBoundingClientRect()
    if (box.height === 0 || clientY < box.top || clientY > box.bottom) continue
    const line = Number(element.textContent)
    return Number.isFinite(line) ? line : undefined
  }
  return undefined
}

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
      // Before `lineNumbers`, because gutters are laid out in the order they are added and
      // the markers belong on the outside. Between the numbers and the code they would sit
      // in the gap the eye uses to get from one to the other.
      lintGutter(),
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

    /**
     * A gutter marker you can only hover is half a control.
     *
     * `lintGutter` gives its markers a tooltip and stops there, so the click is added here:
     * the marker says something was said about this line, and the obvious next thing to want
     * is to read it.
     *
     * A plain listener on the editor's ROOT, not `EditorView.domEventHandlers`. CodeMirror
     * registers those on the content element, and the gutters are siblings of the content
     * rather than part of it, so a handler declared that way is never reached by a click on
     * a marker at all.
     */
    const onGutterMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.cm-gutter-lint')) return
      const line = lineAtClientY(instance, event.clientY)
      if (line !== undefined) useStore.getState().focusFinding(line)
    }
    instance.dom.addEventListener('mousedown', onGutterMouseDown)

    return () => {
      instance.dom.removeEventListener('mousedown', onGutterMouseDown)
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
    const instance = view.current
    if (!instance) return
    instance.dispatch(setDiagnostics(instance.state, lintDiagnostics(instance.state, diagnostics)))
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
