import { analyse, buildGraph, matchRequest, type Analysis, type Graph, type MatchResult, type TestRequest } from '@attache/core'
import { create } from 'zustand'
import { DEFAULT_EXAMPLE } from './examples.js'
import { linkTo, takeFromUrl } from './hash.js'

// What is on screen. The core owns every question about Envoy; this owns the text, the
// tab, and where the config came from.
//
// The analysis is derived, not stored twice: `setText` recomputes it in the same action, so
// there is no moment where the editor shows one config and the findings describe another.
// Envoy configs are small enough that a full reparse per keystroke is imperceptible —
// measured at well under a millisecond for the examples — and a debounce here would buy
// nothing but a window in which the two panes disagree.

const STORAGE_KEY = 'attache.config.v1'
const SPLIT_KEY = 'attache.split.v1'
/**
 * Whether to keep the config across reloads at all.
 *
 * Its own key, deliberately not stored inside anything that gets wiped: somebody who has
 * turned remembering off wants it to STAY off, and a preference that lives in the thing it
 * protects would be deleted by the first thing it did.
 */
const REMEMBER_KEY = 'attache.remember.v1'

/** The share of the width the source pane takes. Its own key, so a bad config cannot lose it. */
export const DEFAULT_SPLIT = 0.5
/**
 * Neither pane may be dragged shut.
 *
 * A pane collapsed to nothing looks like a broken app rather than like a choice, and there
 * is no affordance left to get it back — the handle is at the very edge of the window, on
 * top of a scrollbar. Twenty per cent is narrow enough to be a real setting and wide enough
 * to still show what it is you would be dragging back.
 */
export const MIN_SPLIT = 0.2
export const MAX_SPLIT = 0.8

export const clampSplit = (fraction: number): number =>
  Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, fraction))

export type Tab = 'findings' | 'graph' | 'route'

export interface RequestForm {
  authority: string
  path: string
  method: string
  port: string
  serverName: string
  /** Raw `name: value` lines, parsed on the way into the matcher. */
  headers: string
}

const DEFAULT_REQUEST: RequestForm = {
  authority: 'www.foo.com',
  path: '/api/users',
  method: 'GET',
  port: '10000',
  serverName: '',
  headers: '',
}

/** A block of the source, 1-based and inclusive, as the core reports ranges. */
export interface LineRange {
  startLine: number
  endLine: number
}

interface State {
  text: string
  analysis: Analysis
  graph: Graph
  tab: Tab
  /** The line the editor should reveal, bumped each time so repeat clicks still scroll. */
  reveal: { line: number; nonce: number } | null
  /**
   * The finding the panel should scroll to and flash, when the editor asks for one.
   *
   * The mirror of `reveal`, and the direction that did not exist until now: everything in
   * this app flowed finding → editor, so a marker in the gutter was a dead end. You could
   * see that Attaché had said something about line 47 and had no way to get to what it said
   * short of scrolling the list yourself looking for the number.
   */
  focus: { line: number; nonce: number } | null
  /**
   * The block the editor should band, while something elsewhere is hovered.
   *
   * Separate from `reveal` because they answer different questions — "take me there" and
   * "show me which part this is" — and a hover that stole the scroll position would make
   * the graph unusable, since crossing it would drag the source pane around.
   */
  highlight: LineRange | null
  /**
   * Blocks of the source to grey out, while something elsewhere is filtering.
   *
   * A list rather than a single range, and unmerged: overlap and nesting are resolved by
   * whatever draws it, because "which lines are covered" is a question about a document
   * that this store does not have in front of it.
   *
   * Kept separate from `highlight` because they are opposite operations — one says "this
   * part" and the other says "not these parts" — and they have to be able to coexist, so a
   * block banded by a hover still reads as banded when it sits inside a masked region.
   */
  mask: LineRange[] | null
  request: RequestForm
  match: MatchResult | null
  shareLink: string | null
  /** How much of the workspace width the source pane gets, between MIN_SPLIT and MAX_SPLIT. */
  split: number
  /** Whether the config survives a reload. On by default, and the user can turn it off. */
  remember: boolean

