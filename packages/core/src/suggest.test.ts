import { describe, expect, test } from 'vitest'
import { FRONT_PROXY, PRODUCTION } from './fixtures.js'
import { analyse, suggestValues } from './index.js'

const values = (context: string[], text = FRONT_PROXY) =>
  suggestValues(context, analyse(text).model).map((s) => s.value)

describe('values that come from the config itself', () => {
  test('a route completes to the clusters this config defines', () => {
    expect(values(['static_resources', 'listeners', 'routes', 'route', 'cluster'])).toEqual([
      'api_service',
      'web_service',
    ])
  })

  test('so does a weighted cluster, whose field is spelled like every other name', () => {
    expect(values(['routes', 'route', 'weighted_clusters', 'clusters', 'name'])).toEqual([
      'api_service',
      'web_service',
    ])
  })

  test('and the cluster an xDS stream is opened to', () => {
    expect(values(['dynamic_resources', 'ads_config', 'grpc_services', 'envoy_grpc', 'cluster_name'])).toEqual([
      'api_service',
      'web_service',
    ])
  })

  test('a cluster says where its endpoints come from, since the names alone rarely do', () => {
    const suggestions = suggestValues(['route', 'cluster'], analyse(PRODUCTION).model)
    expect(suggestions).toEqual([
      { value: 'api_service', detail: 'endpoints over EDS' },
      { value: 'api_shadow', detail: '1 endpoint' },
    ])
  })

  test('route config names include the ones written inline', () => {
    expect(values(['rds', 'route_config_name'])).toEqual(['local_route'])
  })
})

describe('enums', () => {
  test('a cluster type is offered under clusters', () => {
    expect(values(['static_resources', 'clusters', 'type'])).toContain('STRICT_DNS')
  })

  test('`type` on its own is not — it is too common a word to answer blind', () => {
    expect(values(['static_resources', 'listeners', 'type'])).toEqual([])
  })

  test('a redirect response code is offered under a redirect', () => {
    expect(values(['routes', 'redirect', 'response_code'])).toContain('TEMPORARY_REDIRECT')
    expect(values(['routes', 'direct_response', 'response_code'])).toEqual([])
  })

  test('camelCase asks the same question as snake_case', () => {
    expect(values(['staticResources', 'listeners', 'trafficDirection'])).toEqual(
      values(['static_resources', 'listeners', 'traffic_direction']),
    )
  })
})

describe('`name`, which means something different in every list it appears in', () => {
  test('an http filter', () => {
    const names = values(['filter_chains', 'filters', 'typed_config', 'http_filters', 'name'])
    expect(names).toContain('envoy.filters.http.router')
    expect(names).not.toContain('envoy.filters.network.tcp_proxy')
  })

  test('a network filter', () => {
    const names = values(['filter_chains', 'filters', 'name'])
    expect(names).toContain('envoy.filters.network.http_connection_manager')
    // The http filter list is checked first for exactly this case: an http filter is also
    // under a `filters` entry, by way of the connection manager between them.
    expect(names).not.toContain('envoy.filters.http.router')
  })

  test('a listener filter', () => {
    expect(values(['listeners', 'listener_filters', 'name'])).toContain(
      'envoy.filters.listener.tls_inspector',
    )
  })

  test('an access logger', () => {
    expect(values(['typed_config', 'access_log', 'name'])).toContain('envoy.access_loggers.file')
  })

  test('and a name in a list nothing knows about is left alone', () => {
    expect(values(['static_resources', 'clusters', 'name'])).toEqual([])
  })
})

describe('the limits it keeps', () => {
  test('a key nobody has an answer for gets no menu rather than a wrong one', () => {
    expect(values(['static_resources', 'listeners', 'stat_prefix'])).toEqual([])
    expect(values([])).toEqual([])
  })

  test('every `@type` offered names the extension it belongs to', () => {
    const suggestions = suggestValues(['typed_config', '@type'], analyse(FRONT_PROXY).model)
    expect(suggestions.length).toBeGreaterThan(10)
    for (const suggestion of suggestions) {
      expect(suggestion.value.startsWith('type.googleapis.com/envoy.')).toBe(true)
      expect(suggestion.detail).toMatch(/^envoy\./)
    }
  })

  test('nothing here offers a FIELD name, which is the one thing it must never do', () => {
    // The whole design constraint, asserted rather than left to a comment. Every key that
    // answers at all answers with values; if a future edit taught one of them to propose
    // field names it would be proposing this package's sixty-field subset as Envoy's schema.
    const model = analyse(PRODUCTION).model
    const fields = ['route_config', 'virtual_hosts', 'connect_timeout', 'lb_policy', 'domains']
    for (const context of [
      ['static_resources', 'clusters', 'type'],
      ['routes', 'route', 'cluster'],
      ['filter_chains', 'filters', 'name'],
      ['typed_config', '@type'],
    ]) {
      const offered = suggestValues(context, model).map((s) => s.value)
      for (const field of fields) expect(offered).not.toContain(field)
    }
  })
})
