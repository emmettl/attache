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

interface State {
  text: string
  analysis: Analysis
  graph: Graph
  tab: Tab
  /** The line the editor should reveal, bumped each time so repeat clicks still scroll. */
  reveal: { line: number; nonce: number } | null
  /**
   * The block the editor should band, while something elsewhere is hovered.
   *
   * Separate from `reveal` because they answer different questions — "take me there" and
   * "show me which part this is" — and a hover that stole the scroll position would make
   * the graph unusable, since crossing it would drag the source pane around.
   */
  highlight: { startLine: number; endLine: number } | null
  request: RequestForm
  match: MatchResult | null
  shareLink: string | null

  setText: (text: string) => void
  setTab: (tab: Tab) => void
  revealLine: (line: number) => void
  setHighlight: (block: { startLine: number; endLine: number } | null) => void
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

let saveTimer: ReturnType<typeof setTimeout> | undefined

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
      localStorage.setItem(STORAGE_KEY, text)
    } catch {
      // Full, or unavailable in a private context. Losing the autosave is survivable;
      // throwing here would take out the keystroke that happened to fill the quota.
    }
  }, 400)
}

export const useStore = create<State>((set, get) => ({
  ...load(DEFAULT_EXAMPLE.text),
  tab: 'findings',
  reveal: null,
  highlight: null,
  request: DEFAULT_REQUEST,
  match: null,
  shareLink: null,

  setText(text) {
    autosave(text)
    // A new config invalidates the old answer rather than leaving it there looking current.
    // The highlight goes too: it is a line range into text that no longer exists, and a
    // band left hanging over unrelated lines is worse than no band.
    set({ ...load(text), match: null, shareLink: null, highlight: null })
  },

  setTab(tab) {
    set({ tab })
    if (tab === 'route') get().runMatch()
  },

  revealLine(line) {
    set((state) => ({ reveal: { line, nonce: (state.reveal?.nonce ?? 0) + 1 } }))
  },

  setHighlight(block) {
    set({ highlight: block })
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

    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored !== null && stored.trim() !== '') set({ ...load(stored) })
    } catch {
      // Unavailable. The default example is a working app.
    }
  },
}))
