import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { userEvent } from 'vitest/browser'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { App } from './App.js'
import { useStore } from './store.js'
import './styles.css'

// The app in a real browser, for the things a headless DOM cannot answer.
//
// Every case here is a bug that shipped. They have one thing in common: each was invisible
// to `npm test` and to `npm run build`, and each needed layout, focus or a real key press to
// see — which is to say, each needed this file to exist.
//
// The styles are imported deliberately. Half of what is asserted below is about the CSS
// doing its job, and a browser test that rendered unstyled markup would be a slower way of
// learning nothing.

/** A config with a private key in it, so the share warning has something to warn about. */
const WITH_KEY = `static_resources:
  listeners:
  - name: https
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - transport_socket:
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificates:
            - private_key: { inline_string: "SECRETSECRET" }
      filters: []
  clusters: []
`

const ROUTED = `static_resources:
  listeners:
  - name: ingress
    address: { socket_address: { address: 0.0.0.0, port_value: 8080 } }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          route_config:
            name: local
            virtual_hosts:
            - name: backend
              domains: ["*"]
              routes:
              - match: { prefix: /api }
                route: { cluster: api_service }
  clusters:
  - name: api_service
`

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  // React insists on being told it is under test before `act` will do anything useful.
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root.render(<App />)
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  // The store is a module singleton and unmounting does not touch it, so everything one test
  // leaves behind is where the next one starts. Learnt the hard way: a test that pressed
  // ArrowRight left `graph` selected, which made the Findings tab `tabindex="-1"`, which made
  // the NEXT test's Tab land on the Graph tab and look like the roving tabindex was broken.
  // It was not — the test was.
  useStore.getState().clearConfig()
  useStore.getState().setTab('findings')
  useStore.getState().setCaretLine(null)
})

/** Push a config in the way loading an example does, and let the render settle. */
const load = async (text: string) => {
  await act(async () => {
    useStore.getState().setText(text)
  })
}

const click = async (element: Element) => {
  await act(async () => {
    ;(element as HTMLElement).click()
  })
}

const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) => el.textContent?.trim() === text)!

describe('the share warning, which is where the key material is', () => {
  test('does not run off the side of the dialogue, or widen the page', async () => {
    // It names the field the key is in, and a config path is one unbroken token a hundred
    // and thirty characters long. Without `overflow-wrap` it ran 436px out of a 449px
    // paragraph and took the document's scroll width to 1806px inside a 1400px window —
    // a sideways scrollbar and a sentence ending in `transport_socket.typed_`.
    await load(WITH_KEY)
    await click(byText('.actions button', 'Share link'))

    const dialogue = document.querySelector('.dialogue')!
    const paragraph = dialogue.querySelector('p')!
    expect(paragraph.textContent).toContain('private key')

    expect(paragraph.scrollWidth).toBeLessThanOrEqual(paragraph.clientWidth)
    expect(dialogue.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
    expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
  })

  test('redacts, and the link it produces does not carry the key', async () => {
    await load(WITH_KEY)
    await click(byText('.actions button', 'Share link'))
    await click(byText('.dialogue button', 'Redact and share'))
    // `share` is async — the link is compressed through CompressionStream, which is one more
    // reason this test is in a browser.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
    })

    const link = document.querySelector<HTMLInputElement>('.dialogue input')!
    expect(link.value).toContain('#')
    expect(link.value).not.toContain('SECRETSECRET')
  })
})

describe('the dialogues keep the promises their role makes', () => {
  test('focus moves in, Escape dismisses, and focus goes back', async () => {
    const opener = byText('.actions button', 'Clear') as HTMLElement
    opener.focus()
    await click(opener)

    const dialogue = document.querySelector('.dialogue')!
    expect(dialogue.getAttribute('aria-label')).toBe('Clear this config?')
    expect(dialogue.contains(document.activeElement)).toBe(true)
    // Cancel, not `Clear it`: this destroys work with no undo, and a stray Enter should not
    // be one keystroke from doing it.
    expect(document.activeElement?.textContent).toBe('Cancel')

    await act(async () => {
      await userEvent.keyboard('{Escape}')
    })
    expect(document.querySelector('.dialogue')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  test('and the destructive path still destroys when chosen deliberately', async () => {
    await load(WITH_KEY)
    await click(byText('.actions button', 'Clear'))
    await click(byText('.dialogue button', 'Clear it'))
    expect(useStore.getState().text).not.toContain('SECRETSECRET')
  })
})

describe('the results switcher is a tablist', () => {
  test('arrow keys move between the tabs and the panel follows', async () => {
    const tabs = () => [...document.querySelectorAll('[role="tab"]')]
    const first = tabs()[0] as HTMLElement
    first.focus()

    await act(async () => {
      await userEvent.keyboard('{ArrowRight}')
    })
    expect(document.activeElement?.textContent).toBe('Graph')
    expect(tabs()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(
      'tab-graph',
    )
  })

  test('Tab steps PAST the group, rather than through all three', async () => {
    // The roving tabindex, which is the whole reason a tablist is not three buttons. This is
    // the assertion no headless DOM can make: neither jsdom nor happy-dom implements
    // sequential focus navigation, so pressing Tab there moves nothing at all.
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    ;(tabs[0] as HTMLElement).focus()

    await act(async () => {
      await userEvent.tab()
    })
    expect(tabs).not.toContain(document.activeElement)
  })
})

describe('the graph marks the node the caret is in', () => {
  test('and brings it into view, which is the half that needs layout', async () => {
    await load(ROUTED)
    await click(byText('[role="tab"]', 'Graph'))

    // Straight into the store rather than through CodeMirror: what is under test is the
    // graph's response to a caret, not the editor's ability to report one.
    const routeLine = useStore
      .getState()
      .graph.nodes.find((node) => node.kind === 'route')!.range.line
    await act(async () => {
      useStore.getState().setCaretLine(routeLine)
    })
    // The scroll is smooth, so it needs a moment to arrive.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })

    const marked = document.querySelector('.graph-node.lit')
    expect(marked).not.toBeNull()

    const scroller = document.querySelector('.graph-scroll')!.getBoundingClientRect()
    const inView = [...document.querySelectorAll('.graph-node.lit')].filter((node) => {
      const box = node.getBoundingClientRect()
      return box.left >= scroller.left - 1 && box.right <= scroller.right + 1
    })
    expect(inView.length).toBeGreaterThan(0)
  })

  test('a caret on a line no node covers marks nothing', async () => {
    await load(ROUTED)
    await click(byText('[role="tab"]', 'Graph'))
    await act(async () => {
      useStore.getState().setCaretLine(1)
    })
    expect(document.querySelectorAll('.graph-node.lit')).toHaveLength(0)
  })
})
