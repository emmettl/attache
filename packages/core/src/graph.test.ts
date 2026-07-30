import { describe, expect, test } from 'vitest'
import { PRODUCTION } from './fixtures.js'
import { buildGraph, type NodeKind } from './graph.js'
import { analyse } from './index.js'

// The graph's second lines, which are the only place several modelled facts show up.
//
// A node is under two hundred pixels wide, so what goes on that line is a judgement about
// what somebody scanning the picture needs and what they can go and read. These tests are
// about that judgement rather than about the layout, which lives in the app.

// By kind as well as by label, because a route and the virtual host it sits in are
// routinely given the same name and the fixture is no exception.
const detailOf = (text: string, kind: NodeKind, label: string): string | undefined =>
  buildGraph(analyse(text).model).nodes.find((n) => n.kind === kind && n.label === label)?.detail

describe('what a node says under its name', () => {
  test('a listener carries its direction beside its address', () => {
    // The fact that separates a sidecar's inbound listener from its outbound one, which is
    // otherwise a matter of remembering which port is which.
    expect(detailOf(PRODUCTION, 'listener', 'virtual_inbound')).toBe('0.0.0.0:15006 · inbound')
  })

  test('a route whose action has no edge says what it does instead', () => {
    // Neither of these draws an edge to a cluster, so without this they sit in the graph as
    // dead ends with nothing to say for themselves.
    expect(detailOf(PRODUCTION, 'route', 'legacy')).toBe('prefix /v1 · redirect → api.example.com')
    expect(detailOf(PRODUCTION, 'route', 'health')).toContain('direct 200')
  })

  test('a route that switches a filter off is not drawn the same as one that does not', () => {
    // Namespace dropped: every filter anybody writes shares the prefix, so spelling it out
    // costs the whole label to say nothing. The full name is one click away in the source.
    expect(detailOf(PRODUCTION, 'route', 'health')).toContain('disables ext_authz')
  })

  test('a plain proxying route says only what it matches on', () => {
    expect(detailOf(PRODUCTION, 'route', 'api')).toBe('prefix /')
  })
})
