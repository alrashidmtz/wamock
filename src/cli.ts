#!/usr/bin/env node
import { HELP_TEXT, parseArgs } from './cli-args.js'
import { WamockEngine } from './core/engine.js'
import { createServer } from './server.js'
import { verifyWebhookUrl } from './webhooks/handshake.js'
import { httpTransport } from './webhooks/transport.js'

/**
 * The `npx wamock start` entry point. Everything here is process wiring; the
 * behaviour lives in the engine and the parsing lives in cli-args.ts, both of
 * which are tested without spawning anything.
 */

const VERSION = '0.1.0'

async function main(argv: string[]): Promise<number> {
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
  await app.listen({ port: options.port, host: '0.0.0.0' })

  const base = `http://localhost:${options.port}`
  process.stdout.write(
    [
      '',
      `  wamock ${VERSION} — WhatsApp Cloud API mock`,
      '',
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
