import { describeSecrets, findSecrets, redact } from '@attache/core'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Editor } from './Editor.js'
import { EXAMPLES } from './examples.js'
import { Findings } from './Findings.js'
import { GraphView } from './GraphView.js'
import { Logo } from './Logo.js'
import { RouteTester } from './RouteTester.js'
import { DEFAULT_SPLIT, MAX_SPLIT, MIN_SPLIT, useStore, type Tab } from './store.js'

const TABS: { id: Tab; title: string }[] = [
  { id: 'findings', title: 'Findings' },
  { id: 'graph', title: 'Graph' },
  { id: 'route', title: 'Route tester' },
]

export function App() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const tab = useStore((s) => s.tab)
  const setTab = useStore((s) => s.setTab)
  const summary = useStore((s) => s.analysis.summary)
  const format = useStore((s) => s.analysis.format)
  const loadInitial = useStore((s) => s.loadInitial)
  const loadShared = useStore((s) => s.loadShared)
  const split = useStore((s) => s.split)
  const setSplit = useStore((s) => s.setSplit)
  const remember = useStore((s) => s.remember)

  useEffect(() => {
    void loadInitial()

    /**
     * A share link that arrives while the app is already open.
     *
     * Pasting one into the address bar of a tab that is already on Attaché changes only the
     * fragment, and a fragment-only navigation does not reload the document — so the mount
     * effect above never runs a second time. What the recipient saw was their own previous
     * config, unchanged, with the sender's link sitting in the address bar looking like it
     * had been ignored. Which it had.
     *
     * `hashchange` is not fired by the `replaceState` that `takeFromUrl` uses to clear the
     * fragment, so consuming a link cannot re-trigger this.
     */
    const onHashChange = () => void loadShared()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [loadInitial, loadShared])

  return (
    <div className="app">
      <header className="bar">
        <h1>
          <Logo />
          Attaché <span className="tagline">an Envoy config workbench</span>
          {/* Links to the release it came from, so "which version is this?" and "what
              changed?" are the same click. Someone running an old `npx` copy can see they
              are behind without leaving the tab. */}
          <a
            className="version"
            href={`https://github.com/emmettl/attache/releases/tag/v${__APP_VERSION__}`}
            target="_blank"
            rel="noreferrer noopener"
            title={`Attaché ${__APP_VERSION__} — release notes`}
          >
            v{__APP_VERSION__}
          </a>
        </h1>
        <Actions />
      </header>

      {/* The split is handed to CSS as a custom PROPERTY rather than as
          `grid-template-columns` directly, and that is not decoration. An inline style beats
          a stylesheet rule, so setting the real property here would win against the
          narrow-screen media query at the bottom of `styles.css` and leave a phone rendering
          two columns of twenty characters each. A custom property loses that fight by
          construction: the media query simply sets `grid-template-columns` itself and the
          variable stops being consulted. */}
      <div className="workspace" style={splitStyle(split)}>
        <section className="pane source-pane" onDragOver={allowDrop} onDrop={(event) => void drop(event, setText)}>
          <div className="pane-head">
            <span className="format">{format === 'config-dump' ? 'config_dump' : 'bootstrap'}</span>
            <span className="summary">{summary}</span>
          </div>
          <Editor />
          <div className="examples">
            {EXAMPLES.map((example) => (
              <button key={example.id} title={example.blurb} onClick={() => setText(example.text)}>
                {example.title}
              </button>
            ))}
          </div>
        </section>

        <Splitter split={split} setSplit={setSplit} />

        <section className="pane result-pane">
          {/*
            A real tablist, which is what this always was. Three buttons with the selected
            one distinguished by a CSS class tells a screen reader nothing: it announced
            three identical buttons, with no way to know which view was showing or that
            pressing one swapped the panel underneath. Now it says "Findings, tab, 1 of 3,
            selected", and Left/Right/Home/End move between them the way a tablist is
            expected to — with the roving tabindex that makes Tab step PAST the group rather
            than through it.
          */}
          <nav className="tabs" role="tablist" aria-label="Results">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                id={`tab-${entry.id}`}
                role="tab"
                aria-selected={tab === entry.id}
                aria-controls="result-panel"
                tabIndex={tab === entry.id ? 0 : -1}
                className={tab === entry.id ? 'active' : ''}
                onClick={() => setTab(entry.id)}
                onKeyDown={(event) => {
                  const step =
                    event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : undefined
                  const at = TABS.findIndex((t) => t.id === tab)
                  const next =
                    step !== undefined
                      ? (at + step + TABS.length) % TABS.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? TABS.length - 1
                          : undefined
                  if (next === undefined) return
                  event.preventDefault()
                  const id = TABS[next]!.id
                  setTab(id)
                  // Every tab button is rendered whichever is selected, so the element is
                  // already there to focus — no waiting for the re-render that flips the
                  // tabindex, and focus is allowed onto a `-1` element programmatically.
                  document.getElementById(`tab-${id}`)?.focus()
                }}
              >
                {entry.title}
              </button>
            ))}
          </nav>
          {/*
            The wrapper exists for `role="tabpanel"` and carries the pane's flex sizing so
            that adding it changes nothing about the layout — `.panel-body` inside each view
            is still the thing that scrolls.
          */}
          <div
            className="panel"
            id="result-panel"
            role="tabpanel"
            aria-labelledby={`tab-${tab}`}
          >
            {tab === 'findings' && <Findings />}
            {tab === 'graph' && <GraphView />}
            {tab === 'route' && <RouteTester />}
          </div>
        </section>
      </div>

      {/* The claim about uploading is unconditional and stays that way. What used to be sold
          alongside it — that a reload brings your config back — is a property somebody may
          not want, so it now reports which way the setting is set instead of promising one
          of them. */}
      <footer className="bar foot">
        <span>
          Everything happens in this tab. Nothing is uploaded.{' '}
          {remember
            ? 'This config is kept in this browser until you clear it.'
            : 'This config is not remembered — it goes when you close the tab.'}
        </span>
        <span className="chars">{text.length.toLocaleString()} characters</span>
      </footer>
    </div>
  )
}

