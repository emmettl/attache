import { describe, expect, test } from 'vitest'
import { MAX_SPLIT, MIN_SPLIT, clampSplit, parseHeaders, toTestRequest } from './store.js'

// The store's pure half.
//
// Everything else in this file's source needs a browser to reach, but these three are
// ordinary functions that happen to live next to one — and they sit on the path from what
// somebody typed into the route tester to what the matcher is asked. A header dropped here
// is a header the answer was computed without, silently.

describe('reading the headers box', () => {
  test('one `name: value` per line', () => {
    expect(parseHeaders('x-canary: yes\nx-tier: gold')).toEqual({
      'x-canary': 'yes',
      'x-tier': 'gold',
    })
  })

  test('names are lower-cased and both halves trimmed', () => {
    // HTTP/2 field names are lower-case and the matcher compares them that way, so a header
    // typed in the case somebody reads it in has to arrive in the case it is matched in.
    expect(parseHeaders('  X-Canary :   yes  ')).toEqual({ 'x-canary': 'yes' })
  })

  test('split on the FIRST colon, so a value may contain more', () => {
    expect(parseHeaders('x-origin: https://example.com:8443/a')).toEqual({
      'x-origin': 'https://example.com:8443/a',
    })
  })

  test('blank lines and lines without a colon are skipped', () => {
    expect(parseHeaders('\n\nnonsense\nx-a: 1\n   \n')).toEqual({ 'x-a': '1' })
  })

  test('an empty value is kept, because sending an empty header is a real thing to test', () => {
    expect(parseHeaders('x-empty:')).toEqual({ 'x-empty': '' })
  })

  test('a pseudo-header typed here is dropped, since the form has its own fields for them', () => {
    // `:authority` starts with the colon, so there is no name to the left of it and the line
    // is skipped. Locked in as behaviour rather than left to chance: the tester has dedicated
    // Method, :authority and :path fields, and `whyNotRoute` supplies all three itself, so a
    // second copy arriving through here could only disagree with them.
    expect(parseHeaders(':authority: elsewhere.example\nx-real: 1')).toEqual({ 'x-real': '1' })
  })

  test('a repeated name keeps the last, as a map must', () => {
    expect(parseHeaders('x-a: 1\nx-a: 2')).toEqual({ 'x-a': '2' })
  })
})

describe('turning the form into a request', () => {
  const form = {
    authority: 'www.example.com',
    path: '/api/users',
    method: 'get',
    port: '10000',
    serverName: '',
    headers: 'x-canary: yes',
  }

  test('carries the fields across, upper-casing the method', () => {
    // `:method` is upper-case on the wire, and a route matching on it compares it that way.
    expect(toTestRequest(form)).toEqual({
      authority: 'www.example.com',
      path: '/api/users',
      method: 'GET',
      port: 10000,
      serverName: undefined,
      headers: { 'x-canary': 'yes' },
    })
  })

  test('an empty port means "do not ask about the port", not port zero', () => {
    // The matcher treats an absent port as "pick the only listener", which is the useful
    // behaviour on a single-listener config. Zero would mean something else entirely.
    expect(toTestRequest({ ...form, port: '' }).port).toBeUndefined()
    expect(toTestRequest({ ...form, port: '   ' }).port).toBeUndefined()
  })

  test('a port that is not a number is dropped rather than passed on as NaN', () => {
    expect(toTestRequest({ ...form, port: 'eighty' }).port).toBeUndefined()
    expect(toTestRequest({ ...form, port: '80abc' }).port).toBeUndefined()
  })

  test('port zero survives, because it is a number somebody could mean', () => {
    expect(toTestRequest({ ...form, port: '0' }).port).toBe(0)
  })

  test('a blank SNI is absent rather than empty', () => {
    // The chain matcher distinguishes "sent no SNI" from "sent an empty one", and an empty
    // string from an untouched form is the former.
    expect(toTestRequest({ ...form, serverName: '  ' }).serverName).toBeUndefined()
    expect(toTestRequest({ ...form, serverName: ' api.example.com ' }).serverName).toBe(
      'api.example.com',
    )
  })
})

describe('the pane split', () => {
  test('neither pane can be dragged shut', () => {
    // A pane collapsed to nothing looks like a broken app rather than a choice, and the
    // handle that would drag it back is under a scrollbar at the edge of the window.
    expect(clampSplit(0)).toBe(MIN_SPLIT)
    expect(clampSplit(-3)).toBe(MIN_SPLIT)
    expect(clampSplit(1)).toBe(MAX_SPLIT)
    expect(clampSplit(99)).toBe(MAX_SPLIT)
  })

  test('anything in range is left alone', () => {
    expect(clampSplit(0.5)).toBe(0.5)
    expect(clampSplit(MIN_SPLIT)).toBe(MIN_SPLIT)
    expect(clampSplit(MAX_SPLIT)).toBe(MAX_SPLIT)
  })
})
