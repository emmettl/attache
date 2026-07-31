<img src="packages/app/public/logo.svg" width="88" height="88" alt="">

# Attaché

An Envoy config workbench. Give it a bootstrap YAML or an admin port `config_dump` and it
will tell you what is wrong with it, draw what connects to what, and answer the question a
config does not answer by being read: **where does this request actually go?**

**Two ways to run it, over one engine.** The same parser, the same checks, the same route
matching — the difference is what you get back.

A workbench in a browser tab: findings against the source, the graph, and the route tester.

```bash
npx @attache/app
```

Or the hosted copy at <https://emmettl.github.io/attache/>. They are the same build.

A command that fails a build: every finding at once, each pointing at a line, and an exit
code.

```bash
npx @attache/cli check envoy.yaml
npx @attache/cli route envoy.yaml --authority api.example.com --path /v1/users \
  --expect-cluster api_service
```

Neither uploads anything, and neither needs a network or an Envoy binary. That is not a
side effect of how they are built — see [Your config stays put](#your-config-stays-put).

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

**Graph.** The browser tab only — a diagram is not something a build log wants. The
listener → filter chain → route config → virtual host → route → cluster →
endpoint cascade, with dangling references drawn as dashed and orphaned clusters flagged.
A cluster is reached by more than routes, so the edges include the ones that are not: a
`tcp_proxy` chain, an authorization filter, a gRPC access logger, a `request_mirror_policies`
shadow target.

**Route tester.** Give it a method, an authority, a path, headers and an SNI, and it walks
the same cascade Envoy would. It shows the winner at each stage **and every candidate that
lost, with the reason** — because "it went to the wrong place" is almost never a question
about the winner.

> It walks the cascade from the top, which includes the part before the route table. A
> connection manager that sets `merge_slashes` or `strip_matching_host_port` rewrites the
> request before a single route is looked at, so the tester applies those first and says
> which one it applied — `//api//v1` matching `prefix: /api/v1` is bewildering until you are
> told the slashes were merged four fields above the route. In Envoy's order, which is
> `normalize_path` and then `merge_slashes`: on `/a//../b` that is the difference between
> `/a/b` and `/b`, and so between two different routes.

> Ask the *Virtual host precedence* example for `www.foo.com`. Four virtual hosts match it.
> Envoy takes the most specific, not the first written, and moving them around in the file
> changes nothing.

## In CI

`check` reports every finding at once, each pointing at a line, each saying why it matters.
Under GitHub Actions it emits workflow commands by default, so they arrive as annotations on
the diff with nothing to configure; `--format sarif` sends them to the Security tab instead,
and `--format json` is a versioned shape for anything else.

This does not replace `envoy --mode validate`, and [says so](packages/cli). That needs the
Envoy binary, at a version matching production, built for the platform the job runs on, and
it reports the first thing that stopped the boot. This needs Node, reports everything at
once, and catches the whole relational class Envoy is perfectly happy with — the route that
can never match, the cluster nothing reaches, the filter after the router.

And it ends by saying how much of the config it checked, which is the part no validator
tells you. There is no green tick in it either.

`route` is the part a validator structurally cannot do at all — being accepted by Envoy and
still sending `/v1/users` somewhere new are not in tension. It prints every candidate that
lost with the reason, exits non-zero when `--expect-cluster` or `--expect-outcome` breaks,
and — where the answer cannot be certain, as with a weighted split or a `runtime_fraction`
route — says so above the tick rather than letting a green check mean "about half the time".

## What it does not do

Attaché models the listener → filter chain → route → cluster spine, because that is what
decides where a request goes. It does not evaluate access loggers, tracing, circuit
breakers, health checks, or any HTTP filter — those it reads far enough to name and no
further.

**It says so, every time.** Every field it did not check is counted next to the findings,
split into the two things that can mean: *unrecognised*, outside the model altogether, and
*read but not checked* — health checks, circuit breakers, the innards of a filter it has
already named for you. Nothing in the interface ever prints "valid" or shows a green tick,
and there is no code path that could — the most it will say is that it found nothing wrong
*in the part it checked*, with the size of the part it did not check right beside it.

That constraint is structural rather than a matter of discipline. The reader in
`packages/core/src/cursor.ts` records every field the model builder asks for; whatever is
left over at the end **is** the unrecognised list, derived from the code that did the
reading. A field cannot be silently skipped, and a field that gets modelled later cannot be
wrongly reported as unknown, because there is no second list to keep in sync.

Structural is not the same as airtight, and it had one leak: a *scalar* that was fetched and
then dropped appeared in neither list — read, so not unrecognised; never modelled, so not
counted as read-but-not-checked. That is how a header matcher's `ignore_case` came to be
asked for, thrown away, and left out of both totals while the route tester quietly failed to
honour it. An acknowledged scalar is reported now, which is what closed it: a field the
builder went and asked for by name and then declined to judge is exactly the claim the
second list carries.

## Your config stays put

Everything runs in the tab, or on the machine running the command. Nothing is uploaded, and
there is no server to upload it to.

`npx @attache/app` binds to `127.0.0.1` and serves a prebuilt bundle off disk using nothing
but Node built-ins — no runtime dependencies, one small tarball. That route exists because
an Envoy bootstrap usually has a TLS private key a few lines below the part you wanted to
ask about, and "paste it into a website" is a reasonable thing to refuse to do.

**It does keep a copy, and it says so.** The config is saved to this browser's
`localStorage` so a reload does not lose your work — convenient for a scratch config, and
not what you want on a shared machine or in the middle of a screenshare. **Clear** deletes
the editor and that stored copy together, and **Not remembering** turns the saving off for
good and removes whatever is already there. The footer states which of the two you are in,
every time.

**Share links are gated on that.** A config can go in a URL fragment, which never reaches a
server — but a link goes to a *person*, and that is a different guarantee. Attaché scans
for key material first and will not produce a link until it has been replaced with
`"REDACTED"`. The redaction splices the original text by source range rather than
re-serialising, so comments, quoting and indentation survive: what you send is still the
file you recognise.

The scan follows anchors, and it reads every document in the file rather than the first.
Both were leaks: `private_key: *shared` found nothing, because an alias is neither a map nor
a sequence nor a scalar and the walk stepped straight over it — and a key in the second half
of a `---`-separated paste was never looked at, because the *config* is one document while
the *text that travels* is all of them. Neither failed loudly. The config parsed, the warning
never appeared, and the link looked exactly like a clean one.

Which is why the redactor now checks its own work: it re-scans the result and reports whether
every position it found holds the mask, and the app refuses to make a link when that comes
back false. This is the one place in the codebase where being quietly wrong costs somebody a
private key rather than a wrong answer on a screen, so it is the one place that verifies
instead of trusting.

## Three packages

| | |
|---|---|
| [`@attache/core`](packages/core) | Parse, model, check, graph and match. Pure TypeScript, no DOM — enforced by leaving `DOM` out of its `lib`. |
| [`@attache/app`](packages/app) | The React UI, plus the `bin/` that makes `npx` work. |
| [`@attache/cli`](packages/cli) | The same findings in a terminal, and in CI. |

The split is the point, and the CLI is what collects on it: the core is data-in, data-out,
so the command is argument parsing, four output formats and an exit code over the identical
`analyse()` the browser calls. The app bundles the core from source, so an edit hot-reloads
and a stale `dist/` can never quietly serve old matching logic.

## Building it

```bash
npm install
npm run dev
```

```bash
npm run lint && npm run typecheck && npm test && npm run build
```

`npm start` serves the built bundle the way `npx` does.

### Two test projects

`npm test` runs both. Most of the suite is Node — the core, the CLI, and the app's own pure
logic — and `npm run test:node` is that alone, for the inner loop.

The rest runs in **real Chromium**, and needs one setup step:

```bash
npx playwright install chromium
```

That project exists because a headless DOM cannot see the bugs this app actually had.
Neither `jsdom` nor `happy-dom` computes layout: `getBoundingClientRect` returns zeros, there
is no box model, and no CSS cascade. Four of the app's shipped bugs were exactly that shape
— a share warning that ran 436px out of its dialogue and took the document to an 1806px
scroll width, a Tab that walked out of a dialogue into the editor behind it, a graph node
marked but left off screen, and a header bar whose two halves both refused to shrink, giving
the whole document a hard 759px minimum and every phone a sideways scrollbar. A suite that
goes green while being structurally unable to see its own failure mode is worse than no
suite.

The narrow-screen tests carry that argument one level further: each asserts that nothing
overflows a window of a given width, which is *also* true of a window that was never
resized. So they check `window.innerWidth` first. A `page.viewport()` that quietly did
nothing would otherwise leave three green tests measuring the 1280px default — the same
failure, one layer up.

It is Vite's own dev server driving Chromium rather than a second test runner: the same
config, the same aliases, the same `npm test`.

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
split, a `cluster_header` route, and a filter chain matching on IP ranges or on ALPN each
produce a stated caveat instead of a confident wrong answer — and so does a route matching
on `runtime_fraction`, `grpc` or `tls_context`, none of which can be settled from a method,
an authority and a path. A route carrying one still wins where Envoy would let it win; what
it does not do is come back as a settled answer.

The rule those all follow: a criterion that is read and not evaluated must reach the verdict
as a sentence. The failure it exists to stop is not a crash but a silent disagreement — a
chain naming `h2` outranked a chain naming nothing and won, correctly, for a client that had
never said what it spoke, and the answer was presented as the answer for every client.

## Licence

MIT.
