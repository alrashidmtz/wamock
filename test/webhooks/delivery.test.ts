import { describe, expect, it, vi } from 'vitest'

import { VirtualClock } from '../../src/core/clock.js'
import { WebhookDeliverer } from '../../src/webhooks/delivery.js'
import { DeliveryCancelled } from '../../src/webhooks/transport.js'
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
    user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
    sentTo: 'phone',
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
      user: { waId: '5215555000001', userId: 'MX.1', phoneShared: true },
      sentTo: 'phone',
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
    // The count is of everything attempted, so a capped log must carry what it
    // evicted rather than lose it: 5 deliveries are 5, not the 2 still kept.
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
      // The attempt, so a transport that waits can ask whether it still counts.
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    )
  })
})

describe('WebhookDeliverer — retries, as Meta retries', () => {
  const MINUTE = 60 * 1000
  const DAY = 24 * 60 * MINUTE

  function failingFor(attempts: number) {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let calls = 0
    const bodies: string[] = []
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async (delivery) => {
        calls++
        bodies.push(delivery.body + delivery.signature)
        if (calls <= attempts) throw new Error('receiver returned HTTP 500')
      },
    })
    // A minute at a time, letting each attempt settle, the way time passes
    // for a real receiver.
    const elapse = async (ms: number) => {
      for (let t = 0; t < ms; t += MINUTE) {
        clock.advance(MINUTE)
        await deliverer.settle()
      }
    }
    return { clock, deliverer, elapse, calls: () => calls, bodies }
  }

  const start = async (deliverer: WebhookDeliverer, clock: VirtualClock) => {
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    await deliverer.settle()
  }

  it('retries a failed delivery until it succeeds, with the same body and signature', async () => {
    const { clock, deliverer, elapse, calls, bodies } = failingFor(2)
    await start(deliverer, clock)
    expect(calls()).toBe(1)

    await elapse(DAY)
    expect(calls()).toBe(3)
    expect(new Set(bodies).size).toBe(1)
    expect(deliverer.log().map((r) => r.ok)).toEqual([false, false, true])
  })

  it('backs off: the first retry a minute later, each gap double the last', async () => {
    const { clock, deliverer, elapse } = failingFor(Number.POSITIVE_INFINITY)
    await start(deliverer, clock)
    await elapse(DAY)
    const times = deliverer.log().map((r) => r.deliveredAt - EPOCH)
    expect(times.slice(0, 5)).toEqual([0, 1, 3, 7, 15].map((m) => m * MINUTE))
  })

  it('gives up after 7 days', async () => {
    const { clock, deliverer, elapse, calls } = failingFor(Number.POSITIVE_INFINITY)
    await start(deliverer, clock)
    await elapse(7 * DAY)
    const within = calls()
    // Still trying days later: the last attempt inside the 7 days is the one
    // 8191 minutes (about 5.7 days) after the first; the next would be past.
    expect(deliverer.log().at(-1)!.deliveredAt - EPOCH).toBe(8191 * MINUTE)
    await elapse(7 * DAY)
    expect(calls()).toBe(within)
  })

  it('cancels pending retries on clear(), including one whose attempt was in flight', async () => {
    const { clock, deliverer, elapse, calls } = failingFor(Number.POSITIVE_INFINITY)
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    deliverer.clear()
    await deliverer.settle()
    await elapse(DAY)
    expect(calls()).toBe(1)
  })

  it('does not record an attempt that settles after clear()', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let release: () => void = () => {}
    const deliverer = new WebhookDeliverer({
      clock,
      transport: () => new Promise<void>((resolve) => (release = resolve)),
    })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    deliverer.clear()
    release()
    await deliverer.settle()
    expect(deliverer.log()).toEqual([])
  })

  it('counts as progress only attempts from the caller’s starting point on', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let release: () => void = () => {}
    const deliverer = new WebhookDeliverer({
      clock,
      transport: () => new Promise<void>((resolve) => (release = resolve)),
    })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)

    // An earlier attempt finishing is not this caller's progress...
    const since = deliverer.nextAttempt()
    const before = deliverer.progressSince(since)
    release()
    await deliverer.settle()
    expect(deliverer.progressSince(since)).toBe(before)

    // ...but one of its own starting, and a reset, are.
    deliverer.enqueue(samplePayload(), { appSecret: SECRET })
    clock.advance(0)
    expect(deliverer.progressSince(since)).not.toBe(before)
    const afterStart = deliverer.progressSince(since)
    deliverer.clear()
    expect(deliverer.progressSince(since)).not.toBe(afterStart)
  })

  it('keeps the first reason an attempt stopped being current', async () => {
    // Unsubscribed when the transport looked, subscribed again before it
    // threw: the webhook ended at the look, and the re-subscription must not
    // bring it back as a reroute.
    // Subscribing again with a different callback makes the state read as
    // "moved", which would reroute: only the first observation may decide.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let state: 'first' | 'off' | 'elsewhere' = 'first'
    let calls = 0
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async (_delivery, attempt) => {
        calls++
        state = 'off'
        const current = attempt!.isCurrent()
        state = 'elsewhere'
        attempt!.isCurrent()
        if (!current) throw new DeliveryCancelled()
      },
    })
    const route = () =>
      state === 'off' ? undefined : state === 'elsewhere' ? { callback: { url: 'http://b/hook', verifyToken: 'vt' } } : {}
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, route })
    clock.advance(0)
    await deliverer.settle()
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000)
      await deliverer.settle()
    }
    expect(calls).toBe(1)
    expect(deliverer.log()).toEqual([])
  })

  it('ends a moved webhook whose app then unsubscribed, rather than rerouting it', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let state: 'a' | 'b' | 'off' = 'a'
    let calls = 0
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async (_delivery, attempt) => {
        calls++
        state = 'b'
        const current = attempt!.isCurrent()
        state = 'off'
        if (!current) throw new DeliveryCancelled()
      },
    })
    const at = (host: string) => ({ callback: { url: `http://${host}/hook`, verifyToken: 'vt' } })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, route: () => (state === 'off' ? undefined : at(state)) })
    clock.advance(0)
    await deliverer.settle()
    state = 'b'
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000)
      await deliverer.settle()
    }
    expect(calls).toBe(1)
  })

  it('keeps ended once seen, even if a later look finds the callback merely moved', async () => {
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let state: 'a' | 'b' | 'off' = 'a'
    let calls = 0
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async (_delivery, attempt) => {
        calls++
        state = 'b'
        attempt!.isCurrent()
        state = 'off'
        attempt!.isCurrent()
        state = 'b'
        throw new DeliveryCancelled()
      },
    })
    const at = (host: string) => ({ callback: { url: `http://${host}/hook`, verifyToken: 'vt' } })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, route: () => (state === 'off' ? undefined : at(state)) })
    clock.advance(0)
    await deliverer.settle()
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000)
      await deliverer.settle()
    }
    expect(calls).toBe(1)
  })

  // Mutants left alive on purpose: `isCurrent`'s `cause === 'ended'` shortcut
  // only skips a look whose answer cannot change `ended`; `progressSince` and
  // the generation counter only need to change, not in which direction; and
  // `hasInFlight`'s early return is the fast path control-flush.test.ts pins
  // by timing.
  it('keeps a moved attempt moved when the callback moves back, and still delivers it there', async () => {
    // The first look decides: a callback changed and changed back is a move,
    // so this attempt is cancelled and the webhook goes out again, rerouted,
    // to where the WABA points now. It is never lost.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let state: 'a' | 'b' = 'a'
    const looks: boolean[] = []
    const attempts: Array<{ url: string | undefined; rerouted: boolean }> = []
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async (delivery, attempt) => {
        attempts.push({ url: delivery.callback?.url, rerouted: attempt?.rerouted === true })
        if (attempts.length > 1) return
        state = 'b'
        looks.push(attempt!.isCurrent())
        state = 'a'
        looks.push(attempt!.isCurrent())
        throw new DeliveryCancelled()
      },
    })
    deliverer.enqueue(samplePayload(), {
      appSecret: SECRET,
      route: () => ({ callback: { url: `http://${state}/hook`, verifyToken: 'vt' } }),
    })
    clock.advance(0)
    await deliverer.settle()
    clock.advance(0)
    await deliverer.settle()
    expect(looks).toEqual([false, false])
    expect(attempts).toEqual([
      { url: 'http://a/hook', rerouted: false },
      { url: 'http://a/hook', rerouted: true },
    ])
  })

  it('drops, without resending, an attempt a transport cancels while it is still current', async () => {
    // A custom transport may cancel by throwing DeliveryCancelled: nothing
    // logged, nothing retried, and with nothing moved, nothing rerouted.
    const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
    let calls = 0
    const deliverer = new WebhookDeliverer({
      clock,
      transport: async () => {
        calls++
        throw new DeliveryCancelled()
      },
    })
    deliverer.enqueue(samplePayload(), { appSecret: SECRET, route: () => ({}) })
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000)
      await deliverer.settle()
    }
    expect(calls).toBe(1)
    expect(deliverer.log()).toEqual([])
  })
})
