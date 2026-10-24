import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'
import { createServer } from '../src/server.js'

/**
 * The control API delivers what it triggers, before it answers (#4).
 *
 * A webhook with no delay of its own is scheduled at the current instant, and a
 * frozen clock never reaches an instant by itself. The library helpers have
 * always closed that gap; the HTTP door did not — so a control call changed
 * state, returned 200, and announced nothing. Three signals said it worked and
 * the one that mattered stayed silent.
 *
 * These tests go through `mock.baseUrl` with plain `fetch`, exactly as the
 * field report did. Not one of them calls `advance()`, and that is the point.
 */

const EPOCH = 1_750_000_000_000

/**
 * For tests that a call never waits on its own delivery: a settle budget far
 * past the test's own timeout. A call that waited on itself would sit out
 * the whole minute, so the test times out and fails every time; one that
 * does not finishes in milliseconds. No wall-clock threshold to miss on a
 * loaded CI runner.
 */
const SELF_WAIT_MS = 60_000
const SELF_WAIT_TEST_MS = 15_000
const CUSTOMER = '5215555000001'

interface Change {
  field: string
  value: { statuses?: { status: string }[] }
}

let mock: Wamock
let fields: string[]
/** The `status` of every delivery receipt that arrived, in order. */
let statuses: string[]

beforeEach(async () => {
  fields = []
  statuses = []
  mock = await createWamock({
    appSecret: 'app-secret',
    start: EPOCH,
    // Deliberately async. A real receiver writes to a queue or a database
    // before it returns, and "the timer fired" is not "the webhook landed" —
    // a synchronous receiver hides the whole gap these tests are about.
    onWebhook: async (delivery) => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      const changes: Change[] = JSON.parse(delivery.body).entry.flatMap(
        (entry: { changes: Change[] }) => entry.changes,
      )
      for (const change of changes) {
        fields.push(change.field)
        for (const status of change.value.statuses ?? []) statuses.push(status.status)
      }
    },
  })
})

