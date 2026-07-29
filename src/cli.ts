#!/usr/bin/env node
import { readFileSync } from 'node:fs'

import { DEFAULT_HOST, HELP_TEXT, NON_LOOPBACK_HOSTS, parseArgs } from './cli-args.js'
import { WamockEngine } from './core/engine.js'
import { createServer } from './server.js'
import { verifyWebhookUrl } from './webhooks/handshake.js'
import { httpTransport } from './webhooks/transport.js'

/**
 * The `npx wamock start` entry point. Everything here is process wiring; the
 * behaviour lives in the engine and the parsing lives in cli-args.ts, both of
 * which are tested without spawning anything.
 */

/**
 * Read from package.json rather than duplicated here.
 *
 * It used to be a literal, and nothing updated it: `wamock --version` reported
 * 0.1.0 from 0.2.0 onward. That is the worst string to let drift — it is what
 * people paste into bug reports, so a diagnosis would start from a false fact.
 *
 * `../package.json` resolves to the package root from `dist/cli.js` and to the
 * repo root when running the sources directly, so both paths work.
 */
const VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string
  }
).version

/**
 * A closed pipe is not an error worth a stack trace.
 *
 * `wamock --help | somecommand` where the reader exits immediately makes the
 * next write raise EPIPE, and an unhandled one prints a crash that looks like
 * a bug in wamock. Exiting quietly is what the reader asked for.
 */
function ignoreBrokenPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPIPE') process.exit(0)
      throw error
    })
  }
}

async function main(argv: string[]): Promise<number> {
  ignoreBrokenPipe()

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  if (parsed.command === 'help') {
    process.stdout.write(HELP_TEXT)
    return 0
  }
  if (parsed.command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }

  const { options } = parsed

  const engine = new WamockEngine({
    appSecret: options.appSecret,
    // Live mode: a developer watching a terminal expects delivery receipts to
    // arrive on their own, not only when they poke a control endpoint.
    mode: 'live',
    ...(options.phoneNumberId !== undefined ? { phoneNumberId: options.phoneNumberId } : {}),
    ...(options.wabaId !== undefined ? { wabaId: options.wabaId } : {}),
    ...(options.displayPhoneNumber !== undefined
      ? { displayPhoneNumber: options.displayPhoneNumber }
      : {}),
  })
  engine.clock.start()

  if (options.webhookUrl) {
    engine.deliverer.setTransport(httpTransport(options.webhookUrl))
  }

  const app = createServer(engine, { logger: !options.quiet })
  await app.listen({ port: options.port, host: options.host })

  const base = `http://localhost:${options.port}`
  process.stdout.write(
    [
      '',
      `  wamock ${VERSION} — WhatsApp Cloud API mock`,
      '',
      `  Listening on     ${options.host}:${options.port}`,
      `  Graph base URL   ${base}`,
      `  Control API      ${base}/__mock`,
      `  phone_number_id  ${engine.state.defaultPhoneNumberId}`,
      `  waba_id          ${engine.state.defaultWabaId}`,
      `  app secret       ${options.appSecret}`,
      `  webhook url      ${options.webhookUrl ?? '(none — webhooks are discarded)'}`,
      '',
      '  Simulate a customer writing in:',
      `    curl -X POST ${base}/__mock/inbound \\`,
      `      -H 'content-type: application/json' \\`,
      `      -d '{"from":"5215555000001","text":"hola"}'`,
      '',
    ].join('\n'),
  )

  if (NON_LOOPBACK_HOSTS.has(options.host)) {
    // Loud on purpose. Someone will do this on a laptop in a shared space and
    // hand every message the app under test sent to whoever is on that wifi.
    process.stdout.write(
      [
        `  ! Bound to ${options.host} — reachable from your network.`,
        '    The /__mock control API has NO authentication: anyone who can',
        '    reach this port can read every message sent and inject forged',
        '    inbound messages. Fine inside a container, not on a shared',
        `    network. Use --host ${DEFAULT_HOST} to restrict it.`,
        '',
      ].join('\n'),
    )
  }

  if (options.webhookUrl) {
    // Run Meta's own subscription handshake. A receiver that answers "ok"
    // instead of echoing the challenge looks healthy and silently receives
    // nothing — better to say so now than to debug it in an hour.
    const result = await verifyWebhookUrl(options.webhookUrl, options.verifyToken)
    process.stdout.write(
      result.ok
        ? `  ✓ webhook url verified (hub.challenge echoed)\n\n`
        : `  ! webhook verification failed: ${result.reason}\n` +
            `    Webhooks will still be delivered, but Meta would refuse this URL.\n\n`,
    )
  }

  const shutdown = () => {
    engine.clock.stop()
    void app.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return 0
}

const code = await main(process.argv.slice(2))
if (code !== 0) process.exit(code)
