import { describe, expect, test } from 'vitest'
import { CONFIG_DUMP, FRONT_PROXY, PRODUCTION, TROUBLE } from './fixtures.js'
import { analyse } from './index.js'
import { describeSecrets, findSecrets, redact } from './redact.js'

const WITH_KEY = `
static_resources:
  listeners:
  - name: https
    address: { socket_address: { address: 0.0.0.0, port_value: 443 } }
    filter_chains:
    - transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_certificates:
            - certificate_chain:
                inline_string: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----"
              private_key:
                inline_string: "-----BEGIN PRIVATE KEY-----\\nsecretsecretsecret\\n-----END PRIVATE KEY-----"
      filters: []
  clusters: []
`

describe('finding key material', () => {
  test('an inline private key is found', () => {
    const found = findSecrets(WITH_KEY)
    expect(found).toHaveLength(1)
    expect(found[0]!.what).toBe('a TLS private key')
  })

  test('the certificate next to it is left alone', () => {
    // A public certificate is not a secret, and flagging it would teach people to click
    // through the warning that also covers the key.
    expect(findSecrets(WITH_KEY).some((s) => s.path.includes('certificate_chain'))).toBe(false)
  })

  test('a config with nothing sensitive finds nothing', () => {
    expect(findSecrets('static_resources: { clusters: [{ name: a }] }')).toEqual([])
  })

  test('everything under an SDS `secrets` block counts', () => {
    const found = findSecrets(`
static_resources:
  secrets:
  - name: server_cert
    tls_certificate:
      certificate_chain: { inline_string: "cert" }
      private_key: { inline_string: "key" }
`)
    expect(found.length).toBeGreaterThanOrEqual(2)
  })
})

describe('redacting', () => {
  const { text, removed } = redact(WITH_KEY)

  test('the key is gone', () => {
    expect(removed).toHaveLength(1)
    expect(text).not.toContain('secretsecretsecret')
    expect(text).toContain('"REDACTED"')
  })

  test('everything else survives byte for byte', () => {
    // Spliced by range rather than re-serialised, so comments, quoting and indentation are
    // untouched — a redacted config should still be the file you recognise.
    expect(text).toContain('-----BEGIN CERTIFICATE-----')
    expect(text).toContain('port_value: 443')
    expect(text.split('\n')).toHaveLength(WITH_KEY.split('\n').length)
  })

  test('the redacted config still parses and still means the same thing', () => {
    const before = analyse(WITH_KEY).model
    const after = analyse(text).model
    expect(after.listeners[0]!.address).toEqual(before.listeners[0]!.address)
    expect(analyse(text).diagnostics.filter((d) => d.code === 'yaml-error')).toEqual([])
  })

  test('a config with no secrets is returned unchanged', () => {
    const plain = 'static_resources: { clusters: [{ name: a }] }'
    expect(redact(plain)).toEqual({ text: plain, removed: [], complete: true })
  })
})

test('the warning says what was found and where', () => {
  expect(describeSecrets(findSecrets(WITH_KEY))).toContain('a TLS private key')
  expect(describeSecrets([])).toBe('No key material found.')
})

