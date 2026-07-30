#!/usr/bin/env node
// `npx @attache/cli check envoy.yaml`.
//
// A shim, and nothing else. The command lives in TypeScript under src/ so that its argument
// parsing and every one of its output formats can be unit-tested as functions rather than by
// spawning a process and matching on stdout — which is the difference between a test suite
// that covers the SARIF shape and one that checks the exit code and gives up.
import { run } from '../dist/cli.js'

process.exitCode = await run(process.argv.slice(2))
