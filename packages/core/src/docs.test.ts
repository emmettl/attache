import { describe, expect, test } from 'vitest'
import { ALL_DOCS, docsForCode, docsForKind } from './docs.js'
import type { DiagnosticCode } from './diagnostics.js'
import type { NodeKind } from './graph.js'

// Two tiers, on purpose.
//
// The shape tests run everywhere and hold the invariants that catch a typo: every link is
// absolute, on Envoy's own domain, and carries an anchor. What they CANNOT tell you is
// whether the anchor is really on the page, because that is a fact about a website.
//
// The live check is opt-in behind CHECK_LINKS rather than part of the suite. A test that
// fails when envoyproxy.io is slow is a test that teaches people to ignore a red build, and
// the thing it guards changes on Envoy's release schedule rather than on ours. Run it when
// touching this file:
//
//   CHECK_LINKS=1 npx vitest run packages/core/src/docs.test.ts

describe('the shape of every link', () => {
  test('there are some', () => {
    expect(ALL_DOCS.length).toBeGreaterThan(15)
  })

  test.each(ALL_DOCS.map((d) => [d.title, d.url] as const))('%s', (_title, url) => {
    expect(url.startsWith('https://www.envoyproxy.io/docs/envoy/latest/api-v3/')).toBe(true)
    // An anchor is the whole point: the pages are enormous, and landing at the top of
    // route_components.proto is barely better than not linking at all.
    expect(url).toContain('#envoy-v3-api-')
    expect(url.split('#')).toHaveLength(2)
  })

  test('each one says where it goes', () => {
    for (const doc of ALL_DOCS) expect(doc.title.length).toBeGreaterThan(2)
  })
})

/**
 * What CAN be checked without a network: that each link agrees with itself.
 *
 * Envoy's anchor scheme is regular — `envoy-v3-api-{msg,field}-<package>-<message>[-<field>]`
 * — and `docs.ts` refuses to SYNTHESISE links from it, for the good reason that a generated
 * URL is plausible whether or not the page has the anchor. Checking the reverse direction
 * costs nothing and rules out the mistake that actually happens to a curated list: an entry
 * copied from the one above it and half-edited, so the anchor still names the previous
 * page's package, or the title says one field and the anchor another.
 *
 * This is emphatically NOT a liveness check. It cannot tell you the anchor is on the page —
 * only that the three parts of the entry describe the same thing. `CHECK_LINKS` is the one
 * that talks to the website.
 */
describe('each link agrees with itself', () => {
  const BASE = 'https://www.envoyproxy.io/docs/envoy/latest/api-v3/'

  /** `config/route/v3/route_components.proto` → `config-route-v3`, as an anchor spells it. */
  const packageOf = (url: string): string => {
    const path = url.slice(BASE.length).split('#')[0]!
    return path.split('/').slice(0, -1).join('-').replace(/_/g, '-')
  }

  test.each(ALL_DOCS.map((d) => [d.title, d.url] as const))('%s', (title, url) => {
    const anchor = url.split('#')[1]!
    const kind = anchor.startsWith('envoy-v3-api-msg-')
      ? 'msg'
      : anchor.startsWith('envoy-v3-api-field-')
        ? 'field'
        : undefined
    expect(kind, `${anchor} is neither a msg nor a field anchor`).toBeDefined()

    // The package in the anchor has to be the directory the page lives in. This is the half
    // that catches a half-edited copy: `config/cluster/v3/cluster.proto` carrying an anchor
    // that still says `config-listener-v3`.
    const expected = `envoy-v3-api-${kind}-${packageOf(url)}-`
    expect(anchor.startsWith(expected), `${anchor} should start ${expected}`).toBe(true)

    // And the message and field, when the title is a proto name rather than prose — one
    // entry is titled "Router filter" for the reader's sake, which is allowed.
    const proto = /^([A-Z]\w*)(?:\.(\w+))?$/.exec(title)
    if (!proto) return

    const [, message, field] = proto
    const tail = anchor.slice(expected.length)
    const wanted =
      field === undefined ? message!.toLowerCase() : `${message!.toLowerCase()}-${field.replace(/_/g, '-')}`
    expect(tail, `${title} should anchor on ${wanted}`).toBe(wanted)
    // A dotted title is a field, a bare one is a message. Mixing them up sends the reader to
    // the top of a page instead of to the line they were promised.
    expect(kind).toBe(field === undefined ? 'msg' : 'field')
  })
})

