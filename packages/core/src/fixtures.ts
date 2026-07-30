// Configs the tests read. Kept as text rather than as built models on purpose: the parse
// and the field-name normalisation are as much of what is under test as the modelling, and
// a fixture that skipped them would test half the pipeline against itself.

/** A front proxy in the shape Envoy's own examples use. */
export const FRONT_PROXY = `
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          route_config:
            name: local_route
            virtual_hosts:
            - name: backend
              domains: ["*"]
              routes:
              - match: { prefix: "/api" }
                route: { cluster: api_service }
              - match: { prefix: "/" }
                route: { cluster: web_service }
          http_filters:
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
  - name: api_service
    connect_timeout: 0.25s
    type: STRICT_DNS
    lb_policy: ROUND_ROBIN
    load_assignment:
      cluster_name: api_service
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address: { address: api, port_value: 8080 }
  - name: web_service
    connect_timeout: 0.25s
    type: STRICT_DNS
    load_assignment:
      cluster_name: web_service
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address: { address: web, port_value: 8080 }
`

/** The same listener, written in the lowerCamelCase that proto JSON emits. */
export const CAMEL_CASE = `
staticResources:
  listeners:
  - name: listener_0
    address:
      socketAddress: { address: 0.0.0.0, portValue: 10000 }
    filterChains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typedConfig:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          statPrefix: ingress_http
          routeConfig:
            name: local_route
            virtualHosts:
            - name: backend
              domains: ["*"]
              routes:
              - match: { prefix: "/api" }
                route: { cluster: api_service }
  clusters:
  - name: api_service
    type: STRICT_DNS
`

/** Names that refer to nothing, names claimed twice, and a route that can never match. */
export const TROUBLE = `
static_resources:
  listeners:
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress
          route_config:
            name: local_route
            virtual_hosts:
            - name: everything
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: web_service }
              - match: { prefix: "/api" }
                route: { cluster: ghost_service }
  - name: listener_0
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains: []
  clusters:
  - name: web_service
    type: STATIC
  - name: nobody_calls_me
    type: STATIC
`

/**
 * The shape a config takes once it has been in production for a while.
 *
 * Every hand-written fixture above is an Envoy example, and Envoy's examples are the reason
 * the unrecognised list looked healthy for so long: they carry a listener, a route and a
 * cluster and almost nothing else. A real one has timeouts and retries and health checks and
 * an access log and an authorization filter that one route turns off, and it was a config
 * like this — reported as fifty fields Attaché did not understand, about half of them
 * ordinary — that made the split between unrecognised and unvalidated necessary.
 *
 * So this exists to be the config the coverage is measured against, and to fail loudly if
 * any of it stops being read.
 */
export const PRODUCTION = `
node:
  id: sidecar~10.0.1.7~api-7f9c
  cluster: api

admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 15000 }

dynamic_resources:
  cds_config:
    ads: {}
  ads_config:
    api_type: GRPC
    grpc_services:
    - envoy_grpc: { cluster_name: xds_cluster }

static_resources:
  listeners:
  - name: virtual_inbound
    traffic_direction: INBOUND
    per_connection_buffer_limit_bytes: 32768
    address:
      socket_address: { address: 0.0.0.0, port_value: 15006 }
    listener_filters:
    - name: envoy.filters.listener.tls_inspector
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.filters.listener.tls_inspector.v3.TlsInspector
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: inbound_http
          codec_type: AUTO
          use_remote_address: false
          add_user_agent: true
          server_header_transformation: PASS_THROUGH
          stream_idle_timeout: 300s
          request_timeout: 0s
          common_http_protocol_options:
            idle_timeout: 3600s
            headers_with_underscores_action: REJECT_REQUEST
          http_protocol_options:
            accept_http_10: true
            default_host_for_http_10: legacy.internal
          http2_protocol_options:
            max_concurrent_streams: 100
            allow_connect: true
          internal_address_config:
            unix_sockets: true
            cidr_ranges:
            - { address_prefix: 10.0.0.0, prefix_len: 8 }
          access_log:
          - name: envoy.access_loggers.file
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.file.v3.FileAccessLog
              path: /dev/stdout
          upgrade_configs:
          - upgrade_type: websocket
          - upgrade_type: CONNECT
            enabled: false
          route_config:
            name: inbound_routes
            virtual_hosts:
            - name: api
              domains: ["*"]
              routes:
              - name: health
                match: { path: /healthz }
                direct_response:
                  status: 200
                  body: { inline_string: "OK" }
                typed_per_filter_config:
                  envoy.filters.http.ext_authz:
                    "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthzPerRoute
                    disabled: true
              - name: legacy
                match: { prefix: /v1 }
                redirect:
                  host_redirect: api.example.com
                  prefix_rewrite: /v2
                  https_redirect: true
                  response_code: TEMPORARY_REDIRECT
              - name: api
                match: { prefix: / }
                route:
                  cluster: api_service
                  timeout: 15s
                  prefix_rewrite: /
                  host_rewrite_literal: api.internal
                  retry_policy:
                    retry_on: 5xx,reset
                    num_retries: 3
          http_filters:
          - name: envoy.filters.http.ext_authz
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.ext_authz.v3.ExtAuthz
              transport_api_version: V3
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
  clusters:
  - name: api_service
    type: EDS
    connect_timeout: 0.25s
    eds_cluster_config:
      eds_config: { ads: {} }
      service_name: api|8080
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config:
          http2_protocol_options: {}
    health_checks:
    - timeout: 1s
      interval: 5s
      unhealthy_threshold: 3
      healthy_threshold: 1
      http_health_check: { path: /healthz }
    circuit_breakers:
      thresholds:
      - priority: DEFAULT
        max_connections: 1024
        max_pending_requests: 1024
    outlier_detection:
      consecutive_5xx: 5
      interval: 10s
`

/** An admin port dump, in the envelopes Envoy wraps its resources in. */
export const CONFIG_DUMP = JSON.stringify({
  configs: [
    {
      '@type': 'type.googleapis.com/envoy.admin.v3.ListenersConfigDump',
      static_listeners: [
        {
          listener: {
            name: 'listener_0',
            address: { socket_address: { address: '0.0.0.0', port_value: 10000 } },
            filter_chains: [
              {
                filters: [
                  {
                    name: 'envoy.filters.network.http_connection_manager',
                    typed_config: {
                      '@type':
                        'type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager',
                      stat_prefix: 'ingress_http',
                      rds: { route_config_name: 'local_route' },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    },
    {
      '@type': 'type.googleapis.com/envoy.admin.v3.ClustersConfigDump',
      dynamic_active_clusters: [{ cluster: { name: 'api_service', type: 'EDS' } }],
    },
    {
      '@type': 'type.googleapis.com/envoy.admin.v3.RoutesConfigDump',
      dynamic_route_configs: [
        {
          route_config: {
            name: 'local_route',
            virtual_hosts: [
              {
                name: 'backend',
                domains: ['*'],
                routes: [{ match: { prefix: '/' }, route: { cluster: 'api_service' } }],
              },
            ],
          },
        },
      ],
    },
  ],
})
