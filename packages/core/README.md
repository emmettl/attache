# @attache/core

Parse, check and reason about Envoy proxy configuration. No Envoy, no network, no DOM.

```bash
npm install @attache/core
```

```ts
import { analyse, matchRequest, buildGraph } from '@attache/core'

const { model, diagnostics, unknowns, summary } = analyse(yamlText)

for (const d of diagnostics) {
  console.log(`${d.severity} at line ${d.range.line}: ${d.message}`)
}

const result = matchRequest(model, {
  authority: 'www.foo.com',
  path: '/api/users',
  method: 'GET',
  port: 10000,
  headers: {},
})

console.log(result.explanation) // Matched route 1 of `backend` → cluster `api_service`.
for (const attempt of result.routeAttempts.filter((a) => !a.matched)) {
  console.log(`  lost: ${attempt.reason}`)
}
```

## What is in here

| | |
|---|---|
| `analyse(text)` | The whole pipeline. Accepts bootstrap YAML, JSON, or an admin `/config_dump`. |
| `matchRequest(model, request)` | The routing cascade, with every rejected candidate and why. |
| `buildGraph(model)` | Nodes and edges, with dangling references and orphaned clusters marked. |
| `findSecrets(text)` / `redact(text)` | Locate and mask key material before a config travels. |
| `parse` / `buildModel` / `validate` | The stages, if you want them separately. |

Everything modelled carries a `path` and a `range`, so a consumer can point at the line a
finding came from.

## The subset, and saying so

This models the listener → filter chain → route → cluster spine — what decides where a
request goes. It does not model access loggers, tracing, circuit breakers, health checks or
most HTTP filters.

`analyse` returns `unknowns` alongside `diagnostics`: every field outside the model, at the
shallowest point it occurs. **Do not drop that array.** A checker covering a subset of
Envoy's schema is only honest if the size of the part it did not check travels with its
findings, and `summarise()` deliberately has no success state for the same reason — the
most it will say is "nothing wrong in what I checked", with the unchecked count beside it.

The mechanism is in `src/cursor.ts`. The model builder reads through a cursor that records
every field asked for; the leftovers *are* the unknown list. There is no hand-maintained set
of known field names to fall out of sync with the code.

## Accepted spellings

Envoy accepts `port_value` and `portValue` and means the same by both — hand-written
bootstraps use snake_case, proto JSON uses lowerCamelCase. Both are read. The model is
camelCase throughout; the spelling you actually wrote survives in diagnostics.

Header matchers are read in both the modern `string_match` form and the deprecated flat one
(`exact_match`, `prefix_match`, …), because configs in the wild carry both.

## Where it will not guess

`matchRequest` returns `caveats`. It is non-empty when the answer is a best effort:

- a weighted cluster split, where the upstream is chosen per request
- a `cluster_header` route, where the upstream is not in the config at all
- a filter chain matching on source or destination IP ranges, which this does not evaluate

Treat a non-empty `caveats` as "show this to the user", not as detail.

## Types

`ES2023`, ESM, no `DOM` in `lib` — deliberately, so nothing in here can reach for a browser
global. One dependency, `yaml`, for the CST: diagnostics have to point at lines, which rules
out any parser that hands back plain objects.

## Licence

MIT.
