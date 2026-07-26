import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { parseArgs, DEFAULT_HOST, NON_LOOPBACK_HOSTS } from '../src/cli-args.js'
import { VirtualClock } from '../src/core/clock.js'
import { MockState } from '../src/core/state.js'
import { WebhookDeliverer } from '../src/webhooks/delivery.js'
import { verifyWebhookUrl } from '../src/webhooks/handshake.js'
import { buildInboundPayload, buildStatusPayload } from '../src/webhooks/payloads.js'
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

    await expect(httpTransport(url, 150)({
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
      from: '5215555000001',
      messageId: 'wamid.REAL',
      timestampMs: EPOCH,
      message: {
        type: 'text',
        text: { body: 'hola' },
        from: '5219999999999',
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
      from: '5215555000001',
      messageId: 'wamid.X',
      timestampMs: EPOCH,
      message: { type: 'text', text: { body: 'hola' } },
    })

    expect(Object.keys(payload.entry[0]!.changes[0]!.value.messages![0]!)).toEqual([
      'from',
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
      sentAt: 0,
    })
    state.recordOutbound({
      id: 'b',
      phoneNumberId: state.defaultPhoneNumberId,
      to: 't',
      type: 'text',
      payload: {},
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
          recipientId: '5215555000001',
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
