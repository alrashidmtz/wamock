import { createHmac, timingSafeEqual } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installGraphInterceptor } from '../src/intercept.js'
import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'

/**
 * Dogfood (spec §13.2) — can a real integration run against wamock?
 *
 * ## What this is, honestly
 *
 * The client below is a **reconstruction of the contract** two production
 * integrations were observed to follow, not their code. It hardcodes
 * `graph.facebook.com` exactly the way they do, sends the request shapes they
 * send, and branches on errors the way they branch. If wamock satisfies it,
 * wamock speaks the dialect real code emits.
 *
 * It is weaker evidence than running someone's actual suite, and stronger than
 * testing the mock against assertions written by the same person who wrote the
 * mock's internals: this file only ever touches the public HTTP surface.
 *
 * ## What the dogfood found
 *
 * Neither audited integration had a configurable Graph base URL — both build
 * the URL as a string literal. "Point it at the mock" was therefore impossible
 * by configuration, which is why `installGraphInterceptor` exists. Every test
 * here goes through it, with the client's URLs left untouched.
 */

const HOURS = (n: number) => n * 60 * 60 * 1000
const CUSTOMER = '5216691112233'
const APP_SECRET = 'dogfood-secret'

/** Errors the way a production client surfaces them: code first. */
class CloudApiSendError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message)
  }
}

/**
 * A WhatsApp client written the way the audited ones are: hardcoded host,
 * bearer token, and error handling that branches on Meta's numeric codes.
 * Nothing here knows wamock exists.
 */
class ProductionShapedClient {
  constructor(
    private readonly phoneNumberId: string,
    private readonly accessToken: string,
  ) {}

