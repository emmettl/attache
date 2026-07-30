import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const coreSource = fileURLToPath(new URL('../core/src/index.ts', import.meta.url))

export default defineConfig({
  plugins: [react()],

  // Relative, so ONE build serves every way this ships.
  //
  // GitHub Pages is a project site at /attache/; `npx @attache/app` serves from the root;
  // a copy dropped on any static host could be at either. An absolute base has to pick one
  // and be wrong for the rest, which would mean threading a BASE_PATH through the deploy
  // workflow and a second build for npm.
  //
  // This does NOT affect the Open Graph tags in index.html, which are absolute and
  // hardcoded to the canonical Pages URL on purpose — crawlers cannot resolve a relative
  // og:image.
  base: './',

  resolve: {
    alias: {
      // Point at the core's SOURCE, not its built dist.
      //
      // Without this the workspace symlink resolves @attache/core through its `exports`
      // field to dist/, so every core edit would need a rebuild before the app saw it —
      // no HMR, and a stale dist quietly serving old matching logic is exactly the kind of
      // bug that makes a tool about correctness untrustworthy. Building from source also
      // lets Vite tree-shake across the package boundary.
      //
      // The published core still ships its own dist for outside consumers; this only
      // changes how the app in this repo consumes it.
      '@attache/core': coreSource,
    },
  },
})
