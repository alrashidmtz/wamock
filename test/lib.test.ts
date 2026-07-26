import { afterEach, describe, expect, it } from 'vitest'

import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'

/**
 * Library mode (spec §8) — the DX that decides whether anyone uses this.
 *
 * The bar: a full inbound → reply → status → expiry cycle inside a test, with
 * no ports, no network, and no waiting. If this is awkward, the mock does not
 * get adopted no matter how faithful it is.
 */

const HOURS = (n: number) => n * 60 * 60 * 1000

let mock: Wamock | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

describe('createWamock — the quickstart shape', () => {
  it('drives a whole conversation with no network', async () => {
    const received: unknown[] = []
    mock = await createWamock({
      appSecret: 'test-secret',
      onWebhook: (delivery) => {
        received.push(delivery.payload)
      },
    })

    await mock.inbound({ from: '5216691112233', text: 'hola' })
    expect(received).toHaveLength(1)

    await mock.send({ to: '5216691112233', text: 'buenas' })
    await mock.time.advance(60_000)

    expect(mock.messages()).toHaveLength(1)
    expect(received.length).toBeGreaterThan(1)
  })

  it('exposes a baseUrl an app can be pointed at', async () => {
    mock = await createWamock({ appSecret: 's' })
    expect(mock.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
  })

  it('answers real HTTP on that baseUrl', async () => {
    // Library mode still runs a server, so the same test can drive an app that
    // only knows how to talk to a URL.
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })

    const res = await fetch(`${mock.baseUrl}/v19.0/${mock.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: '5216691112233',
        type: 'text',
        text: { body: 'hi' },
      }),
    })

    expect(res.status).toBe(200)
    expect(mock.messages()).toHaveLength(1)
  })
})

describe('time control', () => {
  it('expires the 24h window on demand', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })

    await mock.time.advance(HOURS(25))

    await expect(mock.send({ to: '5216691112233', text: 'sigues?' })).rejects.toMatchObject({
      code: 131047,
    })
  })

  it('reports the current virtual time', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_000 })
    await mock.time.advance(500)
    expect(mock.time.now()).toBe(1_500)
  })
})

describe('assertion helpers', () => {
  it('expectSent passes when a matching message went out', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })
    await mock.send({
      to: '5216691112233',
      template: { name: 'recordatorio_24h', language: 'es_MX' },
    })

    expect(() =>
      mock!.expectSent({ type: 'template', name: 'recordatorio_24h', language: 'es_MX' }),
    ).not.toThrow()
  })

  it('expectSent fails loudly, naming what WAS sent', async () => {
    // A bare "assertion failed" sends you to the debugger. Listing the actual
    // traffic usually shows the problem straight away.
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })
    await mock.send({ to: '5216691112233', text: 'buenas' })

    expect(() => mock!.expectSent({ type: 'template', name: 'nope' })).toThrow(/buenas/)
  })

  it('expectSent matches on the recipient', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })
    await mock.send({ to: '5216691112233', text: 'buenas' })

    expect(() => mock!.expectSent({ to: '5216691112233' })).not.toThrow()
    expect(() => mock!.expectSent({ to: '5219999999999' })).toThrow()
  })

  it('expectSent matches on text content', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })
    await mock.send({ to: '5216691112233', text: 'buenas tardes' })

    expect(() => mock!.expectSent({ text: 'buenas tardes' })).not.toThrow()
    expect(() => mock!.expectSent({ text: 'otra cosa' })).toThrow()
  })
})

describe('reset', () => {
  it('returns the mock to its seed state', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })
    await mock.send({ to: '5216691112233', text: 'buenas' })

    await mock.reset()

    expect(mock.messages()).toHaveLength(0)
    // The window is closed again, so a free-form send is refused.
    await expect(mock.send({ to: '5216691112233', text: 'x' })).rejects.toMatchObject({
      code: 131047,
    })
  })
})

describe('scenarios from library mode', () => {
  it('forces the next send to fail', async () => {
    mock = await createWamock({ appSecret: 's' })
    await mock.inbound({ from: '5216691112233', text: 'hola' })
    mock.scenario({ nextError: { code: 130429 } })

    await expect(mock.send({ to: '5216691112233', text: 'x' })).rejects.toMatchObject({
      code: 130429,
    })
  })
})

describe('inbound helpers', () => {
  it('simulates a button tap', async () => {
    const received: Array<Record<string, unknown>> = []
    mock = await createWamock({
      appSecret: 's',
      onWebhook: (d) => {
        received.push(d.payload as unknown as Record<string, unknown>)
      },
    })

    await mock.inbound({ from: '5216691112233', buttonReply: { id: 'yes', title: 'Sí' } })

    const message = (received[0] as never as {
      entry: Array<{ changes: Array<{ value: { messages: Array<Record<string, unknown>> } }> }>
    }).entry[0]!.changes[0]!.value.messages[0]!
    expect(message).toMatchObject({
      type: 'interactive',
      interactive: { button_reply: { id: 'yes' } },
    })
  })
})
