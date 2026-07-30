import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// One test run across both packages, from the repo root.
//
// The alias is the load-bearing part. `@attache/core` resolves through the workspace
// symlink to the package's `exports`, which points at dist/ — so without this, the app's
// tests would either fail on a fresh checkout or, worse, quietly pass against a stale
// build. Tests should read the source they are testing.

export default defineConfig({
  resolve: {
    alias: {
      '@attache/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
})
