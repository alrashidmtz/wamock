import { describe, expect, it, vi } from 'vitest'

import { VirtualClock } from '../../src/core/clock.js'
import { WebhookDeliverer } from '../../src/webhooks/delivery.js'
import { buildStatusPayload } from '../../src/webhooks/payloads.js'
import { verifySignature } from '../../src/webhooks/signature.js'

const EPOCH = 1_750_000_000_000
const SECRET = 'app-secret'

const samplePayload = () =>
  buildStatusPayload({
    wabaId: 'WABA_1',
    phoneNumberId: 'PNID_1',
    displayPhoneNumber: '15550001111',
    messageId: 'wamid.OUT1',
    status: 'sent',
    recipientId: '5215555000001',
    timestampMs: EPOCH,
  })

function harness() {
  const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
  const received: Array<{ body: string; signature: string | undefined }> = []
  const deliverer = new WebhookDeliverer({
    clock,
    transport: async (delivery) => {
      received.push({ body: delivery.body, signature: delivery.signature })
    },
  })
  return { clock, deliverer, received }
}

describe('WebhookDeliverer — scheduling', () => {
  it('holds a future delivery until virtual time reaches it', async () => {
    const { clock, deliverer, received } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, atMs: EPOCH + 1000 })

    clock.advance(500)
    await deliverer.settle()
    expect(received).toHaveLength(0)

    clock.advance(600)
    await deliverer.settle()
    expect(received).toHaveLength(1)
  })

  it('delivers immediately when no time is given', async () => {
    const { clock, deliverer, received } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })

    clock.advance(0)
    await deliverer.settle()

    expect(received).toHaveLength(1)
  })

  it('delivers in deadline order even when enqueued out of order', async () => {
    const { clock, deliverer, received } = harness()
    const second = buildStatusPayload({
      wabaId: 'WABA_1',
      phoneNumberId: 'PNID_1',
      displayPhoneNumber: '15550001111',
      messageId: 'wamid.SECOND',
      status: 'delivered',
      recipientId: '5215555000001',
      timestampMs: EPOCH,
    })

    deliverer.enqueue(second, { appSecret: SECRET, atMs: EPOCH + 2000 })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, atMs: EPOCH + 1000 })

    clock.advance(5000)
    await deliverer.settle()

    expect(received.map((r) => JSON.parse(r.body).entry[0].changes[0].value.statuses[0].id)).toEqual(
      ['wamid.OUT1', 'wamid.SECOND'],
    )
  })
})

describe('WebhookDeliverer — signing', () => {
  it('signs the exact bytes it puts on the wire', async () => {
    const { clock, deliverer, received } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })

    clock.advance(0)
    await deliverer.settle()

    const sent = received[0]!
    expect(verifySignature({ appSecret: SECRET, body: sent.body, header: sent.signature })).toBe(true)
  })

  it('signs with the secret it was given, not a global one', async () => {
    const { clock, deliverer, received } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: 'tenant-secret' })

    clock.advance(0)
    await deliverer.settle()

    const sent = received[0]!
    expect(verifySignature({ appSecret: 'tenant-secret', body: sent.body, header: sent.signature })).toBe(true)
    expect(verifySignature({ appSecret: 'platform-secret', body: sent.body, header: sent.signature })).toBe(false)
  })
})

describe('WebhookDeliverer — failure isolation', () => {
  it('does not let a transport failure escape advance()', async () => {
    // A throwing receiver must not break the clock drain — otherwise one
    // unreachable webhook URL would stop every other scheduled effect, which
    // is nothing like how Meta behaves.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })

    expect(() => clock.advance(0)).not.toThrow()
    await expect(deliverer.settle()).resolves.toBeUndefined()
  })

  it('records the failure in the delivery log', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })

    clock.advance(0)
    await deliverer.settle()

    expect(deliverer.log()[0]).toMatchObject({ ok: false, error: 'ECONNREFUSED' })
  })
})

describe('WebhookDeliverer — inspection', () => {
  it('logs each delivery with its virtual timestamp', async () => {
    const { clock, deliverer } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, atMs: EPOCH + 1500 })

    clock.advance(5000)
    await deliverer.settle()

    expect(deliverer.log()[0]).toMatchObject({ ok: true, deliveredAt: EPOCH + 1500 })
  })

  it('clear() empties the log', async () => {
    const { clock, deliverer } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    await deliverer.settle()

    deliverer.clear()

    expect(deliverer.log()).toHaveLength(0)
  })

  it('settle() resolves immediately when nothing is in flight', async () => {
    const { deliverer } = harness()
    await expect(deliverer.settle()).resolves.toBeUndefined()
  })

  it('setTransport() redirects subsequent deliveries', async () => {
    // The server swaps the transport when --webhook-url is (re)configured;
    // already-queued webhooks must go to the new destination.
    const { clock, deliverer, received } = harness()
    const rerouted: string[] = []
    deliverer.setTransport(async (d) => {
      rerouted.push(d.body)
    })

    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    await deliverer.settle()

    expect(received).toHaveLength(0)
    expect(rerouted).toHaveLength(1)
  })

  it('cancels pending deliveries on clear() so a reset does not leak effects', async () => {
    // reset() must not leave a status from the previous test scheduled to fire
    // into the next one.
    const { clock, deliverer, received } = harness()
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, atMs: EPOCH + 1000 })

    deliverer.clear()
    clock.advance(5000)
    await deliverer.settle()

    expect(received).toHaveLength(0)
  })
})

describe('WebhookDeliverer — deliveredCount', () => {
  it('counts what the log cap evicted, so a full log still reads as progress', async () => {
    // `flush()` repeats a round only while this number moves, and stops when it
    // holds still. If eviction subtracted instead of being carried, a busy
    // enough flush would read its own deliveries as "nothing happened" and
    // return with work still due — the exact bug it exists to prevent.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async () => {},
      maxLogEntries: 2,
    })

    for (let i = 0; i < 5; i++) deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    await deliverer.settle()

    expect(deliverer.log()).toHaveLength(2)
    expect(deliverer.droppedLogEntries()).toBe(3)
    expect(deliverer.deliveredCount()).toBe(5)
  })
})

describe('WebhookDeliverer — transport contract', () => {
  it('passes the parsed payload alongside the raw body for inspection', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    const transport = vi.fn(async () => {})
    const deliverer = new WebhookDeliverer({ clock, transport })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })

    clock.advance(0)
    await deliverer.settle()

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ object: 'whatsapp_business_account' }),
        signature: expect.stringMatching(/^sha256=/),
      }),
    )
  })
})
