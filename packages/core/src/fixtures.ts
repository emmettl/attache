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
