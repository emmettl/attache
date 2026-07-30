import { readFile } from 'node:fs/promises'
import { analyse } from '@attache/core'
import {
  exitCode,
  render,
  type Checked,
  type FailOn,
  type Format,
  type ReportOptions,
} from './report.js'

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

export async function run(argv: readonly string[]): Promise<number> {
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
