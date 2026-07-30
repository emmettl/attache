import { readFile } from 'node:fs/promises'
import { analyse, matchRequest, type Outcome, type TestRequest } from '@attache/core'
import {
  exitCode,
  render,
  type Checked,
  type FailOn,
  type Format,
  type ReportOptions,
} from './report.js'
import { renderRoute, routeExitCode, type Expectation } from './route.js'

// The command. Everything that touches the outside world lives here, and nothing that
// decides what a finding looks like does — see `report.ts`.
//
// What this is FOR, given `envoy --mode validate` exists: that needs the Envoy binary, of
// the right version, for the platform the job runs on, and what it gives back is a boot
// error, singular, about the first thing that stopped it. This needs Node. It reports every
// finding at once rather than the first, it points at a line, it says why the finding
// matters, and it catches the whole relational class Envoy is perfectly happy with — a route
// below a broader one, a cluster nothing reaches, two listeners on one port. It also says
// what it did not check, which is the part no validator tells you.
//
// It is emphatically NOT a replacement for booting Envoy against the config. It says so in
// the help text, because a CI check that quietly implies more coverage than it has is worse
// than no CI check.

const HELP = `
  attache — check an Envoy config from the command line

  Usage
    npx @attache/cli check <file...> [options]
    cat envoy.yaml | npx @attache/cli check -
    npx @attache/cli route <file> --authority <host> --path </p> [options]

  Options
        --format <name>   human, github, json or sarif.
                          Defaults to github under GitHub Actions, otherwise human.
        --fail-on <sev>   error, warning, info or never. Default error.
        --show-unchecked  List the fields Attaché did not check, not only how many.
        --no-color        Plain text. Also honoured: NO_COLOR, and not being a terminal.
        --width <n>       Where to wrap prose. Default: the terminal, or 100.
    -q, --quiet           Only what fails the threshold.
    -h, --help            Show this
    -v, --version         Show the version

  Exit codes
    0  nothing at or above --fail-on
    1  findings at or above --fail-on
    2  the command or a file could not be read

  Bootstraps and admin-port config dumps both work, and neither is uploaded anywhere: this
  runs entirely in your process, with no network and no Envoy binary.

  It checks the listener → filter chain → route → cluster spine, and it tells you how much
  of your config that was. It is not a substitute for booting Envoy against the file.
`

const ROUTE_HELP = `
  attache route — where does this request actually go?

  Usage
    npx @attache/cli route <file> --authority <host> [options]

  The request
        --authority <host>  The :authority header. Required.
        --path </p>         Default /
        --method <verb>     Default GET
        --port <n>          The port the connection arrived on. Only needed when the
                            config has more than one listener.
        --sni <name>        Server name, for chain selection on a TLS listener.
    -H, --header <n: v>     Repeatable.

  The assertion
        --expect-cluster <name>    Fail unless the request reaches this cluster.
        --expect-outcome <name>    Fail unless the cascade ends this way. One of:
                                   matched, no-listener, no-filter-chain, tcp-proxy,
                                   not-http, routes-elsewhere, no-virtual-host, no-route.

  Options
        --format <name>   human, github or json. github under GitHub Actions.
        --no-color        Plain text. NO_COLOR and not being a terminal count too.
    -q, --quiet           The verdict without the losing candidates.

  Exit codes
    0  no expectation was broken — including when you asked for none
    1  an expectation was broken
    2  the command or the file could not be read

  With no --expect-*, this is a question rather than a test: it prints where the request
  goes and exits 0 however that turned out. A 404 is an answer.

  It shows every candidate that lost and why, because "it went to the wrong place" is
  almost never a question about the winner. Where it cannot know — a weighted split, a
  cluster taken from a header, a chain matching on IP ranges — it says so instead of
  guessing, and an expectation that passes alongside a caveat says that too.
`

const FORMATS = new Set<Format>(['human', 'github', 'json', 'sarif'])
const SEVERITIES = new Set<FailOn>(['error', 'warning', 'info', 'never'])