/**
 * Two variables, one number, because CSS cannot derive one from the other.
 *
 * The grid needs `fr` units — percentage tracks would let a pane shrink below its share
 * whenever its content happened to be narrow — and there is no way to build an `fr` out of a
 * number in a stylesheet. The handle needs a plain fraction to position itself against. So
 * both are written here, from one source, and the handle lands exactly on the track boundary
 * because the two tracks sum to one with no gap between them.
 *
 * `minmax(0, …)` on BOTH tracks. Without it a grid item's automatic minimum size is its
 * content, so a pane refuses to go narrower than the widest thing in it — which for the
 * graph is a canvas several thousand pixels wide, and the horizontal scrolling that exists
 * to handle exactly that stops working.
 */
function splitStyle(split: number): React.CSSProperties {
  return {
    '--split': split,
    '--split-cols': `minmax(0, ${split}fr) minmax(0, ${1 - split}fr)`,
  } as React.CSSProperties
}

/**
 * The drag handle between the panes.
 *
 * Absolutely positioned over the border the source pane already draws, rather than being a
 * track of its own: a third grid column would need its own border to be visible, and a
 * second hairline a pixel from the first reads as a rendering bug rather than as a control.
 * It is wider than the line it covers, because a one-pixel hit area is a dexterity test.
 *
 * Pointer events rather than mouse events, and the capture is the whole reason. Without
 * `setPointerCapture` the drag belongs to whatever the cursor is over, so moving faster than
 * React re-renders — which is the normal way to drag something — hands the next event to the
 * editor and the handle is simply dropped mid-gesture. Capture also brings a trackpad and a
 * touchscreen along for free, where a `mousedown` listener would have needed a second set of
 * touch handlers to match.
 */
function Splitter({ split, setSplit }: { split: number; setSplit: (fraction: number) => void }) {
  const fractionAt = (event: React.PointerEvent<HTMLDivElement>): number | null => {
    const workspace = event.currentTarget.parentElement
    if (!workspace) return null
    const box = workspace.getBoundingClientRect()
    if (box.width === 0) return null
    return (event.clientX - box.left) / box.width
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the source and results panes"
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={Math.round(MIN_SPLIT * 100)}
      aria-valuemax={Math.round(MAX_SPLIT * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        // Stops the gesture starting a text selection that then follows the cursor across
        // both panes, which is what a drag looks like to a browser that was not told.
        event.preventDefault()
        // ...and focusing is the other thing that default action was doing. Suppressing it
        // silently cost the arrow keys: the handle was reachable by Tab but not by clicking
        // the thing you had just finished dragging, which is when you would want to nudge it.
        event.currentTarget.focus()
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
        const fraction = fractionAt(event)
        if (fraction !== null) setSplit(fraction)
      }}
      onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
      // Back to even. The one thing somebody who has dragged themselves somewhere unhelpful
      // reliably wants, and it costs a line.
      onDoubleClick={() => setSplit(DEFAULT_SPLIT)}
      onKeyDown={(event) => {
        const step = event.key === 'ArrowLeft' ? -0.02 : event.key === 'ArrowRight' ? 0.02 : 0
        if (step === 0) return
        event.preventDefault()
        setSplit(split + step)
      }}
    />
  )
}

