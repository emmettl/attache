import { isMap, isScalar, isSeq, type Document, type Node } from 'yaml'
import { deref } from './cursor.js'
import { parseAll } from './parse.js'
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
  ['secret', 'a secret'],
  // Redis, which is the commonest place a password is written inline in an Envoy config:
  // the proxy authenticates downstream clients with one and the cluster authenticates
  // itself upstream with another, and both are ordinary `DataSource`s in the file.
  ['authPassword', 'a Redis upstream password'],
  ['downstreamAuthPassword', 'a Redis downstream password'],
  ['downstreamAuthPasswords', 'Redis downstream passwords'],
  // gRPC call credentials. `json_key` is a whole Google service account key — the file you
  // are told never to commit — and `access_token` is a bearer token by another name.
  ['jsonKey', 'a service account key'],
  ['accessToken', 'an access token'],
  ['refreshToken', 'a refresh token'],
  // AWS, for the request-signing and credential-injection filters.
  ['secretAccessKey', 'an AWS secret access key'],
  ['sessionToken', 'an AWS session token'],
  ['apiKey', 'an API key'],
  ['secretKey', 'a secret key'],
  ['sharedSecret', 'a shared secret'],
  ['preSharedKey', 'a pre-shared key'],
  // `basic_auth` keeps its htpasswd inline, so this one field is every password the
  // listener accepts.
  ['users', 'inline user credentials'],
])

/**
 * Ancestors under which everything is sensitive.
 *
 * `secrets` is the SDS block, where a certificate, its key and its validation context all
 * live together — flagging only the key would leave the rest of a bundle in the link. The
 * config-dump envelopes beside it hold the same thing after a management server has
 * delivered it, and `call_credentials` is a list whose every arm is, by definition, one.
 *
 * `tls_certificate_sds_secret_configs` used to be on this list and is not. It holds no
 * material: an `SdsSecretConfig` is a NAME and a place to fetch it from, so flagging it
 * offered to redact the reference — breaking it — on every config that fetches its
 * certificates rather than inlining them, which is most of the good ones. The sensitive part
 * of the `sds_config` beneath it is the credentials on its config source, and those are
 * covered above in their own right. This is the same judgement the certificate next to a
 * private key already gets: a warning that fires on things that are not secret is a warning
 * people learn to click through, and it covers the real one on its way past.
 */
const SECRET_SUBTREES = new Set([
  'secrets',
  'staticSecrets',
  'dynamicActiveSecrets',
  'dynamicWarmingSecrets',
  'callCredentials',
])

/**
 * The scalar leaves under a node, or the node itself when it is one.
 *
 * Follows aliases for the same reason the walk below does — see `findSecrets`.
 */
