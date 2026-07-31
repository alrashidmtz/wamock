/**
 * The shape a real integration test takes against wamock.
 *
 * Copy this file, replace `myApp` with your own webhook handler and sender,
 * and you have the full lifecycle under test — with no WABA, no network, and
 * no waiting a day for the service window to close.
 *
 * Run it with: vitest run
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// Import at the top, never inside the handler. A dynamic import in a callback
// that the mock is awaiting deadlocks under vitest's module runner — and it is
// poor practice regardless, since the handler runs on every webhook.
import { createWamock, verifySignature, type Wamock } from 'wamock'

const HOURS = (n: number) => n * 60 * 60 * 1000
const CUSTOMER = '5216691112233' // note: no '+', exactly as Meta sends it

/**
 * Stand-in for the code under test: a webhook handler that verifies the
 * signature and replies. Replace with your own.
 */
function buildApp(mock: () => Wamock) {
  return {
    async handleWebhook(rawBody: string, signature: string | undefined) {
      // Verify against the RAW bytes — never a re-serialized object.
      if (!verifySignature({ appSecret: 'test-secret', body: rawBody, header: signature })) {
        throw new Error('bad signature')
      }

      const value = JSON.parse(rawBody).entry[0].changes[0].value

      // Delivery receipts arrive with NO `messages` key. Tolerate that.
      if (!value.messages) return

      const message = value.messages[0]
      await mock().send({ to: message.from, text: `You said: ${message.text.body}` })
    },
  }
}

let mock: Wamock
let app: ReturnType<typeof buildApp>

beforeEach(async () => {
  app = buildApp(() => mock)
  mock = await createWamock({
    appSecret: 'test-secret',
    // Frozen virtual time: pin `start` and every run produces identical ids.
    start: 1_750_000_000_000,
    onWebhook: (delivery) => app.handleWebhook(delivery.body, delivery.signature),
  })
})

afterEach(async () => {
  await mock.close()
})

describe('my WhatsApp integration', () => {
  it('replies to an inbound message', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    mock.expectSent({ to: CUSTOMER, text: 'You said: hola' })
  })

  it('cannot send free-form text once the 24h window closes', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await mock.time.advance(HOURS(25))

    await expect(mock.send({ to: CUSTOMER, text: 'still there?' })).rejects.toMatchObject({
      code: 131047,
    })
  })

  it('reaches the customer with an approved template instead', async () => {
    await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })
    await mock.time.advance(HOURS(48))

    await mock.send({
      to: CUSTOMER,
      template: { name: 'recordatorio_24h', language: 'es_MX' },
    })

    mock.expectSent({ type: 'template', name: 'recordatorio_24h', language: 'es_MX' })
  })

  it('fails when the template was approved in a different language', async () => {
    // The trap: es_MX is live, en_US was never submitted, and nothing about
    // the es_MX approval hints at that.
    await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })

    await expect(
      mock.send({ to: CUSTOMER, template: { name: 'recordatorio_24h', language: 'en_US' } }),
    ).rejects.toMatchObject({ code: 132001 })
  })

  it('survives duplicate and out-of-order delivery receipts', async () => {
    // Meta is at-least-once and does not guarantee ordering. If your handler
    // breaks here, it will break in production.
    mock.scenario({ duplicateWebhooks: true, outOfOrderStatuses: true })

    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await mock.time.advance(60_000)

    expect(mock.messages().length).toBeGreaterThan(0)
  })

  it('backs off and recovers from a rate limit', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    mock.scenario({ nextError: { code: 130429, times: 2 } })

    await expect(mock.send({ to: CUSTOMER, text: 'one' })).rejects.toMatchObject({ code: 130429 })
    await expect(mock.send({ to: CUSTOMER, text: 'two' })).rejects.toMatchObject({ code: 130429 })
    await expect(mock.send({ to: CUSTOMER, text: 'three' })).resolves.toBeDefined()
  })
})