afterEach(async () => {
  await mock.close()
})

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${mock.baseUrl}${path}`, { method: 'POST', body: JSON.stringify(body) })

/** Everything that arrived, minus the `messages` traffic each test sets up. */
const changes = (): string[] => fields.filter((field) => field !== 'messages')

describe('the control API delivers before it answers', () => {
  it('announces a messaging limit change', async () => {
    const res = await post('/__mock/tier', { tier: 'TIER_2K' })

    expect(res.status).toBe(200)
    expect(changes()).toEqual(['business_capability_update'])
  })

  it('announces a template transition', async () => {
    await mock.approveTemplate({ name: 'recordatorio', language: 'es_MX' })
    fields.length = 0

    const res = await post('/__mock/templates/recordatorio/es_MX/transition', { to: 'PAUSED' })

    expect(res.status).toBe(200)
    expect(changes()).toEqual(['message_template_status_update'])
  })

  it('delivers an inbound message', async () => {
    const res = await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })

    expect(res.status).toBe(200)
    expect(fields).toEqual(['messages'])
  })

  it('delivers a forced status', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    const sent = await mock.send({ to: CUSTOMER, text: 'buenas' })
    statuses.length = 0

    const res = await post('/__mock/statuses', { id: sent.id, status: 'read' })

    expect(res.status).toBe(200)
    expect(statuses).toEqual(['read'])
  })

  it('has already delivered by the time /__mock/time/advance answers', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    await mock.send({ to: CUSTOMER, text: 'buenas' })
    statuses.length = 0

    // `sent` and `delivered` are due at +50ms and +500ms, so this is the
    // endpoint that makes them fire. It used to move the clock and answer
    // without waiting for the deliveries it had just kicked off.
    const res = await post('/__mock/time/advance', { ms: 60_000 })

    expect(res.status).toBe(200)
    expect(statuses).toEqual(['sent', 'delivered'])
  })

  it('agrees with the library helper it mirrors', async () => {
    await mock.approveTemplate({ name: 'gemelo', language: 'es_MX' })
    fields.length = 0

    await mock.transitionTemplate({ name: 'gemelo', language: 'es_MX', to: 'PAUSED' })
    const viaHelper = [...changes()]
    fields.length = 0

    await post('/__mock/templates/gemelo/es_MX/transition', { to: 'APPROVED' })

    // The bug existed because only one of these two doors was ever exercised.
    expect(changes()).toEqual(viaHelper)
  })
})

describe('what the flush must NOT do', () => {
  it('leaves delivery statuses waiting for the clock, as designed', async () => {
    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola' })
    fields.length = 0

    // Straight at the Graph route, so no control-API flush is involved. Meta
    // does not answer a send with its statuses either, and a mock that
    // delivered them here would hide every ordering bug it exists to expose.
    await fetch(`${mock.baseUrl}/v23.0/${mock.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'text',
        text: { body: 'buenas' },
      }),
    })

    expect(statuses).toEqual([])

    await mock.time.advance(60_000)
    expect(statuses).toEqual(['sent', 'delivered'])
  })

  it('does not report a stale delivery count on the way to draining', async () => {
    // Enqueued through the raw engine, the one door with no flush of its own,
    // so /__mock/state meets a queue it has to drain before it can be honest.
    // Answering from a snapshot taken first would put the readout one delivery
    // behind — the same class of lie as the Set that serialized to `{}`.
    mock.engine.simulateInbound({
      from: CUSTOMER,
      message: { type: 'text', text: { body: 'hola' } },
    })

    const state = (await (await fetch(`${mock.baseUrl}/__mock/state`)).json()) as {
      webhooksDelivered: number
    }

    expect(state.webhooksDelivered).toBe(fields.length)
    expect(fields).toEqual(['messages'])
  })

  it('does not make a Graph send wait on the webhook receiver', async () => {
    // Meta answers a send immediately; it does not hand your endpoint anything
    // first. A Graph route that flushed would take as long as the slowest
    // receiver — the exact latency bug this mock is supposed to expose.
    // Queued through the raw engine so there IS something due for a stray
    // flush to pick up.
    mock.engine.simulateInbound({
      from: CUSTOMER,
      message: { type: 'text', text: { body: 'hola' } },
    })

    await fetch(`${mock.baseUrl}/v23.0/${mock.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: CUSTOMER,
        type: 'text',
        text: { body: 'buenas' },
      }),
    })

    expect(fields).toEqual([])
  })

  it('does not make a Graph read wait on the webhook receiver either', async () => {
    // The same rule on the other verb. Covering the write and leaving the read
    // to inference is the mistake that produced #4: one door exercised, the
    // other free to drift.
    mock.engine.simulateInbound({
      from: CUSTOMER,
      message: { type: 'text', text: { body: 'hola' } },
    })

    await fetch(`${mock.baseUrl}/v23.0/${mock.phoneNumberId}?fields=quality_rating`)

    expect(fields).toEqual([])
  })

  it('does not deliver a webhook twice', async () => {
    await post('/__mock/tier', { tier: 'TIER_2K' })
    // A second flush of the same already-drained queue must be a no-op — the
    // round loop stops as soon as a round delivers nothing.
    await mock.time.advance(0)

    expect(changes()).toEqual(['business_capability_update'])
  })
})

/**
 * The round loop only makes sense on a frozen clock, where nothing else will
 * ever fire a due timer. A live clock has a background tick doing exactly that,
 * so repeating rounds there counts unrelated concurrent deliveries as progress
 * and never converges — which turned a valid control call into a 400 blaming
 * the receiver for a loop it was not in.
 */
describe('flush rounds', () => {
  /**
   * A receiver that answers every webhook with another one, asynchronously.
   *
   * The await is what makes this the flush's problem. Re-enqueueing
   * synchronously never escapes the drain that is running, so the clock's own
   * iteration guard catches it first; a real receiver awaits something before
   * it reacts, and lands the new work after `advance()` has already returned.
   */
  const pingPong = (engine: WamockEngine): void => {
    engine.deliverer.setTransport(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      engine.setTier(engine.state.defaultPhoneNumberId, 'TIER_2K')
    })
  }

  it('gives up on a frozen clock, naming the runaway receiver', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    pingPong(engine)
    engine.setTier(engine.state.defaultPhoneNumberId, 'TIER_2K')

    await expect(engine.flush()).rejects.toThrow(/exceeded 100 rounds/)
    // One webhook a round: the cap is 100 rounds, not 101.
    expect(engine.deliverer.deliveredCount()).toBe(100)
  })

  it('takes a single round on a live clock, whose tick fires the rest', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'live' })
    pingPong(engine)
    engine.setTier(engine.state.defaultPhoneNumberId, 'TIER_2K')

    await expect(engine.flush()).resolves.toBeUndefined()
  })

  it('honours the caller’s settle budget on the HTTP path too', async () => {
    // The wait a control call now makes is on YOUR receiver, so the budget has
    // to reach the server — through createWamock, into createServer, down to
    // the hook. Anywhere that chain drops it, the 5s default silently applies
    // and a stuck receiver holds the request for ten times as long as asked.
    const stuck = await createWamock({
      appSecret: 's',
      start: EPOCH,
      settleTimeoutMs: 250,
      onWebhook: () => new Promise(() => {}),
    })

    // What reaches the engine is the contract here; that a flush keeps to the
    // budget it is given is pinned with fake timers below. Timing the request
    // measured runner load.
    const flush = vi.spyOn(stuck.engine, 'flush')
    try {
      const res = await fetch(`${stuck.baseUrl}/__mock/tier`, {
        method: 'POST',
        body: JSON.stringify({ tier: 'TIER_2K' }),
      })

      expect(res.status).toBe(200)
      expect(flush).toHaveBeenCalled()
      for (const [timeoutMs] of flush.mock.calls) expect(timeoutMs).toBe(250)

      // GETs flush in another hook, before answering: the budget must reach
      // that one too.
      flush.mockClear()
      expect((await fetch(`${stuck.baseUrl}/__mock/state`)).status).toBe(200)
      expect(flush).toHaveBeenCalled()
      for (const [timeoutMs] of flush.mock.calls) expect(timeoutMs).toBe(250)
    } finally {
      flush.mockRestore()
      await stuck.close()
    }
  })

  // Left to Stryker in startBudget: `unref?.()`, `if (timer)` and the
  // `cancel()` in flush's finally. The timer is unref'd and always set, and an
  // uncleared one only resolves a promise nobody awaits any more.
  it('keeps a flush to exactly the budget it is given, however stuck the receiver', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: () => new Promise(() => {}) })
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      let done = false
      const flushing = engine.flush(250).then(() => {
        done = true
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await flushing
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers a control GET within one budget, not one per hook', async () => {
    // A read flushes before it answers; flushing again after it did doubled
    // the wait a stuck receiver could impose.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: () => new Promise(() => {}) })
    const app = createServer(engine, { settleTimeoutMs: 250 })
    try {
      await app.ready()
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      let answered = false
      const reading = app.inject({ method: 'GET', url: '/__mock/state' }).then((res) => {
        answered = true
        return res
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(answered).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect((await reading).statusCode).toBe(200)
      expect(answered).toBe(true)

      // A path that does not exist runs the hooks again on its way to the
      // 404: still one budget.
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'otra' } } })
      let missed = false
      const missing = app.inject({ method: 'GET', url: '/__mock/typo' }).then((res) => {
        missed = true
        return res
      })
      await vi.advanceTimersByTimeAsync(249)
      expect(missed).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(missed).toBe(true)
      expect((await missing).statusCode).toBe(404)
    } finally {
      vi.useRealTimers()
      await app.close()
    }
  })

  it('ends at the budget even when each stuck delivery sets off another', async () => {
    // A receiver that answers every webhook with a new message and then hangs:
    // every round starts more work, so only the budget can end the call, and
    // it must end it cleanly rather than spin into the 100-round error.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const engine: WamockEngine = new WamockEngine({
        appSecret: 's',
        mode: 'frozen',
        start: EPOCH,
        transport: async () => {
          await Promise.resolve()
          engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'again' } } })
          await new Promise(() => {})
        },
      })
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      const flushing = engine.flush(250)
      await vi.advanceTimersByTimeAsync(250)
      await expect(flushing).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes its timeout back down once settling beats it', async () => {
    // The bound is a race between settling and a timer, and the winner does
    // not cancel the loser on its own. Every helper flushes, so a timeout left
    // armed each time is a 5-second timer per call — unref'd, so nothing hangs
    // and nothing complains, which is exactly why it needs asserting.
    vi.useFakeTimers()
    try {
      const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })

      await engine.settleWithin(5_000)

      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

let secondGate: Promise<void> = Promise.resolve()

describe('helpers waiting on one another', () => {
  async function blockable() {
    const { createWamock } = await import('../src/lib.js')
    const bodies: string[] = []
    let gate: Promise<void> | undefined
    let open: () => void = () => {}
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      onWebhook: async (d) => {
        const text: string | undefined = JSON.parse(d.body).entry[0]?.changes[0]?.value.messages?.[0]?.text?.body
        if (text === 'old') await gate
        if (text === 'second') await secondGate
        if (text) bodies.push(text)
      },
    })
    const block = () => {
      gate = new Promise<void>((resolve) => (open = resolve))
    }
    return { mock, bodies, block, release: () => open() }
  }

  it('delivers work a reset left behind while a flush was waiting', async () => {
    const { mock, bodies, block, release } = await blockable()
    try {
      block()
      const old = mock.inbound({ from: '5215555000001', text: 'old' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      // reset() waits for the old delivery in flight, so it is not awaited
      // until the receiver is released.
      const reset = mock.reset()
      const fresh = mock.inbound({ from: '5215555000001', text: 'new' })
      release()
      await Promise.all([old, reset, fresh])
      expect(bodies).toContain('new')
    } finally {
      await mock.close()
    }
  })

  it('makes time.advance wait for what it set off, not for another helper’s delivery', async () => {
    const { mock, bodies, block, release } = await blockable()
    let openSecond: () => void = () => {}
    const second = new Promise<void>((resolve) => (openSecond = resolve))
    try {
      block()
      const old = mock.inbound({ from: '5215555000001', text: 'old' })
      await new Promise((resolve) => setTimeout(resolve, 10))

      // A message the advance will deliver, whose receiver is slow too.
      const slow = mock.engine.simulateInbound({ from: '5215555000002', message: { type: 'text', text: { body: 'second' } } })
      void slow
      let advanced = false
      secondGate = second
      const advance = mock.time.advance(0).then(() => (advanced = true))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(advanced).toBe(false)

      // Done once ITS delivery is, while the other helper's is still held.
      openSecond()
      await advance
      expect(bodies).toEqual(['second'])
      release()
      await old
      expect(bodies).toEqual(['second', 'old'])
    } finally {
      await mock.close()
    }
  })
})

describe('time.advance from inside a handler', () => {
  it('returns at once, leaving the running flush to deliver what it set off', async () => {
    const { createWamock } = await import('../src/lib.js')
    const seen: string[] = []
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      settleTimeoutMs: SELF_WAIT_MS,
      onWebhook: async (d) => {
        const field = d.payload.entry[0]!.changes[0]!.field
        seen.push(field)
        // Awaiting something first, as a real handler does: by then its own
        // delivery is in flight, and waiting on in-flight work would wait on
        // itself until the timeout.
        if (field === 'messages' && seen.length === 1) {
          await new Promise((resolve) => setTimeout(resolve, 0))
          await mock.time.advance(1000)
        }
      },
    })
    try {
      await mock.inbound({ from: '5215555000001', text: 'hola' })
    } finally {
      await mock.close()
    }
  }, SELF_WAIT_TEST_MS)
})

describe('a handler never waits for its own delivery', () => {
  it('lets a status handler fired by time.advance call time.advance itself', async () => {
    const { createWamock } = await import('../src/lib.js')
    let handled = false
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      settleTimeoutMs: SELF_WAIT_MS,
      onWebhook: async (d) => {
        const value = JSON.parse(d.body).entry[0].changes[0].value
        if (value.statuses?.[0]?.status !== 'sent') return
        await new Promise((resolve) => setTimeout(resolve, 0))
        await mock.time.advance(0)
        handled = true
      },
    })
    try {
      await mock.inbound({ from: '5215555000001', text: 'hola' })
      await mock.send({ to: '5215555000001', text: 'respuesta' })
      await mock.time.advance(50)
      expect(handled).toBe(true)
    } finally {
      await mock.close()
    }
  }, SELF_WAIT_TEST_MS)

  it('still waits for other deliveries, even from work a finished delivery left behind', async () => {
    const { createWamock } = await import('../src/lib.js')
    let open: () => void = () => {}
    const gate = new Promise<void>((resolve) => (open = resolve))
    let deferred: Promise<void> | undefined
    let advanced = false
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      onWebhook: async (d) => {
        const value = JSON.parse(d.body).entry[0].changes[0].value
        if (value.messages?.[0]) {
          // Left running after this delivery finishes.
          deferred = new Promise<void>((resolve) => setTimeout(resolve, 20)).then(async () => {
            await mock.time.advance(50)
            advanced = true
          })
          return
        }
        if (value.statuses?.[0]?.status === 'sent') await gate
      },
    })
    try {
      await mock.inbound({ from: '5215555000001', text: 'hola' })
      void mock.send({ to: '5215555000001', text: 'respuesta' })
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(advanced).toBe(false)
      open()
      await deferred
      expect(advanced).toBe(true)
    } finally {
      await mock.close()
    }
  })
})

describe('waits only point forward', () => {
  it('lets duplicate deliveries both call time.advance without waiting on each other', async () => {
    const { createWamock } = await import('../src/lib.js')
    let done = 0
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      settleTimeoutMs: SELF_WAIT_MS,
      onWebhook: async (d) => {
        if (!JSON.parse(d.body).entry[0].changes[0].value.messages) return
        await new Promise((resolve) => setTimeout(resolve, 0))
        await mock.time.advance(0)
        done++
      },
    })
    try {
      await mock.scenario({ duplicateWebhooks: true })
      await mock.inbound({ from: '5215555000001', text: 'hola' })
      expect(done).toBe(2)
    } finally {
      await mock.close()
    }
  }, SELF_WAIT_TEST_MS)

  it('answers a receiver that calls the control API mid-delivery without waiting on that delivery', async () => {
    const { WamockEngine } = await import('../src/core/engine.js')
    const { createServer } = await import('../src/server.js')
    let app: Awaited<ReturnType<typeof createServer>> | undefined
    let answered = false
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: async () => {
        await app!.inject({ method: 'POST', url: '/__mock/time/advance', payload: '{"ms":1}' })
        answered = true
      },
    })
    app = createServer(engine, { settleTimeoutMs: SELF_WAIT_MS })
    await app.ready()
    try {
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      engine.clock.advance(0)
      await engine.settle()
      expect(answered).toBe(true)
      expect(engine.deliverer.log().map((r) => r.ok)).toEqual([true])
    } finally {
      await app.close()
    }
  }, SELF_WAIT_TEST_MS)
})

describe('a control request and the deliveries it set off', () => {
  async function server() {
    const { WamockEngine } = await import('../src/core/engine.js')
    const { createServer } = await import('../src/server.js')
    const gates = new Map<string, Promise<void>>()
    const opens = new Map<string, () => void>()
    const hold = (text: string) => gates.set(text, new Promise<void>((resolve) => opens.set(text, resolve)))
    const done: string[] = []
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: async (d) => {
        const text: string | undefined = JSON.parse(d.body).entry[0].changes[0].value.messages?.[0]?.text?.body
        if (text) await gates.get(text)
        if (text) done.push(text)
      },
    })
    const app = createServer(engine, { settleTimeoutMs: 2000 })
    return { engine, app, hold, open: (text: string) => opens.get(text)!(), done }
  }

  it('waits for the delivery it fired even while another request’s flush is running', async () => {
    const { engine, app, hold, open, done } = await server()
    await app.ready()
    try {
      hold('first')
      hold('second')
      const first = app.inject({ method: 'POST', url: '/__mock/inbound', payload: '{"from":"5215555000001","text":"first"}' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      // Due now; the time/advance request is what fires it.
      engine.simulateInbound({ from: '5215555000002', message: { type: 'text', text: { body: 'second' } } })
      let answered = false
      const second = app
        .inject({ method: 'POST', url: '/__mock/time/advance', payload: '{"ms":1}' })
        .then(() => (answered = true))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(answered).toBe(false)
      open('second')
      await second
      expect(done).toEqual(['second'])
      open('first')
      await first
    } finally {
      await app.close()
    }
  })

  it('reports in GET /__mock/state the delivery that started as the request arrived', async () => {
    const { engine, app, hold, open } = await server()
    // Runs after wamock's own onRequest hook: the attempt starts once the
    // request's starting point is taken, and before its flush. Its receiver
    // is slow, so a snapshot that did not wait for it would read 0.
    app.addHook('onRequest', async (request) => {
      if (request.url === '/__mock/state') {
        hold('hola')
        setTimeout(() => open('hola'), 20)
        engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
        engine.clock.advance(0)
      }
    })
    await app.ready()
    try {
      const state = await app.inject({ method: 'GET', url: '/__mock/state' })
      expect(state.json().webhooksDelivered).toBe(1)
    } finally {
      await app.close()
    }
  })
})

describe('a receiver that answers every message with another', () => {
  it('fails with the clock’s iteration cap instead of hanging', async () => {
    // Each handler calls mock.inbound, whose message the clock fires inside
    // the same drain, until the clock's own iteration cap stops it. That
    // each of those calls waits without scanning every delivery in flight
    // (once 45s or more instead of about two) is pinned by counting scans in
    // delivery.test.ts: a timer here failed on loaded CI runners.
    const { createWamock } = await import('../src/lib.js')
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      onWebhook: async (d) => {
        if (!JSON.parse(d.body).entry[0].changes[0].value.messages) return
        await mock.inbound({ from: '5215555000001', text: 'again' })
      },
    })
    try {
      await expect(mock.inbound({ from: '5215555000001', text: 'start' })).rejects.toThrow(/timer iterations/)
    } finally {
      await mock.close()
    }
  }, 60_000)
})

describe('earlier deliveries do not use up a later call’s rounds', () => {
  it('answers GET /__mock/state when 105 earlier deliveries finish one by one', async () => {
    const { WamockEngine } = await import('../src/core/engine.js')
    const { createServer } = await import('../src/server.js')
    const releases: Array<() => void> = []
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: () => new Promise<void>((resolve) => releases.push(resolve)),
    })
    const app = createServer(engine, { settleTimeoutMs: 2000 })
    await app.ready()
    try {
      for (let i = 0; i < 105; i++) {
        engine.simulateInbound({ from: `52155550${String(i).padStart(5, '0')}`, message: { type: 'text', text: { body: 'x' } } })
      }
      engine.clock.advance(0)
      const state = app.inject({ method: 'GET', url: '/__mock/state' })
      // One per tick: each completion would have counted as a round.
      for (const release of releases) {
        release()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect((await state).statusCode).toBe(200)
    } finally {
      await app.close()
    }
  })
})
