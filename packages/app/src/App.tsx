import { describeSecrets, findSecrets, redact } from '@attache/core'
import { useEffect, useState } from 'react'
import { Editor } from './Editor.js'
import { EXAMPLES } from './examples.js'
import { Findings } from './Findings.js'
import { GraphView } from './GraphView.js'
import { Logo } from './Logo.js'
import { RouteTester } from './RouteTester.js'
import { useStore, type Tab } from './store.js'

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

  useEffect(() => {
    void loadInitial()
  }, [loadInitial])

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

      <div className="workspace">
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

        <section className="pane result-pane">
          <nav className="tabs">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                className={tab === entry.id ? 'active' : ''}
                onClick={() => setTab(entry.id)}
              >
                {entry.title}
              </button>
            ))}
          </nav>
          {tab === 'findings' && <Findings />}
          {tab === 'graph' && <GraphView />}
          {tab === 'route' && <RouteTester />}
        </section>
      </div>

      <footer className="bar foot">
        <span>
          Everything happens in this tab. Nothing is uploaded — reload and your config is still
          here, because it never left.
        </span>
        <span className="chars">{text.length.toLocaleString()} characters</span>
      </footer>
    </div>
  )
}

const allowDrop = (event: React.DragEvent) => event.preventDefault()

async function drop(event: React.DragEvent, setText: (text: string) => void) {
  event.preventDefault()
  const file = event.dataTransfer.files[0]
  if (file) setText(await file.text())
}

/**
 * Load, save and share.
 *
 * Sharing is the one that needs a gate. A URL fragment never reaches a server, which is the
 * usual argument for putting a document in one — but a link goes to a person, and an Envoy
 * bootstrap carries a TLS private key more often than not. So the config goes through the
 * core's redactor first, and if it finds key material the link is not made until the user
 * has seen what would have travelled and chosen to strip it.
 */
function Actions() {
  const text = useStore((s) => s.text)
  const setText = useStore((s) => s.setText)
  const share = useStore((s) => s.share)
  const shareLink = useStore((s) => s.shareLink)
  const clearShare = useStore((s) => s.clearShare)
  const [pendingSecrets, setPendingSecrets] = useState<string | null>(null)

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

      {pendingSecrets && (
        <div className="dialogue" role="alertdialog">
          <p>{pendingSecrets}</p>
          <p className="muted">
            A share link keeps the config out of any server log — it lives after the `#`, which
            browsers do not send. It does not keep it from whoever opens the link. Attaché will
            replace the key material with <code>"REDACTED"</code> before making one.
          </p>
          <div className="dialogue-actions">
            <button
              onClick={() => {
                setPendingSecrets(null)
                void share(redact(text).text)
              }}
            >
              Redact and share
            </button>
            <button onClick={() => setPendingSecrets(null)}>Cancel</button>
          </div>
        </div>
      )}

      {shareLink && (
        <div className="dialogue" role="dialog">
          <p>Link ready — {shareLink.length.toLocaleString()} characters.</p>
          <input readOnly value={shareLink} onFocus={(e) => e.currentTarget.select()} />
          <div className="dialogue-actions">
            <button onClick={() => void navigator.clipboard?.writeText(shareLink)}>Copy</button>
            <button onClick={clearShare}>Close</button>
          </div>
        </div>
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