const allowDrop = (event: React.DragEvent) => event.preventDefault()

async function drop(event: React.DragEvent, setText: (text: string) => void) {
  event.preventDefault()
  const file = event.dataTransfer.files[0]
  if (file) setText(await file.text())
}

/**
 * Load, save, share, and get rid of.
 *
 * Sharing is the one that needs a gate. A URL fragment never reaches a server, which is the
 * usual argument for putting a document in one — but a link goes to a person, and an Envoy
 * bootstrap carries a TLS private key more often than not. So the config goes through the
 * core's redactor first, and if it finds key material the link is not made until the user
 * has seen what would have travelled and chosen to strip it.
 *
 * Clearing needs a gate of its own, for the opposite reason. Attaché keeps no copy anywhere
 * else — that is the whole argument of this app — so a config that has not been downloaded
 * is genuinely gone, and a one-click destroy sitting next to Download is a trap. The same
 * `.dialogue` as the share flow rather than `window.confirm`, which cannot be styled, blocks
 * the page, and looks like something the browser is telling you rather than something this
 * app is asking.
 */
/**
 * The four dialogues, which were four divs with a role on them and nothing else.
 *
 * `role="alertdialog"` is a promise about behaviour, not a label, and none of it was being
 * kept. Opening one left focus on the button behind it, so a screen reader announced
 * nothing; there was no accessible name; Escape did nothing; Tab walked out of the dialogue
 * and into the editor behind it; and closing dropped focus on `<body>`, which puts a
 * keyboard user back at the top of the document. Two of the four are the warning that a
 * private key is about to travel and the confirmation that destroys work with no undo —
 * which are exactly the two where being unable to read or dismiss the thing matters.
 *
 * Deliberately NOT `aria-modal`, and deliberately no focus trap. These are positioned
 * popovers with no backdrop: the rest of the page stays visible and clickable, so claiming
 * the background is inert would be telling assistive technology something the mouse can
 * plainly disprove. This is the non-modal dialog pattern — focus moves in, Escape gets you
 * out, focus goes back where it came from — which is what they actually are.
 */
function Dialogue({
  label,
  alert = false,
  onDismiss,
  children,
}: {
  /** The accessible name. The content is announced too; this says which dialogue it is. */
  label: string
  /** `alertdialog` for a decision, `dialog` for something merely being handed to you. */
  alert?: boolean
  onDismiss: () => void
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  // Held in a ref so the effect below can run once on mount. Every caller passes an inline
  // arrow, so depending on it directly would re-run the effect on every render and yank
  // focus back to the first button while somebody was tabbing through.
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    const opener = document.activeElement
    // The first focusable, unless something asked for it. A confirmation whose first button
    // is the destructive one would otherwise put focus on `Clear it` and turn a stray Enter
    // into a config nobody can get back — and this app has no other copy, which is the whole
    // reason that dialogue exists.
    const target =
      box.current?.querySelector<HTMLElement>('[data-initial-focus]') ??
      box.current?.querySelector<HTMLElement>('button, input, [href]')
    target?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      dismiss.current()
    }
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Back where it came from, but only if that is still somewhere real — the element can
      // have been unmounted by whatever the dialogue just did, and focusing `<body>` is how
      // this got to be worth fixing.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  return (
    <div
      ref={box}
      className="dialogue"
      role={alert ? 'alertdialog' : 'dialog'}
      aria-label={label}
    >
      {children}
    </div>
  )
}