describe('mapping findings to documentation', () => {
  test('the codes worth explaining have a link', () => {
    const linked: DiagnosticCode[] = [
      'cluster-not-found',
      'duplicate-domain',
      'route-unreachable',
      'router-not-last',
      'sni-without-tls',
      'no-filter-chains',
      'no-route-config',
    ]
    for (const code of linked) expect(docsForCode(code), code).toBeDefined()
  })

  test('the ones that are not Envoy questions have none', () => {
    // A stray colon is a YAML problem. Sending somebody to Envoy's schema for it would be
    // confidently unhelpful, which is worse than saying nothing.
    for (const code of ['yaml-error', 'wrong-type', 'missing-required'] as DiagnosticCode[]) {
      expect(docsForCode(code), code).toBeUndefined()
    }
  })

  test('every kind of thing in the graph is documented', () => {
    const kinds: NodeKind[] = [
      'listener',
      'filterChain',
      'routeConfig',
      'virtualHost',
      'route',
      'cluster',
      'endpoint',
    ]
    for (const kind of kinds) expect(docsForKind(kind), kind).toBeDefined()
  })
})

// Declared here rather than by adding "node" or "DOM" to the package's `types`. This
// package compiles without either on purpose — that is what stops the core reaching for a
// host global — and widening the whole project's lib so one opt-in test can call fetch
// would trade the constraint for a convenience. The declarations are as narrow as the two
// uses below.
declare const process: { env: Record<string, string | undefined> }
declare function fetch(url: string): Promise<{ ok: boolean; status: number; text(): Promise<string> }>

describe.runIf(process.env.CHECK_LINKS)('against the live documentation', () => {
  /**
   * Being unable to READ a page is not evidence that its anchors are gone.
   *
   * This check used to call `fetch(url).then(r => r.text())` and go straight to looking for
   * anchors in whatever came back. Run it from behind an egress allowlist and every fetch
   * returns a hundred-byte "host not in allowlist" page — which contains no anchors, so the
   * test reported all twenty-four links as broken and named them one by one.
   *
   * That is the failure this file's own comment says the check was made opt-in to avoid,
   * arrived at from the other direction: not a red build when the site is slow, but a red
   * build that is confidently specific about the wrong thing. Somebody would have gone and
   * "fixed" links that were fine.
   *
   * So a page has to arrive, and it has to look like Envoy's reference — any of its pages
   * carries dozens of `envoy-v3-api-` anchors, so a document with none of them is a login
   * wall, a proxy notice or a redirect, and the honest report is that it could not be read.
   */
  const readable = async (url: string): Promise<string> => {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`could not reach ${url} — HTTP ${response.status}`)
    const html = await response.text()
    if (!html.includes('envoy-v3-api-')) {
      throw new Error(
        `${url} returned ${html.length} bytes that do not look like Envoy's reference — reachable, but not the page`,
      )
    }
    return html
  }

  test('every anchor is really on its page', async () => {
    const pages = new Map<string, Set<string>>()
    for (const doc of ALL_DOCS) {
      const [url, anchor] = doc.url.split('#')
      if (!pages.has(url!)) pages.set(url!, new Set())
      pages.get(url!)!.add(anchor!)
    }

    const broken: string[] = []
    for (const [url, anchors] of pages) {
      // Deliberately not caught: an unreachable page fails the test with a sentence about
      // the network rather than with a list of links to go and edit.
      const html = await readable(url)
      for (const anchor of anchors) {
        if (!html.includes(`id="${anchor}"`)) broken.push(`${url}#${anchor}`)
      }
    }
    expect(broken).toEqual([])
  }, 120_000)
})
