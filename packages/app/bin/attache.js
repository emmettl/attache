#!/usr/bin/env node
// `npx @attache/app` — serve the built app and open it.
//
// Node built-ins only, on purpose. What ships is a prebuilt bundle, so this needs no
// framework and no server library, and the package therefore has no runtime dependencies
// at all: npx fetches one small tarball and runs. Adding express here would mean every
// user waits for an install tree to resolve before they can look at a config.
//
// This route matters more than the hosted one. Attaché is for reading configs, and an
// Envoy bootstrap usually has a TLS private key a few lines below the bit you wanted to
// ask about. "Paste it into a website" is a reasonable thing to refuse to do; `npx` is the
// answer to that, and it only works if the command is genuinely one command.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

function parseArgs(argv) {
  const args = { port: Number(process.env.PORT) || 4173, open: true, host: '127.0.0.1' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' || arg === '-p') args.port = Number(argv[++i])
    else if (arg === '--host') args.host = argv[++i] ?? '0.0.0.0'
    else if (arg === '--no-open') args.open = false
    else if (arg === '--help' || arg === '-h') args.help = true
  }
  return args
}

const HELP = `
  attache — an Envoy config workbench in the browser

  Usage
    npx @attache/app [options]

  Options
    -p, --port <number>   Port to listen on (default 4173, or $PORT)
        --host <address>  Address to bind (default 127.0.0.1)
        --no-open         Do not open a browser
    -h, --help            Show this

  Bound to 127.0.0.1 unless you say otherwise, and nothing is uploaded: the config you
  paste in stays in the browser tab. That is the point of running it this way.
`

function openBrowser(url) {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    // Detached and ignored: if there is no browser to open — a container, a headless box,
    // an SSH session — that is not a reason to take the server down with it.
    spawn(command, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
      .on('error', () => {})
      .unref()
  } catch {
    // The URL is printed either way; opening it is a convenience, not the feature.
  }
}

async function send(res, path, status = 200) {
  const body = await readFile(path)
  res.writeHead(status, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'content-length': body.length,
    // Served from disk and rebuilt by reinstalling, so caching only makes a stale copy
    // harder to get rid of.
    'cache-control': 'no-cache',
  })
  res.end(body)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  process.stdout.write(HELP)
  process.exit(0)
}

try {
  await stat(join(ROOT, 'index.html'))
} catch {
  process.stderr.write(
    `attache: no built app found at ${ROOT}\n` +
      `If you are running from a checkout, build it first: npm run build\n`,
  )
  process.exit(1)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    // normalize collapses `..` before it is joined, so a request for /../../etc/passwd
    // cannot climb out of dist.
    const path = normalize(decodeURIComponent(url.pathname))
    const target = join(ROOT, path)
    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const info = await stat(target).catch(() => null)
    if (info?.isFile()) return await send(res, target)
    if (path === '/') return await send(res, join(ROOT, 'index.html'))

    // Anything else redirects to the root rather than being served the app inline.
    //
    // Serving index.html here is the reflex, and it is wrong for this build: assets are
    // referenced relatively (`./assets/…`, so one dist/ works from both the Pages subpath
    // and the root), which means index.html served at /some/path sends the browser looking
    // for /some/assets/… — a miss, another index.html, and a page that loads and then dies
    // on a MIME type error. A redirect puts the app at the depth its own relative paths
    // were built for.
    //
    // Nothing is lost: Attaché has no routes. The only meaningful URL is `/`, and a shared
    // config lives in the fragment, which the browser reapplies across a redirect because
    // it is never sent to the server in the first place.
    res.writeHead(302, { location: '/' })
    return res.end()
  } catch {
    res.writeHead(500).end('Internal error')
  }
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    process.stderr.write(
      `attache: port ${args.port} is already in use. Try: npx @attache/app --port ${args.port + 1}\n`,
    )
    process.exit(1)
  }
  throw error
})

server.listen(args.port, args.host, () => {
  const url = `http://${args.host === '0.0.0.0' ? 'localhost' : args.host}:${args.port}/`
  process.stdout.write(`\n  attache  ${url}\n  press ctrl-c to stop\n\n`)
  if (args.open) openBrowser(url)
})
