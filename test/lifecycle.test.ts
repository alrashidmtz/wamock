import { afterEach, describe, expect, it } from 'vitest'

import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'

/**
 * Resource lifecycle.
 *
 * These cover the failure mode nobody writes a test for until it bites: work
 * that outlives the object that owns it. In a suite, that means one test's
 * webhooks arriving during the next one — which surfaces as flakiness people
 * blame on their own code, because the mock looks like it was shut down.
 */

const EPOCH = 1_750_000_000_000

let mock: Wamock | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

describe('close() stops everything it started', () => {
  it('delivers nothing after close(), even to a slow receiver', async () => {
    // The reproduction: a receiver that takes a moment (any real app does),
    // deliveries already in flight, and a caller that closes without settling.
    // Before the fix, those deliveries landed after close() had resolved.
    let closed = false
    let deliveredAfterClose = 0

    const m = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: async () => {
        await new Promise((r) => setTimeout(r, 40))
        if (closed) deliveredAfterClose++
      },
    })

    await m.inbound({ from: '5215555000001', text: 'hola' })
    await m.send({ to: '5215555000001', text: 'buenas' })
    m.engine.clock.advance(60_000)

    await m.close()
    closed = true
    await new Promise((r) => setTimeout(r, 200))

    expect(deliveredAfterClose).toBe(0)
  })

  it('cancels deliveries that were scheduled but had not fired', async () => {
    let delivered = 0
    const m = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: () => {
        delivered++
      },
    })

    await m.inbound({ from: '5215555000001', text: 'hola' })
    await m.send({ to: '5215555000001', text: 'buenas' })
    // Statuses are queued but the clock has not reached them.

    await m.close()
    // Advancing a closed mock must not resurrect them.
    m.engine.clock.advance(60_000)
    await new Promise((r) => setTimeout(r, 50))

    expect(delivered).toBe(1) // the inbound only
  })

  it('returns even when a receiver never resolves', async () => {
    // Awaiting in-flight deliveries means awaiting USER code, which wamock
    // does not control. An onWebhook that hangs — a lock, a pending fetch, a
    // forgotten await — would otherwise hang close() forever, and a hang leaves
    // nothing to read. Bounded: a late delivery beats a wedged test run.
    const m = await createWamock({
      appSecret: 's',
      start: EPOCH,
      settleTimeoutMs: 100,
      onWebhook: () => new Promise(() => {}),
    })

    await m.inbound({ from: '5215555000001', text: 'hola' })

    const started = Date.now()
    await m.close()

    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('still waits for a receiver that finishes promptly', async () => {
    // The bound must not turn into "give up immediately" — the whole point of
    // the wait is that ordinary receivers get to finish.
    let finished = false
    const m = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: async () => {
        await new Promise((r) => setTimeout(r, 30))
        finished = true
      },
    })

    await m.inbound({ from: '5215555000001', text: 'hola' })
    await m.close()

    expect(finished).toBe(true)
  })

  it('is safe to call twice', async () => {
    const m = await createWamock({ appSecret: 's', start: EPOCH })
    await m.close()
    await expect(m.close()).resolves.toBeUndefined()
  })
})

describe('replying from inside a webhook handler', () => {
  it('does not deadlock — the most natural test pattern there is', async () => {
    // "When a message arrives, reply" is what every integration test does, and
    // it used to hang: inbound() waits for the handler, and the handler's
    // send() waits for the same drain from inside it. The shipped vitest
    // example was written this way and had never been run.
    let mock: Wamock
    mock = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: async (delivery) => {
        const value = JSON.parse(delivery.body).entry[0].changes[0].value
        if (!value.messages) return
        await mock.send({ to: value.messages[0].from, text: `You said: ${value.messages[0].text.body}` })
      },
    })

    await mock.inbound({ from: '5215555000001', text: 'hola' })

    mock.expectSent({ to: '5215555000001', text: 'You said: hola' })
    await mock.close()
  })

  it('survives duplicate deliveries whose handlers both reply', async () => {
    // Under at-least-once, the same inbound arrives twice and BOTH copies run
    // the handler. Each reply waited for the drain the other was holding —
    // mutual re-entrancy — so the call burned the whole settle timeout doing
    // nothing. A nested flush now defers to the outer one.
    let mock: Wamock
    mock = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: async (delivery) => {
        const value = JSON.parse(delivery.body).entry[0].changes[0].value
        if (!value.messages) return
        await mock.send({ to: value.messages[0].from, text: 'reply' })
      },
    })
    mock.scenario({ duplicateWebhooks: true })

    const started = Date.now()
    await mock.inbound({ from: '5215555000001', text: 'hola' })

    expect(Date.now() - started).toBeLessThan(2_000)
    expect(mock.messages().length).toBeGreaterThan(0)
    await mock.close()
  })

  it('still delivers the statuses for a reply sent from the handler', async () => {
    const statuses: string[] = []
    let mock: Wamock
    mock = await createWamock({
      appSecret: 's',
      start: EPOCH,
      onWebhook: async (delivery) => {
        const value = JSON.parse(delivery.body).entry[0].changes[0].value
        if (value.statuses) {
          statuses.push(value.statuses[0].status)
          return
        }
        await mock.send({ to: value.messages[0].from, text: 'reply' })
      },
    })

    await mock.inbound({ from: '5215555000001', text: 'hola' })
    await mock.time.advance(60_000)

    expect(statuses).toEqual(['sent', 'delivered'])
    await mock.close()
  })
})

describe('the Graph interceptor can be tied to the mock', () => {
  it('installs on request and restores on close()', async () => {
    // Forgetting restore() leaves the global fetch patched for every later
    // test. Binding it to the mock's lifetime removes that footgun for the
    // common case.
    const before = globalThis.fetch

    const m = await createWamock({ appSecret: 's', start: EPOCH, interceptGraph: true })
    expect(globalThis.fetch).not.toBe(before)

    await m.close()

    expect(globalThis.fetch).toBe(before)
  })

  it('routes a hardcoded Graph call to the mock while installed', async () => {
    mock = await createWamock({ appSecret: 's', start: EPOCH, interceptGraph: true })
    await mock.inbound({ from: '5215555000001', text: 'hola' })

    const res = await fetch(`https://graph.facebook.com/v19.0/${mock.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: '5215555000001',
        type: 'text',
        text: { body: 'hi' },
      }),
    })

    expect(res.status).toBe(200)
    expect(mock.messages()).toHaveLength(1)
  })

  it('leaves the global fetch alone when not requested', async () => {
    const before = globalThis.fetch
    mock = await createWamock({ appSecret: 's', start: EPOCH })
    expect(globalThis.fetch).toBe(before)
  })
})