function scalarsUnder(doc: Document, node: Node | null, into: Node[] = [], depth = 0): Node[] {
  const here = deref(doc, node)
  if (here === null || depth > 32) return into
  if (isScalar(here)) into.push(here)
  else if (isMap(here)) {
    for (const pair of here.items) {
      scalarsUnder(doc, (pair.value ?? null) as Node | null, into, depth + 1)
    }
  } else if (isSeq(here)) {
    for (const item of here.items) scalarsUnder(doc, (item ?? null) as Node | null, into, depth + 1)
  }
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
  const { docs, positions } = parseAll(text)
  const found: Secret[] = []

  for (const doc of docs) {
    /**
     * Aliases are resolved before anything is decided about a node.
     *
     * `private_key: *shared` used to find nothing at all: an alias is neither a map nor a
     * sequence nor a scalar, so the walk stepped over it, `scalarsUnder` returned an empty
     * list, and the key travelled. Nothing about that was visible — the config parsed, the
     * share dialogue never appeared, and the link looked exactly like a clean one.
     *
     * What gets recorded is the range of the node the alias RESOLVES to, which is where the
     * bytes actually are. Redacting the anchor is also the correct repair: every alias
     * pointing at it then resolves to `"REDACTED"`, and the document stays valid.
     */
    const walk = (node: Node | null, path: ConfigPath, insideSecret: boolean): void => {
      const here = deref(doc, node)
      if (here === null) return

      if (isMap(here)) {
        for (const pair of here.items) {
          if (!isScalar(pair.key)) continue
          const raw = String(pair.key.value)
          const camel = toCamel(raw)
          const value = deref(doc, (pair.value ?? null) as Node | null)
          const at: ConfigPath = [...path, raw]

          const what = SECRET_FIELDS.get(camel)
          if (what !== undefined || insideSecret) {
            // Only leaves carry the material; reporting the enclosing map as well would
            // double-count it and make the count in the warning wrong.
            if (isScalar(value)) {
              found.push({
                key: raw,
                path: at,
                range: positions.range(value.range),
                what: what ?? 'part of a secret',
              })
              continue
            }
            if (what !== undefined) {
              for (const leaf of scalarsUnder(doc, value)) {
                found.push({ key: raw, path: at, range: positions.range(leaf.range), what })
              }
              continue
            }
          }

          walk(value, at, insideSecret || SECRET_SUBTREES.has(camel))
        }
        return
      }

      if (isSeq(here)) {
        here.items.forEach((item, index) => {
          walk((item ?? null) as Node | null, [...path, index], insideSecret)
        })
      }
    }

    walk((doc.contents ?? null) as Node | null, [], false)
  }

  return found
}

export interface Redaction {
  text: string
  removed: Secret[]
  /**
   * Whether a second pass over the result found nothing left.
   *
   * Checked rather than assumed, because this is the one function in the package whose
   * being quietly wrong costs somebody a private key rather than a wrong answer on a screen.
   * Every caller that produces a link must refuse to when this is false; there is no reading
   * of "I redacted it, mostly" that is safe to act on.
   */
  complete: boolean
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
/** What replaces the material. Quoted so the result is still valid YAML wherever it lands. */
const MASK = '"REDACTED"'

export function redact(text: string): Redaction {
  const removed = findSecrets(text)
  if (removed.length === 0) return { text, removed, complete: true }

  // Back to front, because every replacement shifts the offsets after it — and once each,
  // because two entries can now legitimately name the same bytes. One anchor aliased into
  // two secret positions is found twice and is one span of text; splicing it twice would
  // write `"REDACTED"` over the first replacement's own characters and corrupt the file.
  const ordered = [...removed]
    .filter((secret) => secret.range.end > secret.range.start)
    .sort((a, b) => b.range.start - a.range.start)

  let out = text
  let last = Number.POSITIVE_INFINITY
  for (const secret of ordered) {
    const { start, end } = secret.range
    // Anything reaching into a span already replaced is a duplicate of it or nested in it,
    // and either way the bytes are gone.
    if (end > last) continue
    out = `${out.slice(0, start)}${MASK}${out.slice(end)}`
    last = start
  }

  // The check is that every secret-bearing position in the RESULT now holds the mask and
  // nothing else — not that the scan comes back empty, which it never can: `private_key` is
  // still a field called `private_key` after its value has been replaced, and a redactor
  // that waited for its own findings to disappear would call every successful pass a
  // failure.
  const leftover = findSecrets(out).filter(
    (secret) => out.slice(secret.range.start, secret.range.end) !== MASK,
  )

  return { text: out, removed, complete: leftover.length === 0 }
}

/** One sentence for the dialogue that asks before a link is made. */
export function describeSecrets(secrets: readonly Secret[]): string {
  if (secrets.length === 0) return 'No key material found.'
  const kinds = [...new Set(secrets.map((s) => s.what))]
  const where = secrets.length === 1 ? formatPath(secrets[0]!.path) : `${secrets.length} places`
  return `This config contains ${kinds.join(', ')} — in ${where}.`
}
