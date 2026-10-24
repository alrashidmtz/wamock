import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { parseArgs, DEFAULT_HOST, NON_LOOPBACK_HOSTS } from '../src/cli-args.js'
import { VirtualClock } from '../src/core/clock.js'
import { WamockEngine } from '../src/core/engine.js'
import { MockState } from '../src/core/state.js'
import { WebhookDeliverer } from '../src/webhooks/delivery.js'
import { verifyWebhookUrl } from '../src/webhooks/handshake.js'
import { buildInboundPayload, buildStatusPayload } from '../src/webhooks/payloads.js'
import { createServer } from '../src/server.js'
import { httpTransport } from '../src/webhooks/transport.js'

/**
 * Regression tests for the security review.
 *
 * Each one fails against the code as it was before the fix, which is the only
 * thing that makes them worth keeping.
 */

const EPOCH = 1_750_000_000_000

let server: FastifyInstance | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

describe('the CLI binds loopback by default', () => {
  it('does not expose the unauthenticated control API to the network', () => {
    // /__mock/messages returns every message the app under test sent, and
    // /__mock/inbound injects forged customer messages into it. Neither is
    // authenticated — correct for a local tool, fatal on a shared network.
    expect(parseArgs(['start']).options.host).toBe(DEFAULT_HOST)
    expect(NON_LOOPBACK_HOSTS.has(parseArgs(['start']).options.host)).toBe(false)
  })

  it('allows an explicit opt-in for containers', () => {
    expect(parseArgs(['start', '--host', '0.0.0.0']).options.host).toBe('0.0.0.0')
  })

  it('recognises every wildcard form as non-loopback, so none slips past the warning', () => {
    for (const host of ['0.0.0.0', '::', '::0']) {
      expect(NON_LOOPBACK_HOSTS.has(host), host).toBe(true)
    }
  })
})

describe('outbound HTTP is bounded', () => {
  /** A receiver that accepts the connection and never answers. */
  async function startBlackHole(): Promise<string> {
    server = Fastify()
    server.all('/webhook', () => new Promise(() => {}))
    const address = await server.listen({ port: 0, host: '127.0.0.1' })
    return `${address}/webhook`
  }

  it('gives up on a receiver that never responds', async () => {
    // Without a timeout the delivery promise never settles, `settle()` never
    // resolves, and the test hangs with no output at all. A hang is strictly
    // worse than a failure: there is nothing to read.
    const url = await startBlackHole()

    await expect(httpTransport(url, { timeoutMs: 150 })({
      body: '{}',
      signature: 'sha256=x',
      payload: { object: 'whatsapp_business_account', entry: [] },
      deliveredAt: EPOCH,
    })).rejects.toThrow(/did not respond within 150ms/)
  }, 10_000)

  it('gives up on a handshake that never completes', async () => {
    const url = await startBlackHole()

    const result = await verifyWebhookUrl(url, 'vt', 150)

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/did not respond within 150ms/)
  }, 10_000)
})

describe('message content cannot forge the envelope', () => {
  it('ignores reserved keys supplied as message content', () => {
    // Nothing feeds unfiltered input here today. This asserts the invariant
    // rather than the current call sites, so a future change that widens what
    // reaches `content` cannot break the envelope silently.
    const payload = buildInboundPayload({
      wabaId: 'WABA_1',
      phoneNumberId: 'PNID_1',
      displayPhoneNumber: '15550001111',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      messageId: 'wamid.REAL',
      timestampMs: EPOCH,
      message: {
        type: 'text',
        text: { body: 'hola' },
        from: '5219999999999',
        from_user_id: 'MX.FORGED',
        id: 'wamid.FORGED',
        timestamp: '0',
      },
    })

    const message = payload.entry[0]!.changes[0]!.value.messages![0]!
    expect(message.from).toBe('5215555000001')
    expect(message.id).toBe('wamid.REAL')
    expect(message.timestamp).toBe(String(EPOCH / 1000))
  })

  it('still puts the envelope fields first, as Meta does', () => {
    const payload = buildInboundPayload({
      wabaId: 'WABA_1',
      phoneNumberId: 'PNID_1',
      displayPhoneNumber: '15550001111',
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      messageId: 'wamid.X',
      timestampMs: EPOCH,
      message: { type: 'text', text: { body: 'hola' } },
    })

    expect(Object.keys(payload.entry[0]!.changes[0]!.value.messages![0]!)).toEqual([
      'from',
      'from_user_id',
      'id',
      'timestamp',
      'type',
      'text',
    ])
  })
})

