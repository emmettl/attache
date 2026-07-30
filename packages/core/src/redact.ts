import { isMap, isScalar, isSeq, type Node } from 'yaml'
import { parse } from './parse.js'
import { formatPath, toCamel, type ConfigPath, type Range } from './source.js'

// Finding the parts of a config nobody should paste into a chat window.
//
// This exists because of the share button. Putting a document in a URL fragment is safe in
// the narrow sense the fragment guarantees — it never reaches a server — and that
// guarantee is beside the point: a shared link goes to a person, and Envoy bootstraps
// routinely carry a TLS private key inline, a few lines below the listener somebody
// actually wanted to ask about. The fragment being private from the network does not make
// the key private from the recipient.
//
// So sharing goes through here first, and the app will not produce a link until what this
// finds has been masked.

export interface Secret {
  /** The field that holds it, as written. */
  key: string
  path: ConfigPath
  range: Range
  /** What it is, in words, for the dialogue that asks before sharing. */
  what: string
}

/**
 * Fields whose value is key material or a credential.
 *
 * Matched on the field name rather than on the value, because a heuristic that looked for
 * PEM headers or high-entropy strings would miss a key delivered by reference and would
 * fire on a base64 SHA. The name is what Envoy's schema guarantees.
 */
const SECRET_FIELDS = new Map<string, string>([
  ['privateKey', 'a TLS private key'],
  ['privateKeyProvider', 'a TLS private key provider'],
  ['sessionTicketKeys', 'TLS session ticket keys'],
  ['genericSecret', 'a generic secret'],
  ['hmacSecret', 'an HMAC secret'],
  ['tokenSecret', 'a token secret'],
  ['clientSecret', 'an OAuth client secret'],
  ['password', 'a password'],
  ['credential', 'a credential'],
  ['credentials', 'credentials'],
])

/**
 * Ancestors under which everything is sensitive.
 *
 * `secrets` is the SDS block, where a certificate, its key and its validation context all
 * live together — flagging only the key would leave the rest of a bundle in the link.
 */
const SECRET_SUBTREES = new Set(['secrets', 'tlsCertificateSdsSecretConfigs'])

/** The scalar leaves under a node, or the node itself when it is one. */
function scalarsUnder(node: Node | null, into: Node[] = []): Node[] {
  if (node === null) return into
  if (isScalar(node)) into.push(node)
  else if (isMap(node)) for (const pair of node.items) scalarsUnder((pair.value ?? null) as Node | null, into)
  else if (isSeq(node)) for (const item of node.items) scalarsUnder((item ?? null) as Node | null, into)
  return into
}

/**
 * Everything in this config that should not travel.
 *
 * Walks the raw document rather than the model on purpose: the model covers the routing
 * spine and nothing else, and a private key is precisely the sort of thing that lives in
 * the parts of a config this package does not otherwise interpret. A redactor that could
 * only see what the model saw would miss almost every secret there is.
 */
export function findSecrets(text: string): Secret[] {
  const { root, positions } = parse(text)
  const found: Secret[] = []

  const walk = (node: Node | null, path: ConfigPath, insideSecret: boolean): void => {
    if (node === null) return

    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key)) continue
        const raw = String(pair.key.value)
        const camel = toCamel(raw)
        const value = (pair.value ?? null) as Node | null
        const here: ConfigPath = [...path, raw]

        const what = SECRET_FIELDS.get(camel)
        if (what !== undefined || insideSecret) {
          // Only leaves carry the material; reporting the enclosing map as well would
          // double-count it and make the count in the warning wrong.
          if (isScalar(value)) {
            found.push({
              key: raw,
              path: here,
              range: positions.range(value.range),
              what: what ?? 'part of a secret',
            })
            continue
          }
          if (what !== undefined) {
            for (const leaf of scalarsUnder(value)) {
              found.push({ key: raw, path: here, range: positions.range(leaf.range), what })
            }
            continue
          }
        }

        walk(value, here, insideSecret || SECRET_SUBTREES.has(camel))
      }
      return
    }

    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        walk((item ?? null) as Node | null, [...path, index], insideSecret)
      })
    }
  }

  walk(root, [], false)
  return found
}

export interface Redaction {
  text: string
  removed: Secret[]
}

/**
 * The same config with the secrets replaced.
 *
 * Splices the original text by range rather than re-serialising the document, so comments,
 * key order, quoting style and indentation all survive. A share link that came back as
 * semantically-equivalent-but-reformatted YAML would be a worse thing to send somebody
 * than the file they actually have, and the diff would obscure the redaction itself.
 *
 * Applied back to front, because every replacement shifts the offsets after it.
 */
export function redact(text: string): Redaction {
  const removed = findSecrets(text)
  if (removed.length === 0) return { text, removed }

  const ordered = [...removed].sort((a, b) => b.range.start - a.range.start)
  let out = text
  for (const secret of ordered) {
    const { start, end } = secret.range
    if (end <= start) continue
    out = `${out.slice(0, start)}"REDACTED"${out.slice(end)}`
  }
  return { text: out, removed }
}

/** One sentence for the dialogue that asks before a link is made. */
export function describeSecrets(secrets: readonly Secret[]): string {
  if (secrets.length === 0) return 'No key material found.'
  const kinds = [...new Set(secrets.map((s) => s.what))]
  const where = secrets.length === 1 ? formatPath(secrets[0]!.path) : `${secrets.length} places`
  return `This config contains ${kinds.join(', ')} — in ${where}.`
}