// Configs the redactor used to hand back with the key still in them.
//
// Every one of these was silent: the config parsed, the share dialogue never appeared
// because `findSecrets` returned nothing, and the link looked exactly like a clean one.
// That is the worst shape a bug in this file can take, so each has a test that asserts on
// the OUTPUT rather than on the finding — what matters is that the bytes are gone.
describe('key material that used to travel', () => {
  const leaks = (text: string) => redact(text).text.includes('SECRETSECRET')

  test('a key reached through an alias', () => {
    // An alias is neither map, sequence nor scalar, so the walk stepped over it and
    // `scalarsUnder` came back empty. The anchor is what gets redacted, which is where the
    // bytes are — and every alias pointing at it then resolves to `"REDACTED"`.
    const text = `
shared: &k
  inline_string: "SECRETSECRET"
static_resources:
  listeners:
  - transport_socket:
      typed_config:
        common_tls_context:
          tls_certificates:
          - private_key: *k
`
    expect(findSecrets(text)).toHaveLength(1)
    expect(leaks(text)).toBe(false)
    expect(analyse(redact(text).text).diagnostics.filter((d) => d.code === 'yaml-error')).toEqual([])
  })

  test('a key arriving through a merge key, spliced once and not twice', () => {
    // Found twice — once at the anchor, once through the merge — naming one span of text.
    // Splicing it twice would write over the first replacement's own characters.
    const text = `
defaults: &d
  private_key: { inline_string: "SECRETSECRET" }
static_resources:
  listeners:
  - transport_socket:
      typed_config:
        common_tls_context:
          tls_certificates:
          - <<: *d
            certificate_chain: { inline_string: "cert" }
`
    const { text: out } = redact(text)
    expect(out).not.toContain('SECRETSECRET')
    expect(out.match(/"REDACTED"/g)).toHaveLength(1)
    expect(out).toContain('certificate_chain: { inline_string: "cert" }')
    expect(analyse(out).diagnostics.filter((d) => d.code === 'yaml-error')).toEqual([])
  })

  test('a key in a second YAML document', () => {
    // The redactor's remit is the text that will travel, not the config that was modelled.
    // Somebody pasting a pair of Kubernetes manifests shares both halves.
    expect(
      leaks(`
static_resources:
  clusters:
  - name: a
---
static_resources:
  listeners:
  - transport_socket:
      typed_config:
        common_tls_context:
          tls_certificates:
          - private_key: { inline_string: "SECRETSECRET" }
`),
    ).toBe(false)
  })

  test.each([
    ['a Redis downstream password', 'downstream_auth_password: { inline_string: "SECRETSECRET" }'],
    ['a Redis upstream password', 'auth_password: { inline_string: "SECRETSECRET" }'],
    ['a service account key', 'call_credentials: [{ service_account_jwt_access: { json_key: "SECRETSECRET" } }]'],
    ['a gRPC access token', 'call_credentials: [{ access_token: "SECRETSECRET" }]'],
    ['an inline htpasswd', 'users: { inline_string: "admin:SECRETSECRET" }'],
    ['an AWS secret access key', 'secret_access_key: "SECRETSECRET"'],
    ['an API key', 'api_key: "SECRETSECRET"'],
  ])('%s', (_what, field) => {
    expect(leaks(`static_resources:\n  clusters:\n  - name: c\n    ${field}\n`)).toBe(false)
  })
})

describe('the redactor checking its own work', () => {
  test('a clean pass reports itself complete', () => {
    expect(redact(WITH_KEY).complete).toBe(true)
    expect(redact('static_resources: { clusters: [{ name: a }] }').complete).toBe(true)
  })

  test('what it says it removed is genuinely gone', () => {
    // The invariant the share gate rests on, asserted directly: after a redaction, a second
    // scan of the result finds nothing. `complete` is that scan, and the app refuses to
    // make a link when it comes back false.
    const { text, complete } = redact(WITH_KEY)
    expect(complete).toBe(true)
    // Not "the scan comes back empty" — `private_key` is still a field called `private_key`
    // after its value has gone. Every position it names holds the mask and nothing else.
    for (const left of findSecrets(text)) {
      expect(text.slice(left.range.start, left.range.end)).toBe('"REDACTED"')
    }
  })
})

describe('warnings that should not fire', () => {
  test('an SDS reference is not treated as the secret it names', () => {
    // `SdsSecretConfig` is a name and a place to fetch from. Offering to redact it broke the
    // reference on every config that fetches its certificates rather than inlining them —
    // and a warning that fires on things that are not secret is one people learn to click
    // through, taking the real one with it.
    expect(
      findSecrets(`
static_resources:
  listeners:
  - transport_socket:
      typed_config:
        common_tls_context:
          tls_certificate_sds_secret_configs:
          - name: server_cert
            sds_config: { ads: {} }
`),
    ).toEqual([])
  })

  test('the fixtures and every shipped example are clean', () => {
    // If any of these starts reporting key material, either a config gained some or the
    // matching got broader than it should be. Both are worth failing a build over.
    for (const config of [FRONT_PROXY, PRODUCTION, TROUBLE, CONFIG_DUMP]) {
      expect(findSecrets(config)).toEqual([])
    }
  })
})
