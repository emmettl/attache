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

## Usage

```
attache check <file...> [options]
cat envoy.yaml | attache check -
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

## The rest of Attaché

[`@attache/app`](https://www.npmjs.com/package/@attache/app) is the same checks in a browser
tab, plus a graph of what connects to what and a route tester that walks the cascade Envoy
would and shows every candidate that lost, with the reason. `npx @attache/app`.

[`@attache/core`](https://www.npmjs.com/package/@attache/core) is the library underneath
both — data in, data out, no DOM.

MIT.