function Actions() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const share = useStore((s) => s.share)
  const shareLink = useStore((s) => s.shareLink)
  const clearShare = useStore((s) => s.clearShare)
  const clearConfig = useStore((s) => s.clearConfig)
  const remember = useStore((s) => s.remember)
  const setRemember = useStore((s) => s.setRemember)
  const [pendingSecrets, setPendingSecrets] = useState<string | null>(null)
  const [pendingClear, setPendingClear] = useState(false)
  const [stuckSecrets, setStuckSecrets] = useState(false)

  const onShare = () => {
    const secrets = findSecrets(text)
    if (secrets.length > 0) {
      setPendingSecrets(describeSecrets(secrets))
      return
    }
    void share(text)
  }

  return (
    <div className="actions">
      <button onClick={() => void openFile(setText)}>Open file</button>
      <button onClick={() => download(text)}>Download</button>
      <button onClick={onShare}>Share link</button>
      <button onClick={() => setPendingClear(true)}>Clear</button>

      {/* It says which way it is set rather than what pressing it would do. A button
          labelled "Remember" is ambiguous about whether that is the state or the offer, and
          this is a privacy setting — the one kind where a user guessing wrong is a real
          cost. The engaged state is the non-default one, so that is the one that is
          coloured. */}
      <button
        className="remember"
        aria-pressed={remember}
        onClick={() => setRemember(!remember)}
        title={
          remember
            ? 'This config is saved in this browser and comes back on reload. Click to stop.'
            : 'This config is not saved anywhere and goes when the tab closes. Click to keep it.'
        }
      >
        {remember ? 'Remembering' : 'Not remembering'}
      </button>

      {pendingClear && (
        <Dialogue label="Clear this config?" alert onDismiss={() => setPendingClear(false)}>
          <p>Clear this config?</p>
          <p className="muted">
            The editor goes back to the example and the copy kept in this browser is deleted.
            Attaché has no other copy — that is rather the point of it — so if you have not
            downloaded this config, it is gone.
          </p>
          <div className="dialogue-actions">
            <button
              onClick={() => {
                setPendingClear(false)
                clearConfig()
              }}
            >
              Clear it
            </button>
            <button data-initial-focus onClick={() => setPendingClear(false)}>
              Cancel
            </button>
          </div>
        </Dialogue>
      )}

      {pendingSecrets && (
        <Dialogue
          label="This config contains key material"
          alert
          onDismiss={() => setPendingSecrets(null)}
        >
          <p>{pendingSecrets}</p>
          <p className="muted">
            A share link keeps the config out of any server log — it lives after the `#`, which
            browsers do not send. It does not keep it from whoever opens the link. Attaché will
            replace the key material with <code>"REDACTED"</code> before making one.
          </p>
          <div className="dialogue-actions">
            <button
              onClick={() => {
                // The redactor checks its own work, and this refuses to make a link when
                // that check fails. There is no reading of "mostly redacted" worth acting
                // on: the cost of being wrong here is somebody's private key in a URL they
                // have already sent, which no amount of closing the tab takes back.
                const { text: clean, complete } = redact(text)
                if (!complete) {
                  setPendingSecrets(null)
                  setStuckSecrets(true)
                  return
                }
                setPendingSecrets(null)
                void share(clean)
              }}
            >
              Redact and share
            </button>
            <button onClick={() => setPendingSecrets(null)}>Cancel</button>
          </div>
        </Dialogue>
      )}

      {stuckSecrets && (
        <Dialogue label="Attaché could not redact this config" alert onDismiss={() => setStuckSecrets(false)}>
          <p>Attaché could not remove all of it, so it has not made a link.</p>
          <p className="muted">
            The redactor checks its own work and something survived the pass — which is a bug
            here rather than a problem with your config. Download the file and take the key
            material out by hand if you need to share it.
          </p>
          <div className="dialogue-actions">
            <button onClick={() => setStuckSecrets(false)}>Close</button>
          </div>
        </Dialogue>
      )}

      {shareLink && (
        <Dialogue label="Share link" onDismiss={clearShare}>
          <p>Link ready — {shareLink.length.toLocaleString()} characters.</p>
          <input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
          <div className="dialogue-actions">
            <button onClick={() => void navigator.clipboard?.writeText(shareLink)}>Copy</button>
            <button onClick={clearShare}>Close</button>
          </div>
        </Dialogue>
      )}
    </div>
  )
}

function openFile(setText: (text: string) => void): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.yaml,.yml,.json,application/json,text/yaml'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void file.text().then(setText)
  }
  // No reliable `cancel` event across browsers, so a cancelled picker simply never fires.
  // Nothing is awaiting it but a click handler.
  input.click()
}

function download(text: string): void {
  const blob = new Blob([text], { type: 'text/yaml' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'envoy.yaml'
  link.click()
  URL.revokeObjectURL(url)
}
