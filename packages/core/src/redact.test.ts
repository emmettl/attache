import { describe, expect, test } from 'vitest'
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
    expect(redact(plain)).toEqual({ text: plain, removed: [] })
  })
})

test('the warning says what was found and where', () => {
  expect(describeSecrets(findSecrets(WITH_KEY))).toContain('a TLS private key')
  expect(describeSecrets([])).toBe('No key material found.')
})
