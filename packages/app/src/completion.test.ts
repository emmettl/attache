import { parser } from '@lezer/yaml'
import { describe, expect, test } from 'vitest'
import { inKeyPosition, keyContextAt } from './completion.js'

// The tree-walking half of completion, tested against a real parse rather than a mock.
//
// Every case below is written with a `|` marking the caret, which is stripped before
// parsing. Reading them is the point: the interesting ones are the configs that are BROKEN
// at the moment of asking, because that is when somebody is typing into them.

function at(withCaret: string) {
  const pos = withCaret.indexOf('|')
  if (pos === -1) throw new Error('no caret in fixture')
  const text = withCaret.slice(0, pos) + withCaret.slice(pos + 1)
  const tree = parser.parse(text)
  const read = (from: number, to: number) => text.slice(from, to)
  return { context: keyContextAt(tree, read, pos), inKey: inKeyPosition(tree, read, pos) }
}

describe('the keys enclosing the caret', () => {
  test('a value in a nested block', () => {
    expect(
      at(`
static_resources:
  listeners:
  - filter_chains:
    - filters:
      - typed_config:
          route_config:
            virtual_hosts:
            - routes:
              - route:
                  cluster: api|
`).context,
    ).toEqual([
      'static_resources',
      'listeners',
      'filter_chains',
      'filters',
      'typed_config',
      'route_config',
      'virtual_hosts',
      'routes',
      'route',
      'cluster',
    ])
  })

  test('flow style resolves the same way', () => {
    expect(at('routes:\n- route: { cluster: ap| }\n').context).toEqual(['routes', 'route', 'cluster'])
  })

  test('a quoted key comes back unquoted, which `@type` always needs', () => {
    expect(at('typed_config:\n  "@type": type.googleapis.com/x|\n').context).toEqual([
      'typed_config',
      '@type',
    ])
  })
})

describe('a document that is mid-edit, which is the only kind that matters here', () => {
  test('a key with no value yet still resolves to its pair', () => {
    // The moment somebody presses Alt+Space. There is no value node to be inside of, and
    // looking left is what finds the pair rather than the next line.
    expect(at('static_resources:\n  clusters:\n  - type: |\n').context).toEqual([
      'static_resources',
      'clusters',
      'type',
    ])
  })

  test('an unparseable document below the caret does not stop it', () => {
    expect(
      at(`
static_resources:
  listeners:
  - filter_chains:
    - filters:
      - name: |
  broken: [1, 2
`).context,
    ).toEqual(['static_resources', 'listeners', 'filter_chains', 'filters', 'name'])
  })

  test('a half-typed value keeps the key it belongs to', () => {
    expect(at('clusters:\n- type: STRI|\n').context).toEqual(['clusters', 'type'])
  })
})

describe('the key half of a pair', () => {
  test('editing an existing field name is recognised and refused', () => {
    // The guard that keeps this from ever becoming field completion by accident.
    expect(at('routes:\n- clust|er: x\n').inKey).toBe(true)
  })

  test('typing a value is not', () => {
    expect(at('static_resources:\n  clusters:\n  - type: STRI|\n').inKey).toBe(false)
  })

  test('a field name still being typed, with no colon after it yet, is also refused', () => {
    // The case worth pinning down, because it is the one that would turn this into field
    // completion by accident. lezer reads a bare word at a mapping position as a `Key` on a
    // `Pair` with no value — it does not wait for the colon — so the guard catches a field
    // name from the first character. Sitting beside `type: STATIC`, the alternative was a
    // menu of cluster discovery types appearing while somebody typed the word `name`.
    expect(at('clusters:\n- type: STATIC\n  nam|\n').inKey).toBe(true)
  })
})