describe('retained history is bounded', () => {
  it('evicts the oldest recorded messages past the cap', () => {
    // A mock left running for a demo or a long CI job would otherwise grow
    // until the process dies.
    const state = new MockState({ appSecret: 's', maxRecordedMessages: 3 })
    for (let i = 0; i < 5; i++) {
      state.recordOutbound({
        id: `wamid.${i}`,
        phoneNumberId: state.defaultPhoneNumberId,
        to: '5215555000001',
        type: 'text',
        payload: {},
        recipientUserId: 'MX.1',
        sentTo: 'phone',
        sentAt: EPOCH,
      })
    }

    expect(state.outbound()).toHaveLength(3)
    expect(state.outbound()[0]!.id).toBe('wamid.2')
  })

  it('reports how many were dropped, so truncation is never silent', () => {
    const state = new MockState({ appSecret: 's', maxRecordedMessages: 2 })
    for (let i = 0; i < 5; i++) {
      state.recordOutbound({
        id: `wamid.${i}`,
        phoneNumberId: state.defaultPhoneNumberId,
        to: '5215555000001',
        type: 'text',
        payload: {},
        recipientUserId: 'MX.1',
        sentTo: 'phone',
        sentAt: EPOCH,
      })
    }

    expect(state.droppedOutbound()).toBe(3)
  })

  it('resets the drop counter with the rest of the state', () => {
    const state = new MockState({ appSecret: 's', maxRecordedMessages: 1 })
    state.recordOutbound({
      id: 'a',
      phoneNumberId: state.defaultPhoneNumberId,
      to: 't',
      type: 'text',
      payload: {},
      recipientUserId: 'MX.1',
      sentTo: 'phone',
      sentAt: 0,
    })
    state.recordOutbound({
      id: 'b',
      phoneNumberId: state.defaultPhoneNumberId,
      to: 't',
      type: 'text',
      payload: {},
      recipientUserId: 'MX.1',
      sentTo: 'phone',
      sentAt: 0,
    })
    expect(state.droppedOutbound()).toBe(1)

    state.reset()

    expect(state.droppedOutbound()).toBe(0)
  })

  it('bounds the webhook delivery log too', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const deliverer = new WebhookDeliverer({ clock, transport: async () => {}, maxLogEntries: 2 })

    for (let i = 0; i < 5; i++) {
      deliverer.enqueue(
        buildStatusPayload({
          wabaId: 'WABA_1',
          phoneNumberId: 'PNID_1',
          displayPhoneNumber: '15550001111',
          messageId: `wamid.${i}`,
          status: 'sent',
          user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
          sentTo: 'phone',
          timestampMs: EPOCH,
        }),
        { appSecret: 's' },
      )
    }
    clock.advance(0)
    await deliverer.settle()

    expect(deliverer.log()).toHaveLength(2)
    expect(deliverer.droppedLogEntries()).toBe(3)
  })
})

describe('a business token is refused another customer’s objects as Graph refuses them', () => {
  const tenants = () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    const onboard = () => {
      const signup = engine.createSignup()
      return { ...signup, token: engine.exchangeCode(engine.state.defaultAppId, 's', signup.code).access_token }
    }
    return { engine, a: onboard(), b: onboard() }
  }
  const messageOf = (fn: () => void): string => {
    try {
      fn()
    } catch (err) {
      return (err as Error).message
    }
    throw new Error('expected a refusal')
  }

  it('names the verb of the call in the unsupported-request error', () => {
    const { engine, a, b } = tenants()
    const refusal = (method?: 'get' | 'post' | 'delete') =>
      messageOf(() =>
        engine.assertAccessToken(a.token, { objectId: b.phone_number_id, ...(method !== undefined ? { method } : {}) }),
      )
    expect(refusal('post')).toMatch(new RegExp(`^Unsupported post request\\. Object with ID '${b.phone_number_id}'`))
    expect(refusal('delete')).toMatch(/^Unsupported delete request/)
    expect(refusal()).toMatch(/^Unsupported get request/)
  })

  it('lets it reach its own WABA, number and media', () => {
    const { engine, a } = tenants()
    const { id } = engine.uploadMedia(a.phone_number_id, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('x') },
    })
    for (const objectId of [a.waba_id, a.phone_number_id, id]) {
      expect(() => engine.assertAccessToken(a.token, { objectId, method: 'get' })).not.toThrow()
    }
  })
})

describe('uploading media needs the messaging permission', () => {
  it('refuses a management-only token on POST /{phone_number_id}/media', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    server = createServer(engine)
    await server.ready()
    const upload = (token: string) =>
      server!.inject({
        method: 'POST',
        url: `/v26.0/${engine.state.defaultPhoneNumberId}/media`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'multipart/form-data; boundary=b' },
        payload: [
          '--b\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n',
          '--b\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\nJPEG\r\n',
          '--b--\r\n',
        ].join(''),
      })
    const { access_token: managementOnly } = engine.issueToken({ scopes: ['whatsapp_business_management'] })
    const { access_token: messagingOnly } = engine.issueToken({ scopes: ['whatsapp_business_messaging'] })
    expect((await upload(managementOnly)).json().error.error_data.details).toMatch(/whatsapp_business_messaging/)
    expect((await upload(messagingOnly)).statusCode).toBe(200)
  })
})

describe('an object that does not exist needs no permission to be reported missing', () => {
  it('answers a token without scopes Graph’s unsupported request, not a permissions error', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    server = createServer(engine)
    await server.ready()
    const { access_token: none } = engine.issueToken({ scopes: [] })
    const res = await server.inject({ method: 'GET', url: '/v26.0/999999999999999', headers: { authorization: `Bearer ${none}` } })
    expect(res.json().error).toMatchObject({ code: 100, error_subcode: 33 })
  })
})
