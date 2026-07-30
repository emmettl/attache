/// <reference types="vite/client" />

/**
 * The app's version, substituted at build time by `define` in `vite.config.ts`.
 *
 * A constant rather than an import, because the alternative is reading package.json from
 * application code — which works in the bundler and then does not in any other consumer of
 * that code, and drags the whole manifest into the bundle to get one string out of it.
 */
declare const __APP_VERSION__: string