  setText: (text: string) => void
  setSplit: (fraction: number) => void
  setRemember: (remember: boolean) => void
  clearConfig: () => void
  setTab: (tab: Tab) => void
  revealLine: (line: number) => void
  focusFinding: (line: number) => void
  setHighlight: (block: LineRange | null) => void
  setMask: (blocks: LineRange[] | null) => void
  setRequest: (patch: Partial<RequestForm>) => void
  runMatch: () => void
  share: (text: string) => Promise<void>
  clearShare: () => void
  loadInitial: () => Promise<void>
}

/** `name: value` per line. Blank lines and lines without a colon are skipped. */
export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const cut = line.indexOf(':')
    if (cut <= 0) continue
    out[line.slice(0, cut).trim().toLowerCase()] = line.slice(cut + 1).trim()
  }
  return out
}

export function toTestRequest(form: RequestForm): TestRequest {
  const port = Number(form.port)
  return {
    authority: form.authority,
    path: form.path,
    method: form.method.toUpperCase(),
    port: form.port.trim() === '' || !Number.isFinite(port) ? undefined : port,
    serverName: form.serverName.trim() === '' ? undefined : form.serverName.trim(),
    headers: parseHeaders(form.headers),
  }
}

function load(text: string) {
  const analysis = analyse(text)
  return { text, analysis, graph: buildGraph(analysis.model) }
}

/**
 * The stored split, read once at start-up rather than in `loadInitial`.
 *
 * Unlike the config, this has to be known before the first paint: restoring it a tick later
 * would render the workspace at fifty-fifty and then jump, and a layout that moves on its
 * own as the page settles is worse than one that never remembered anything. A stored value
 * from an older build, or hand-edited, is clamped rather than trusted.
 */
function loadSplit(): number {
  try {
    const stored = Number(localStorage.getItem(SPLIT_KEY))
    return Number.isFinite(stored) && stored > 0 ? clampSplit(stored) : DEFAULT_SPLIT
  } catch {
    return DEFAULT_SPLIT
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let splitTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Persist, but not on every keystroke.
 *
 * `localStorage.setItem` is synchronous, and serialising a config on the main thread once
 * per character typed is work nobody asked for. Trailing edge, so what lands is what the
 * editor settled on.
 */
function autosave(text: string): void {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try {
      // The bundled example is not anybody's work, and storing it is what made Clear a lie
      // the first time. Clearing loads the example into the editor, the editor reports that
      // like any other edit, and four hundred milliseconds later the entry the button had
      // just deleted was back — holding a config nobody had typed. Nothing is lost by
      // declining to remember what ships with the app.
      if (text === DEFAULT_EXAMPLE.text) localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, text)
    } catch {
      // Full, or unavailable in a private context. Losing the autosave is survivable;
      // throwing here would take out the keystroke that happened to fill the quota.
    }
  }, 400)
}

/**
 * Take the stored config out of this browser, and stop the one in flight.
 *
 * Cancelling the pending timer is not tidiness. `setText` schedules a write four hundred
 * milliseconds out, so clearing without cancelling removes the entry and then writes it
 * straight back — a Clear button that does nothing a third of a second later is worse than
 * no Clear button, because the user has been told it worked.
 */
function forget(): void {
  clearTimeout(saveTimer)
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Unavailable, which means there was nothing stored to begin with.
  }
}

/** Remembering is the default, so anything other than an explicit `off` means yes. */
function loadRemember(): boolean {
  try {
    return localStorage.getItem(REMEMBER_KEY) !== 'off'
  } catch {
    return true
  }
}

/** As above, and for the same reason: a drag is a hundred writes if you let it be. */
function saveSplit(fraction: number): void {
  clearTimeout(splitTimer)
  splitTimer = setTimeout(() => {
    try {
      localStorage.setItem(SPLIT_KEY, String(fraction))
    } catch {
      // A layout preference is not worth an error in front of somebody.
    }
  }, 250)
}