interface Args {
  files: string[]
  help: boolean
  version: boolean
  format?: Format
  failOn: FailOn
  colour?: boolean
  quiet: boolean
  showUnchecked: boolean
  width?: number
  /** Set when the arguments themselves were wrong. */
  error?: string
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    files: [],
    help: false,
    version: false,
    failOn: 'error',
    quiet: false,
    showUnchecked: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    // `check` is the only verb there is, so it is accepted and ignored rather than required.
    // `attache envoy.yaml` and `attache check envoy.yaml` both being the obvious spelling is
    // a good enough reason to take both, and reserving the word now means a second verb can
    // arrive later without the first invocation becoming ambiguous.
    //
    // Position zero only. Keyed on "no files yet" it also swallowed the second `check` in
    // `attache check check`, which is a file somebody can have.
    if (i === 0 && arg === 'check') continue

    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--version' || arg === '-v') args.version = true
    else if (arg === '--quiet' || arg === '-q') args.quiet = true
    else if (arg === '--show-unchecked') args.showUnchecked = true
    else if (arg === '--no-color' || arg === '--no-colour') args.colour = false
    else if (arg === '--color' || arg === '--colour') args.colour = true
    else if (arg === '--format') {
      const value = argv[++i]
      if (value === undefined || !FORMATS.has(value as Format)) {
        args.error = `--format takes one of ${[...FORMATS].join(', ')}${value === undefined ? '' : ` — got \`${value}\``}.`
      } else {
        args.format = value as Format
      }
    } else if (arg === '--fail-on') {
      const value = argv[++i]
      if (value === undefined || !SEVERITIES.has(value as FailOn)) {
        args.error = `--fail-on takes one of ${[...SEVERITIES].join(', ')}${value === undefined ? '' : ` — got \`${value}\``}.`
      } else {
        args.failOn = value as FailOn
      }
    } else if (arg === '--width') {
      const value = Number(argv[++i])
      if (!Number.isFinite(value) || value < 40) args.error = '--width takes a number of at least 40.'
      else args.width = value
    } else if (arg.startsWith('-') && arg !== '-') {
      args.error = `Unknown option \`${arg}\`.`
    } else {
      args.files.push(arg)
    }
  }

  return args
}

const OUTCOMES = new Set<Outcome>([
  'matched',
  'no-listener',
  'no-filter-chain',
  'tcp-proxy',
  'not-http',
  'routes-elsewhere',
  'no-virtual-host',
  'no-route',
])

export interface RouteArgs {
  file?: string
  request: TestRequest
  expect: Expectation
  help: boolean
  format?: 'human' | 'github' | 'json'
  colour?: boolean
  quiet: boolean
  error?: string
}

export function parseRouteArgs(argv: readonly string[]): RouteArgs {
  const args: RouteArgs = {
    request: { authority: '', path: '/', method: 'GET', headers: {} },
    expect: {},
    help: false,
    quiet: false,
  }

  const value = (i: number, flag: string): string | undefined => {
    const found = argv[i]
    if (found === undefined) args.error = `${flag} needs a value.`
    return found
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!

    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--quiet' || arg === '-q') args.quiet = true
    else if (arg === '--no-color' || arg === '--no-colour') args.colour = false
    else if (arg === '--color' || arg === '--colour') args.colour = true
    else if (arg === '--authority') args.request.authority = value(++i, '--authority') ?? ''
    else if (arg === '--path') args.request.path = value(++i, '--path') ?? '/'
    else if (arg === '--method') args.request.method = (value(++i, '--method') ?? 'GET').toUpperCase()
    else if (arg === '--sni') args.request.serverName = value(++i, '--sni')
    else if (arg === '--port') {
      const port = Number(value(++i, '--port'))
      if (!Number.isInteger(port) || port < 0) args.error = '--port takes a whole number.'
      else args.request.port = port
    } else if (arg === '--header' || arg === '-H') {
      const header = value(++i, '--header')
      if (header !== undefined) {
        // Split on the FIRST colon only: a `x-forwarded-proto: https://…` value has more of
        // them, and a header split on the last one is a header nobody wrote.
        const cut = header.indexOf(':')
        if (cut === -1) args.error = `--header takes \`name: value\` — got \`${header}\`.`
        // Lower-cased on the way in, because HTTP/2 field names are lower-case and the
        // matcher compares them that way.
        else args.request.headers[header.slice(0, cut).trim().toLowerCase()] = header.slice(cut + 1).trim()
      }
    } else if (arg === '--expect-cluster') args.expect.cluster = value(++i, '--expect-cluster')
    else if (arg === '--expect-outcome') {
      const outcome = value(++i, '--expect-outcome')
      if (outcome !== undefined && !OUTCOMES.has(outcome as Outcome)) {
        args.error = `--expect-outcome takes one of ${[...OUTCOMES].join(', ')} — got \`${outcome}\`.`
      } else if (outcome !== undefined) {
        args.expect.outcome = outcome as Outcome
      }
    } else if (arg === '--format') {
      const format = value(++i, '--format')
      if (format !== undefined && !['human', 'github', 'json'].includes(format)) {
        // Deliberately not sarif. A SARIF result is a finding at a location in a file, and a
        // route assertion is about the config as a whole — the winning route is behaving
        // correctly, so pointing an alert at its line would blame the wrong lines.
        args.error = `route --format takes one of human, github, json — got \`${format}\`.`
      } else if (format !== undefined) {
        args.format = format as 'human' | 'github' | 'json'
      }
    } else if (arg.startsWith('-') && arg !== '-') args.error = `Unknown option \`${arg}\`.`
    else if (args.file === undefined) args.file = arg
    else args.error = `route takes one config at a time — got \`${args.file}\` and \`${arg}\`.`
  }

  if (args.error === undefined && !args.help) {
    if (args.file === undefined) args.error = 'route needs a config to read.'
    else if (args.request.authority === '') args.error = 'route needs an --authority.'
  }

  return args
}

