// Putting a config in a URL fragment.
//
// The fragment is the right place for this and not merely a convenient one: everything
// after the `#` never reaches a server, so a shared link carries somebody's config without
// it being logged by anything on the way.
//
// That guarantee is narrower than it sounds, and the app leans on `redact.ts` in the core
// for the rest of it. A fragment is private from the network; it is not private from the
// person you send the link to, and an Envoy bootstrap has a TLS private key in it more
// often than not. Nothing here should be reachable without going through that check first.
//
// The compression is what makes it usable at all. Envoy YAML is repetitive — the same
// `socket_address`, `typed_config` and `@type` strings over and over — so deflate takes
// roughly a fifth of it. A 20 kB bootstrap becomes about 4 kB of base64url, which is long
// but pasteable; without it the same config would not survive most chat clients.

const MARKERS = [
  ['cz', true],
  ['cr', false],
] as const

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function through(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * Compressed and base64url'd, behind a marker saying how it was encoded.
 *
 * `z` for deflated and `r` for raw, so a browser without CompressionStream can still read
 * a link made by one that had it, and the other way round.
 */
export async function toHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  if (typeof CompressionStream === 'undefined') return `cr${toBase64Url(bytes)}`

  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return `cz${toBase64Url(await through(stream))}`
}

/** Read a fragment back, or null if it is not one of ours. */
export async function fromHash(hash: string): Promise<string | null> {
  const payload = hash.replace(/^#/, '')
  const found = MARKERS.find(([prefix]) => payload.startsWith(prefix))
  if (!found) return null

  const [prefix, deflated] = found
  const body = payload.slice(prefix.length)
  if (body === '') return null

  try {
    const bytes = fromBase64Url(body)
    if (!deflated) return new TextDecoder().decode(bytes)
    if (typeof DecompressionStream === 'undefined') return null
    const stream = new Blob([bytes as BufferSource])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return new TextDecoder().decode(await through(stream))
  } catch {
    // Truncated by a chat client, mangled by an email wrapper, or simply not one of ours.
    return null
  }
}

/** A link to this page carrying `text`. Relative to wherever the page actually is. */
export async function linkTo(text: string): Promise<string> {
  const { origin, pathname } = window.location
  return `${origin}${pathname}#${await toHash(text)}`
}

/**
 * Take the config out of the current URL, if there is one, and clear the hash.
 *
 * Clearing matters. Leaving it there means the next reload silently throws away everything
 * done since the link was opened and starts again from the shared version, which looks
 * exactly like losing your work.
 */
export async function takeFromUrl(): Promise<string | null> {
  const hash = window.location.hash
  if (hash.length < 2) return null

  const found = await fromHash(hash)
  if (found === null) return null

  window.history.replaceState(null, '', window.location.pathname + window.location.search)
  return found
}
