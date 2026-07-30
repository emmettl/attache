# @attache/app

An Envoy config workbench in a browser tab.

```bash
npx @attache/app
```

Opens on `http://127.0.0.1:4173`. Paste a bootstrap YAML or an admin `/config_dump` and get:

- **Findings** — syntax, structure, dangling cluster references, duplicate names, two
  listeners on one port, routes that can never match. Each points at a line.
- **Graph** — listener → filter chain → route config → virtual host → route → cluster →
  endpoint, with dangling references dashed and orphaned clusters flagged.
- **Route tester** — a request in, and the route it takes out, with every candidate that
  lost at each stage and the reason it lost.

## Options

```
-p, --port <number>   Port to listen on (default 4173, or $PORT)
    --host <address>  Address to bind (default 127.0.0.1)
    --no-open         Do not open a browser
-h, --help            Show this
```

## Why `npx` and not just the website

Both exist and are the same build — the hosted copy is at
<https://emmettl.github.io/attache/>.

But an Envoy bootstrap usually has a TLS private key a few lines below the part you wanted
to ask about, and "paste your production config into a website" is a reasonable thing to
refuse to do. This binds to loopback and serves a prebuilt bundle off disk using nothing but
Node built-ins. There are no runtime dependencies: `npx` fetches one small tarball and runs,
rather than resolving an install tree first.

Nothing is uploaded in either case — there is no server to upload to, and the whole analysis
runs in the tab. The difference is only how much you have to take on trust.

Share links are gated on the same concern. A config in a URL fragment never reaches a
server, but the link goes to a person; the app scans for key material and will not produce a
link until it has been replaced with `"REDACTED"`.

## Building from a checkout

```bash
npm install
npm run dev      # Vite dev server, with the core aliased to its source
npm run build
npm start        # serve the built bundle the way npx does
```

The analysis lives in [`@attache/core`](https://www.npmjs.com/package/@attache/core), which
is a plain TypeScript library with no DOM dependency if you want it without the UI.

## Licence

MIT.
