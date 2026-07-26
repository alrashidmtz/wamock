import { randomBytes } from 'node:crypto'

/**
 * Argument parsing, kept apart from the process-touching parts of the CLI so
 * it can be tested without spawning anything.
 */

export interface CliOptions {
  port: number
  /**
   * Interface to bind. Loopback by default — see the note on DEFAULT_HOST.
   */
  host: string
  appSecret: string
  webhookUrl: string | undefined
  verifyToken: string
  phoneNumberId: string | undefined
  wabaId: string | undefined
  displayPhoneNumber: string | undefined
  quiet: boolean
}

export interface ParsedArgs {
  command: 'start' | 'help' | 'version'
  options: CliOptions
}

const DEFAULT_PORT = 4004

/**
 * Loopback only, deliberately.
 *
 * The control API has no authentication — correct for a local tool, and the
 * reason binding beyond loopback is dangerous. On a shared network anyone who
 * can reach the port can read `/__mock/messages` (every message the app under
 * test sent, recipients and bodies included) and POST `/__mock/inbound` to
 * inject forged customer messages into it.
 *
 * Docker needs `--host 0.0.0.0` to publish the port; that is an explicit,
 * warned-about opt-in rather than the default everyone gets.
 */
export const DEFAULT_HOST = '127.0.0.1'

/** Binding to any of these exposes the unauthenticated control API. */
export const NON_LOOPBACK_HOSTS = new Set(['0.0.0.0', '::', '::0'])

/** Flags that consume the next argument. Anything else is a boolean or an error. */
const VALUE_FLAGS = new Map<string, keyof CliOptions>([
  ['--port', 'port'],
  ['--host', 'host'],
  ['--app-secret', 'appSecret'],
  ['--webhook-url', 'webhookUrl'],
  ['--verify-token', 'verifyToken'],
  ['--phone-number-id', 'phoneNumberId'],
  ['--waba-id', 'wabaId'],
  ['--display-phone-number', 'displayPhoneNumber'],
])

export function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = {
    port: DEFAULT_PORT,
    host: DEFAULT_HOST,
    // Generated, never a fixed default: a hardcoded secret would make every
    // wamock signature forgeable by anyone who read the source, and someone
    // would eventually run this somewhere reachable.
    appSecret: randomBytes(16).toString('hex'),
    webhookUrl: undefined,
    verifyToken: 'wamock-verify-token',
    phoneNumberId: undefined,
    wabaId: undefined,
    displayPhoneNumber: undefined,
    quiet: false,
  }

  let command: ParsedArgs['command'] = 'start'
  let index = 0

  if (argv[0] !== undefined && !argv[0].startsWith('-')) {
    if (argv[0] !== 'start') throw new Error(`Unknown command '${argv[0]}'. Try: wamock start`)
    index = 1
  }

  for (; index < argv.length; index++) {
    const arg = argv[index]!

    if (arg === '--help' || arg === '-h') {
      command = 'help'
      continue
    }
    if (arg === '--version' || arg === '-v') {
      command = 'version'
      continue
    }
    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
      continue
    }

    // Support both `--flag value` and `--flag=value`.
    const equalsAt = arg.indexOf('=')
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt)
    const inlineValue = equalsAt === -1 ? undefined : arg.slice(equalsAt + 1)

    const key = VALUE_FLAGS.get(flag)
    // An ignored typo is worse than an error: the user believes they
    // configured something that is not configured.
    if (!key) throw new Error(`Unknown option '${flag}'. Run 'wamock --help' for the list.`)

    const value = inlineValue ?? argv[++index]
    if (value === undefined) throw new Error(`Option '${flag}' expects a value`)

    if (key === 'port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid --port '${value}': expected an integer between 1 and 65535`)
      }
      options.port = port
    } else if (key !== 'quiet') {
      options[key] = value
    }
  }

  return { command, options }
}

export const HELP_TEXT = `wamock — a faithful mock of the WhatsApp Cloud API

Usage:
  wamock start [options]

Options:
  --port <n>                  Port to listen on (default: ${DEFAULT_PORT})
  --host <addr>               Interface to bind (default: ${DEFAULT_HOST}).
                              The control API is UNAUTHENTICATED: binding
                              beyond loopback lets anyone who can reach the
                              port read every message the app under test sent
                              and inject forged inbound messages into it.
                              Use 0.0.0.0 only inside a container.
  --app-secret <secret>       Signs outgoing webhooks (default: randomly generated)
  --webhook-url <url>         Where to deliver webhooks
  --verify-token <token>      Token used for the subscription handshake
  --phone-number-id <id>      Override the seeded phone number id
  --waba-id <id>              Override the seeded WABA id
  --display-phone-number <n>  Override the seeded business number (digits only)
  -q, --quiet                 Suppress request logging
  -h, --help                  Show this help
  -v, --version               Show the version

Quickstart:
  wamock start --app-secret shhh --webhook-url http://localhost:3000/webhook
  curl -X POST localhost:${DEFAULT_PORT}/__mock/inbound \\
    -H 'content-type: application/json' \\
    -d '{"from":"5215555000001","text":"hola"}'
`