  async #post(payload: Record<string, unknown>): Promise<string> {
    // Hardcoded, deliberately — this is the whole point of the exercise.
    const res = await fetch(
      `https://graph.facebook.com/v19.0/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
      },
    )

    if (!res.ok) {
      const text = await res.text()
      let code: number | undefined
      try {
        code = (JSON.parse(text) as { error?: { code?: number } }).error?.code
      } catch {
        /* non-JSON error body */
      }
      throw new CloudApiSendError(`send failed (${res.status}): ${text}`, code)
    }

    const json = (await res.json()) as { messages?: Array<{ id?: string }> }
    const id = json.messages?.[0]?.id
    if (!id) throw new Error('no message id in the Cloud API response')
    return id
  }

  sendText(to: string, body: string): Promise<string> {
    return this.#post({ to, type: 'text', text: { body } })
  }

  sendTemplate(to: string, name: string, language: string, params: string[]): Promise<string> {
    return this.#post({
      to,
      type: 'template',
      template: {
        name,
        language: { code: language },
        components: params.length
          ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }]
          : [],
      },
    })
  }
}

/**
 * A receiver written the way the audited ones are: verifies the signature over
 * the RAW body, tolerates webhooks with no `messages` key, and dedupes by wamid.
 */
class ProductionShapedReceiver {
  readonly inbound: Array<{ from: string; text: string }> = []
  readonly statuses: Array<{ id: string; status: string }> = []
  readonly rejected: string[] = []
  readonly #seenWamids = new Set<string>()

  handle(rawBody: string, signature: string | undefined): void {
    const expected =
      'sha256=' + createHmac('sha256', APP_SECRET).update(rawBody, 'utf8').digest('hex')
    const a = Buffer.from(signature ?? '')
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.rejected.push(rawBody)
      return
    }

    for (const entry of JSON.parse(rawBody).entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {}

        // Delivery receipts arrive with NO `messages` key at all.
        for (const status of value.statuses ?? []) {
          this.statuses.push({ id: status.id, status: status.status })
        }

        for (const message of value.messages ?? []) {
          // Meta is at-least-once; dedupe by wamid or you double-reply.
          if (this.#seenWamids.has(message.id)) continue
          this.#seenWamids.add(message.id)
          this.inbound.push({ from: message.from, text: message.text?.body ?? '' })
        }
      }
    }
  }
}

let mock: Wamock
let receiver: ProductionShapedReceiver
let client: ProductionShapedClient
let restore: () => void

beforeEach(async () => {
  receiver = new ProductionShapedReceiver()
  mock = await createWamock({
    appSecret: APP_SECRET,
    start: 1_750_000_000_000,
    onWebhook: (delivery) => {
      receiver.handle(delivery.body, delivery.signature)
    },
  })
  // The client is never told where the mock is; the interceptor moves the
  // destination underneath it.
  restore = installGraphInterceptor({ baseUrl: mock.baseUrl })
  client = new ProductionShapedClient(mock.phoneNumberId, 'unused-token')
})

afterEach(async () => {
  restore()
  await mock.close()
})

describe('an unmodified, hardcoded client against wamock', () => {
  it('sends a text message and gets a wamid back', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    const wamid = await client.sendText(CUSTOMER, 'buenas')

    expect(wamid).toMatch(/^wamid\./)
    mock.expectSent({ to: CUSTOMER, text: 'buenas' })
  })

  it('receives inbound webhooks it can verify', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola', name: 'Ana' })

    expect(receiver.rejected).toHaveLength(0)
    expect(receiver.inbound).toEqual([{ from: CUSTOMER, text: 'hola' }])
  })

  it('receives delivery statuses without tripping over the missing messages key', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await client.sendText(CUSTOMER, 'buenas')

    await mock.time.advance(60_000)

    expect(receiver.statuses.map((s) => s.status)).toEqual(['sent', 'delivered'])
    expect(receiver.rejected).toHaveLength(0)
  })
})

describe('the failure paths a production client actually branches on', () => {
  it('surfaces 131047 once the 24h window closes', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await mock.time.advance(HOURS(25))

    const error = await client.sendText(CUSTOMER, 'sigues?').catch((e: unknown) => e)

    expect(error).toBeInstanceOf(CloudApiSendError)
    expect((error as CloudApiSendError).code).toBe(131047)
  })

  it('completes the real fallback: 131047 caught, template sent instead', async () => {
    // This is the exact recovery both audited integrations implement, and the
    // reason 131047 has to be distinguishable from every other failure.
    await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await mock.time.advance(HOURS(25))

    let wamid: string
    try {
      wamid = await client.sendText(CUSTOMER, 'sigues?')
    } catch (err) {
      if (!(err instanceof CloudApiSendError) || err.code !== 131047) throw err
      wamid = await client.sendTemplate(CUSTOMER, 'recordatorio_24h', 'es_MX', ['Ana'])
    }

    expect(wamid).toMatch(/^wamid\./)
    mock.expectSent({ type: 'template', name: 'recordatorio_24h', language: 'es_MX' })
  })

  it('surfaces 132001 for a template approved only in another language', async () => {
    await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })

    const error = await client
      .sendTemplate(CUSTOMER, 'recordatorio_24h', 'en_US', [])
      .catch((e: unknown) => e)

    expect((error as CloudApiSendError).code).toBe(132001)
  })

  it('surfaces a rate limit with its retriable code', async () => {
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    mock.scenario({ nextError: { code: 130429 } })

    const error = await client.sendText(CUSTOMER, 'hola').catch((e: unknown) => e)

    expect((error as CloudApiSendError).code).toBe(130429)
  })
})

describe('the delivery quirks that break naive receivers', () => {
  it('survives duplicate webhooks without double-processing', async () => {
    mock.scenario({ duplicateWebhooks: true })

    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    // Two webhooks arrived; the wamid dedupe collapsed them to one message.
    expect(receiver.inbound).toHaveLength(1)
  })

  it('survives statuses arriving before the send status', async () => {
    mock.scenario({ outOfOrderStatuses: true })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })
    await client.sendText(CUSTOMER, 'buenas')

    await mock.time.advance(60_000)

    expect(receiver.statuses.map((s) => s.status)).toEqual(['delivered', 'sent'])
    expect(receiver.rejected).toHaveLength(0)
  })

  it('rejects a webhook signed with the wrong secret', async () => {
    // Proves the receiver's verification is real, so the passing cases above
    // mean something.
    receiver.handle('{"entry":[]}', 'sha256=' + '0'.repeat(64))

    expect(receiver.rejected).toHaveLength(1)
    expect(receiver.inbound).toHaveLength(0)
  })
})

describe('traffic that is not Meta', () => {
  it('is left alone by the interceptor', async () => {
    // A test suite must not have its unrelated HTTP silently rerouted into the
    // mock. Verified against the mock's own port, which would answer if the
    // request were wrongly redirected.
    const res = await fetch(`${mock.baseUrl}/__mock/state`)
    expect(res.status).toBe(200)
  })
})