export const useStore = create<State>((set, get) => ({
  ...load(DEFAULT_EXAMPLE.text),
  tab: 'findings',
  reveal: null,
  focus: null,
  highlight: null,
  mask: null,
  request: DEFAULT_REQUEST,
  match: null,
  shareLink: null,
  split: loadSplit(),
  remember: loadRemember(),

  /**
   * Turn remembering on or off.
   *
   * Turning it off deletes what is already stored, immediately. A setting that only governs
   * FUTURE writes would leave the last session's config sitting in the browser for as long
   * as nobody typed — which is exactly the config somebody reaching for this switch is
   * trying to be rid of, and they would have every reason to believe it was gone.
   */
  setRemember(remember) {
    set({ remember })
    try {
      localStorage.setItem(REMEMBER_KEY, remember ? 'on' : 'off')
    } catch {
      // The choice will not survive a reload, but it holds for this session.
    }
    if (!remember) forget()
  },

  /**
   * Back to the example, and take the stored copy with it.
   *
   * Both halves or neither. Clearing only the editor leaves the config in localStorage, so a
   * reload brings it straight back and the button was a lie — and it is the stored copy,
   * not the visible one, that is the reason somebody presses this.
   */
  clearConfig() {
    set({ ...load(DEFAULT_EXAMPLE.text), match: null, shareLink: null, highlight: null, mask: null })
    forget()
  },

  setSplit(fraction) {
    const split = clampSplit(fraction)
    set({ split })
    saveSplit(split)
  },

  setText(text) {
    if (get().remember) autosave(text)
    // A new config invalidates the old answer rather than leaving it there looking current.
    // The highlight goes too: it is a line range into text that no longer exists, and a
    // band left hanging over unrelated lines is worse than no band. The mask goes for the
    // same reason and more urgently — stale ranges there would grey out arbitrary parts of
    // the new config, which reads as "Attaché has decided this does not matter" about lines
    // it has never looked at. Whatever is filtering will recompute and set it again.
    set({ ...load(text), match: null, shareLink: null, highlight: null, mask: null })
  },

  setTab(tab) {
    set({ tab })
    if (tab === 'route') get().runMatch()
  },

  revealLine(line) {
    set((state) => ({ reveal: { line, nonce: (state.reveal?.nonce ?? 0) + 1 } }))
  },

  /**
   * Go the other way: from a line in the source to what was said about it.
   *
   * Switches to the findings tab as well as pointing at the finding, because the request is
   * "show me this" and being taken to a tab that is not showing it would be a worse answer
   * than doing nothing. Nonce for the same reason as `reveal` — clicking the same gutter
   * marker twice should scroll back to it rather than sit there having already been there.
   */
  focusFinding(line) {
    set((state) => ({ tab: 'findings', focus: { line, nonce: (state.focus?.nonce ?? 0) + 1 } }))
  },

  setHighlight(block) {
    set({ highlight: block })
  },

  setMask(blocks) {
    set({ mask: blocks })
  },

  setRequest(patch) {
    set((state) => ({ request: { ...state.request, ...patch } }))
    get().runMatch()
  },

  runMatch() {
    const { analysis, request } = get()
    set({ match: matchRequest(analysis.model, toTestRequest(request)) })
  },

  async share(text) {
    set({ shareLink: await linkTo(text) })
  },

  clearShare() {
    set({ shareLink: null })
  },

  async loadInitial() {
    // A shared link wins over the last session: somebody who followed a link meant to see
    // what was in it, and silently showing them their own previous config instead would be
    // the most confusing thing this app could do.
    const shared = await takeFromUrl()
    if (shared !== null) {
      set({ ...load(shared) })
      return
    }

    // Asked not to remember, so nothing is restored — even if an entry survived from
    // another tab that was still running under the old setting when this one changed it.
    if (!get().remember) {
      forget()
      return
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored !== null && stored.trim() !== '') set({ ...load(stored) })
    } catch {
      // Unavailable. The default example is a working app.
    }
  },
}))
