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

  it('is safe to call twice', async () => {
    const m = await createWamock({ appSecret: 's', start: EPOCH })
    await m.close()
    await expect(m.close()).resolves.toBeUndefined()
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
