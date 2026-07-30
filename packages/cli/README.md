# `@attache/cli`

Check an Envoy config from the command line, and from CI.

```bash
npx @attache/cli check envoy.yaml
```

```
error[cluster-not-found]: No cluster named `ghost_service`.
   --> envoy.yaml:20:17
    │
 20 │               - match: { prefix: "/api" }
    │                 ^^^^^^
    = Envoy rejects a config whose route names a cluster that is not defined. Nothing in
      this config says the cluster is delivered over CDS, so as written the reference
      goes nowhere.
    = at static_resources.listeners[0]…route_config.virtual_hosts[0].routes[1]
    = RouteAction.cluster — https://www.envoyproxy.io/docs/envoy/latest/api-v3/…

envoy.yaml (bootstrap) — 2 errors, 2 warnings · nothing unrecognised
```

## Why not `envoy --mode validate`

Use both. They answer different questions.

`envoy --mode validate` boots the real proxy against your file, which is the only thing that
can tell you the real proxy accepts it. It also needs the Envoy binary, at a version that
matches production, for the platform your job runs on — and what it gives back is the first
thing that stopped the boot, once, with a proto path rather than a line.

This needs Node. It reports every finding at once, points each one at a line, says *why* it
matters, and links the reference page. And it catches the class Envoy has no opinion about,
because a config can be perfectly valid and still be wrong:

- a route below a broader one, which can never match
- a virtual host you assumed was picked by declaration order — it is not
- a cluster nothing reaches, and a route naming a cluster that is not there
- two listeners on one port, an HTTP filter after the router, SNI matching on a chain that
  never terminates TLS

## It tells you what it did not check

Every run ends with a count of the fields Attaché read past, split into *unrecognised* —
outside the model altogether — and *read but not checked*, which is health checks, circuit
breakers, and the innards of filters it has named for you.

Nothing here prints "valid" or a green tick, and there is no code path that could. The most
it will say is that it found nothing wrong **in the part it checked**, with the size of the
part it did not check sitting next to it. `--show-unchecked` lists them rather than counting.

It is not a substitute for booting Envoy against the file.

## Assert where a request goes

The other half, and the one a validator structurally cannot do. `envoy --mode validate`
tells you Envoy will accept the file. It cannot tell you the file still sends `/v1/users` to
`api_service`, because answering that means walking the cascade rather than checking the
schema — and a config stays perfectly valid through the edit that quietly moves a route
below a broader one.

```bash
attache route envoy.yaml --authority api.example.com --path /v1/users \
  --expect-cluster api_service
```

```
GET api.example.com/v1/users
Matched route 2 (`v1`) of `api` → cluster `api_service`.

listener
  ✓ ingress 0.0.0.0:8080
filter chain
  ✓ chain 1
virtual host
  ✓ api api.example.com
  · catchall * — `api.example.com` on `api` is more specific than `*`
route
  · health path /healthz — the path is not exactly `/healthz`
  ✓ v1 prefix /v1

✓ cluster api_service, as expected
```

Every candidate that lost is there with the reason, because "it went to the wrong place" is
almost never a question about the winner.

`--expect-outcome` asserts the shape of the answer rather than the upstream, which is how you
guard a path that is *supposed* to 404:

```bash
attache route envoy.yaml --authority api.example.com --path /admin \
  --expect-outcome no-route
```

With no `--expect-*` it is a question rather than a test: it prints where the request goes
and exits 0 however that turned out. A 404 is an answer.

**Where it cannot be sure, it says so and the assertion says so too.** A weighted split, a
cluster taken from a header, a route matching on `runtime_fraction`, a chain matching on IP
ranges — an expectation that holds against any of those prints its caveats *above* the tick,
and under GitHub Actions raises a warning on the diff, so a green check never quietly means
"about half the time".

| | |
|---|---|
| `--authority <host>` | The `:authority` header. Required. |
| `--path </p>` | Default `/` |
| `--method <verb>` | Default `GET` |
| `--port <n>` | Only needed when the config has more than one listener. |
| `--sni <name>` | For chain selection on a TLS listener. |
| `-H, --header <n: v>` | Repeatable. Split on the first colon. |
| `--expect-cluster <name>` | Fail unless the request reaches this cluster. |
| `--expect-outcome <name>` | `matched`, `no-route`, `no-virtual-host`, `tcp-proxy`, … |

## Usage

```
attache check <file...> [options]
cat envoy.yaml | attache check -
attache route <file> --authority <host> [options]
```

Bootstraps and admin-port `/config_dump`s both work. Nothing is uploaded: this runs in your
process, with no network.

| | |
|---|---|
| `--format <name>` | `human`, `github`, `json` or `sarif`. Defaults to `github` under GitHub Actions, otherwise `human`. |
| `--fail-on <sev>` | `error`, `warning`, `info` or `never`. Default `error`. |
| `--show-unchecked` | List the fields Attaché did not check, not only how many. |
| `--no-color` | Plain text. `NO_COLOR` and not being a terminal are honoured too. |
| `--width <n>` | Where to wrap prose. Default: the terminal, or 100. |
| `-q, --quiet` | Only what fails the threshold. |

Exit `0` when nothing meets `--fail-on`, `1` when something does, `2` when the command or a
file could not be read.

## In CI

Under GitHub Actions it defaults to workflow commands, so findings arrive as annotations on
the diff with no configuration:

```yaml
- run: npx @attache/cli check envoy.yaml
```

For the Security tab, upload SARIF instead — that turns each finding into an alert with a
history, so "this listener has had no router filter for four months" becomes answerable:

```yaml
- run: npx @attache/cli check envoy.yaml --format sarif > attache.sarif
  continue-on-error: true
- uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: attache.sarif
```

Anywhere else, `--format json` is a versioned shape (`schema: attache-findings-1`) carrying
every finding with its line, its config path, its documentation URL, and the unchecked counts.
`attache route --format json` is `attache-route-1` alongside it, with the full cascade.

Route assertions are ordinary shell, so a table of them is a table:

```yaml
- name: Routes still go where we think
  run: |
    set -e
    attache() { npx @attache/cli route envoy.yaml --authority "$1" --path "$2" "${@:3}"; }
    attache api.example.com /v1/users  --expect-cluster api_service
    attache api.example.com /healthz   --expect-outcome matched
    attache api.example.com /admin     --expect-outcome no-route
    attache www.example.com /          --expect-cluster web_service
```

Each run re-reads the config, which for a file this size is a few milliseconds — cheaper
than inventing a test-file format for it.

## The rest of Attaché

[`@attache/app`](https://www.npmjs.com/package/@attache/app) is the same checks in a browser
tab, plus a graph of what connects to what and a route tester that walks the cascade Envoy
would and shows every candidate that lost, with the reason. `npx @attache/app`.

[`@attache/core`](https://www.npmjs.com/package/@attache/core) is the library underneath
both — data in, data out, no DOM.

MIT.