/**
 * Which format to use when nobody said.
 *
 * Detecting GitHub Actions is the difference between this being useful in CI and being a
 * thing you have to remember to configure. `GITHUB_ACTIONS` is set on every runner, and
 * emitting workflow commands there means findings land on the diff with no further setup.
 */
function defaultFormat(env: Record<string, string | undefined>): Format {
  return env.GITHUB_ACTIONS === 'true' ? 'github' : 'human'
}

async function read(file: string): Promise<string> {
  if (file !== '-') return readFile(file, 'utf8')

  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function runRoute(argv: readonly string[]): Promise<number> {
  const args = parseRouteArgs(argv)

  if (args.help) {
    process.stdout.write(`${ROUTE_HELP}\n`)
    return 0
  }
  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\nTry \`attache route --help\`.\n`)
    return 2
  }

  let text: string
  try {
    text = await read(args.file!)
  } catch (cause) {
    process.stderr.write(`Could not read \`${args.file}\`: ${(cause as Error).message}\n`)
    return 2
  }

  const file = args.file === '-' ? '<stdin>' : args.file!
  const check = {
    file,
    request: args.request,
    result: matchRequest(analyse(text).model, args.request),
    expect: args.expect,
  }

  const format = args.format ?? (defaultFormat(process.env) === 'github' ? 'github' : 'human')
  process.stdout.write(
    `${renderRoute(check, format, {
      colour:
        (format === 'human' &&
          (args.colour ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined))) ||
        false,
      quiet: args.quiet,
    })}\n`,
  )

  return routeExitCode(check)
}

export async function run(argv: readonly string[]): Promise<number> {
  // The second verb, and the reason `check` was reserved in the first place rather than
  // simply ignored.
  if (argv[0] === 'route') return runRoute(argv.slice(1))

  const args = parseArgs(argv)

  if (args.error !== undefined) {
    process.stderr.write(`${args.error}\nTry \`attache --help\`.\n`)
    return 2
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`)
    return 0
  }
  if (args.version) {
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    process.stdout.write(`${version}\n`)
    return 0
  }
  if (args.files.length === 0) {
    process.stderr.write(`Nothing to check.\nTry \`attache check envoy.yaml\`, or \`attache --help\`.\n`)
    return 2
  }

  const checked: Checked[] = []
  for (const file of args.files) {
    let text: string
    try {
      text = await read(file)
    } catch (cause) {
      // The path, not a stack. Somebody who has mistyped a filename in a workflow wants to
      // see the filename.
      process.stderr.write(`Could not read \`${file}\`: ${(cause as Error).message}\n`)
      return 2
    }
    checked.push({ file: file === '-' ? '<stdin>' : file, text, analysis: analyse(text) })
  }

  const format = args.format ?? defaultFormat(process.env)
  const options: ReportOptions = {
    format,
    // Machine formats are never coloured, whatever the flags say — escape codes in a JSON
    // document are not a preference, they are corruption. NO_COLOR is the cross-tool
    // convention and applies whatever its value.
    colour:
      (format === 'human' &&
        (args.colour ?? (process.stdout.isTTY === true && process.env.NO_COLOR === undefined))) ||
      false,
    failOn: args.failOn,
    quiet: args.quiet,
    showUnchecked: args.showUnchecked,
    width: args.width ?? Math.min(process.stdout.columns || 100, 100),
  }

  const output = render(checked, options)
  if (output !== '') process.stdout.write(`${output}\n`)

  return exitCode(checked, args.failOn)
}
