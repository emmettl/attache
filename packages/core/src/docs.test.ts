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
declare function fetch(url: string): Promise<{ text(): Promise<string> }>

describe.runIf(process.env.CHECK_LINKS)('against the live documentation', () => {
  test('every anchor is really on its page', async () => {
    const pages = new Map<string, Set<string>>()
    for (const doc of ALL_DOCS) {
      const [url, anchor] = doc.url.split('#')
      if (!pages.has(url!)) pages.set(url!, new Set())
      pages.get(url!)!.add(anchor!)
    }

    const broken: string[] = []
    for (const [url, anchors] of pages) {
      const html = await fetch(url).then((r) => r.text())
      for (const anchor of anchors) {
        if (!html.includes(`id="${anchor}"`)) broken.push(`${url}#${anchor}`)
      }
    }
    expect(broken).toEqual([])
  }, 120_000)
})
