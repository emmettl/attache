# Attaché

An Envoy config workbench that runs in a browser tab. Paste a bootstrap YAML or an admin
port `config_dump` and it will tell you what is wrong with it, draw what connects to what,
and answer the question a config does not answer by being read: **where does this request
actually go?**

```bash
npx @attache/app
```

Or use the hosted copy at <https://emmettl.github.io/attache/>. They are the same build.

## Why it exists

An Envoy config is a tree in the file and a graph in reality. A route names a cluster in a
string; a filter chain names a route configuration in a string; the two ends of that
reference can sit four hundred lines apart with nothing linking them but the names
matching. Envoy will reject some mistakes at boot and be perfectly happy with the rest —
and it is the rest that costs you an evening:

- A route below a broader one, which can never match. Envoy boots fine.
- A virtual host you assumed was picked by declaration order. It is not.
- A cluster nothing routes to, and a route pointing at a cluster that is not there.

Attaché answers those without running Envoy, without a network, and without your config
leaving the machine.

## The three things it does

**Findings.** Syntax errors, structural problems, and everything relational — dangling
cluster references, duplicate names, two listeners on one port, routes that can never
match. Each one points at a line.

**Graph.** The listener → filter chain → route config → virtual host → route → cluster →
endpoint cascade, with dangling references drawn as dashed and orphaned clusters flagged.

**Route tester.** Give it a method, an authority, a path, headers and an SNI, and it walks
the same cascade Envoy would. It shows the winner at each stage **and every candidate that
lost, with the reason** — because "it went to the wrong place" is almost never a question
about the winner.

> Ask the *Virtual host precedence* example for `www.foo.com`. Four virtual hosts match it.
> Envoy takes the most specific, not the first written, and moving them around in the file
> changes nothing.

## What it does not do

Attaché models the listener → filter chain → route → cluster spine, because that is what
decides where a request goes. It does not model access loggers, tracing, circuit breakers,
health checks, or most HTTP filters.

**It says so, every time.** Every field outside the model is reported as unrecognised and
counted next to the findings. Nothing in the interface ever prints "valid" or shows a green
tick, and there is no code path that could — the most it will say is that it found nothing
wrong *in the part it checked*, with the size of the part it did not check right beside it.

That constraint is structural rather than a matter of discipline. The reader in
`packages/core/src/cursor.ts` records every field the model builder asks for; whatever is
left over at the end **is** the unrecognised list, derived from the code that did the
reading. A field cannot be silently skipped, and a field that gets modelled later cannot be
wrongly reported as unknown, because there is no second list to keep in sync.

## Your config stays put

Everything runs in the tab. Nothing is uploaded, and there is no server to upload it to.

`npx @attache/app` binds to `127.0.0.1` and serves a prebuilt bundle off disk using nothing
but Node built-ins — no runtime dependencies, one small tarball. That route exists because
an Envoy bootstrap usually has a TLS private key a few lines below the part you wanted to
ask about, and "paste it into a website" is a reasonable thing to refuse to do.

**Share links are gated on that.** A config can go in a URL fragment, which never reaches a
server — but a link goes to a *person*, and that is a different guarantee. Attaché scans
for key material first and will not produce a link until it has been replaced with
`"REDACTED"`. The redaction splices the original text by source range rather than
re-serialising, so comments, quoting and indentation survive: what you send is still the
file you recognise.

## Two packages

| | |
|---|---|
| [`@attache/core`](packages/core) | Parse, model, check, graph and match. Pure TypeScript, no DOM — enforced by leaving `DOM` out of its `lib`. |
| [`@attache/app`](packages/app) | The React UI, plus the `bin/` that makes `npx` work. |

The split is the point: the core is data-in, data-out, so a CLI or a CI check could embed
it without a browser. The app bundles it from source, so an edit hot-reloads and a stale
`dist/` can never quietly serve old matching logic.

## Building it

```bash
npm install
npm run dev
```

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`npm start` serves the built bundle the way `npx` does.

### One build, every destination

`packages/app/vite.config.ts` sets `base: './'`, so a single `dist/` serves the Pages
project site at `/attache/`, the `npx` server at `/`, and any other static host. Verified
by serving one `dist/` at both roots simultaneously and confirming they are identical with
no console errors — the check that catches a broken Pages deploy before it is deployed.

## Accuracy

Route matching is where being subtly wrong would matter most, so that is where the tests
concentrate: virtual host domain precedence as a table, route ordering, filter chain
selection by SNI specificity, and both the modern and deprecated header matcher spellings —
configs in the wild use both, and reading only one would silently ignore half the matchers
in a real config.

Where the tester cannot know the answer it says so rather than guessing. A weighted cluster
split, a `cluster_header` route, and a filter chain matching on IP ranges each produce a
stated caveat instead of a confident wrong answer.

## Licence

MIT.
