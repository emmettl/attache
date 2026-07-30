// Configs to open with.
//
// The app loads the first of these on a cold start rather than an empty editor, because a
// tool whose entire value is what it says about a config says nothing at all about an empty
// one — and "paste your production bootstrap to find out what this does" is a poor first
// ask of somebody who has not decided to trust it yet.

export interface Example {
  id: string
  title: string
  /** What this one is here to show. */
  blurb: string
  text: string
}

export const EXAMPLES: Example[] = [
  {
    id: 'front-proxy',
    title: 'Front proxy',
    blurb: 'Two services behind one listener. The shape most Envoy configs start from.',
    text: `# A front proxy: one listener, routed to two upstreams by path.
static_resources:
  listeners:
  - name: ingress
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
    type: STRICT_DNS
    lb_policy: ROUND_ROBIN
    connect_timeout: 0.25s
    load_assignment:
      cluster_name: api_service
      endpoints:
      - lb_endpoints:
        - endpoint: { address: { socket_address: { address: api, port_value: 8080 } } }
  - name: web_service
    type: STRICT_DNS
    lb_policy: ROUND_ROBIN
    connect_timeout: 0.25s
    load_assignment:
      cluster_name: web_service
      endpoints:
      - lb_endpoints:
        - endpoint: { address: { socket_address: { address: web, port_value: 8080 } } }
`,
  },
  {
    id: 'domains',
    title: 'Virtual host precedence',
    blurb:
      'Four virtual hosts that all match www.foo.com. Envoy picks by specificity, not by order — try the route tester.',
    text: `# Every virtual host below could match \`www.foo.com\`.
#
# Envoy does NOT take the first one written. It takes the most specific: an exact name,
# then the longest suffix wildcard, then the longest prefix wildcard, then \`*\`. Moving
# them around in this file changes nothing — try it.
#
# Ask the route tester for www.foo.com, then a.bar.foo.com, then anything.example.
static_resources:
  listeners:
  - name: ingress
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
            - name: catch_all
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: catch_all }
            - name: any_foo
              domains: ["*.foo.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: any_foo }
            - name: any_bar_foo
              domains: ["*.bar.foo.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: any_bar_foo }
            - name: exactly_www
              domains: ["www.foo.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: exactly_www }

  clusters:
  - { name: catch_all, type: STATIC }
  - { name: any_foo, type: STATIC }
  - { name: any_bar_foo, type: STATIC }
  - { name: exactly_www, type: STATIC }
`,
  },
  {
    id: 'trouble',
    title: 'A config with problems',
    blurb:
      'A dangling cluster, a duplicate listener, and a route that can never match. Start on Findings.',
    text: `# Four things are wrong here, and Envoy would only tell you about some of them.
static_resources:
  listeners:
  - name: ingress
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
            - name: everything
              domains: ["*"]
              routes:
              # This one takes every request...
              - match: { prefix: "/" }
                route: { cluster: web_service }
              # ...so this one never runs, and Envoy will not complain.
              - match: { prefix: "/api" }
                route: { cluster: api_service }

  # A second listener with the same name, on the same port.
  - name: ingress
    address:
      socket_address: { address: 0.0.0.0, port_value: 10000 }
    filter_chains: []

  clusters:
  - name: web_service
    type: STATIC
  # Nothing routes here.
  - name: metrics_service
    type: STATIC
`,
  },
]

export const DEFAULT_EXAMPLE = EXAMPLES[0]!
