import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'

// One test run across every package, in two projects.
//
// The alias is the load-bearing part of the node project. `@attache/core` resolves through
// the workspace symlink to the package's `exports`, which points at dist/ — so without this,
// the app's tests would either fail on a fresh checkout or, worse, quietly pass against a
// stale build. Tests should read the source they are testing.
//
// The BROWSER project exists because a headless DOM cannot answer the questions that have
// actually broken here. Neither jsdom nor happy-dom computes layout: `getBoundingClientRect`
// returns zeros, there is no box model, and no CSS cascade. Four of this app's bugs were
// exactly that shape — a share warning that ran 436px out of its dialogue and took the
// document to a 1806px scroll width, a Tab that walked out of a dialogue into the editor
// behind it, a graph node marked but left off screen, and a header bar that gave the whole
// document a hard 759px minimum width. A suite that goes green while being structurally
// unable to see its own failure mode is worse than no suite, so the tests for those run in
// a real browser.
//
// It is Vite's own dev server driving real Chromium, not a second test runner: the same
// config, the same aliases, the same `npm test`.

export default defineConfig({
  resolve: {
    alias: {
      '@attache/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          // `.browser.test.tsx` cannot match this — the extensions differ — but it is stated
          // rather than relied on, because the day somebody writes a `.browser.test.ts` the
          // failure would be a browser test running in Node with no browser in it.
          include: ['packages/*/src/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.browser.test.*'],
        },
      },
      {
        // The app's own Vite config, so the browser project gets the React plugin, the same
        // core-source alias, and `__APP_VERSION__` — which `App.tsx` reads, and without
        // which it does not render at all.
        extends: './packages/app/vite.config.ts',
        test: {
          name: 'browser',
          include: ['packages/app/src/**/*.browser.test.tsx'],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            // A laptop, not the 414x896 phone Vitest defaults to. Most of the bugs these
            // tests guard were found at a desktop width, and a regression test that
            // reproduces at a size nobody reported is testing a different thing than it
            // claims to. The narrow-screen cases set their own width and put this back.
            viewport: { width: 1280, height: 800 },
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
