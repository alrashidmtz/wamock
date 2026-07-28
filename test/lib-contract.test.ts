import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { createWamock } from '../src/lib.js'
import type { Wamock } from '../src/lib.js'

/**
 * The public API, pinned.
 *
 * Mutation testing scored `lib.ts` at 54% — the worst module in the codebase,
 * and the only one users actually touch. Two patterns accounted for nearly all
 * of it: `expectSent`'s matching could be loosened without any test noticing,
 * and every constructor option could be dropped on the floor because nothing
 * checked that passing it changed anything.
 *
 * An assertion helper that matches too eagerly is worse than none: it reports
 * success for traffic that never happened.
 */

const HOURS = (n: number) => n * 60 * 60 * 1000
const CUSTOMER = '5216691112233'

let mock: Wamock | undefined
let receiver: FastifyInstance | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
  await receiver?.close()
  receiver = undefined
})

describe('expectSent matches precisely, and rejects everything else', () => {
  async function withOneTemplateSend(): Promise<Wamock> {
    const m = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    await m.approveTemplate({ name: 'recordatorio_24h', language: 'es_MX' })
    await m.send({
      to: CUSTOMER,
      template: { name: 'recordatorio_24h', language: 'es_MX' },
    })
    return m
  }

  it('rejects a different template name', async () => {
    mock = await withOneTemplateSend()
    expect(() => mock!.expectSent({ name: 'otra_plantilla' })).toThrow()
  })

  it('rejects the right name in the wrong language', async () => {
    // The per-language trap, in the assertion helper itself: matching on name
    // alone would make a language bug invisible to the test that should catch it.
    mock = await withOneTemplateSend()
    expect(() => mock!.expectSent({ name: 'recordatorio_24h', language: 'en_US' })).toThrow()
    expect(() => mock!.expectSent({ name: 'recordatorio_24h', language: 'es_MX' })).not.toThrow()
  })

  it('rejects the wrong type', async () => {
    mock = await withOneTemplateSend()
    expect(() => mock!.expectSent({ type: 'text' })).toThrow()
    expect(() => mock!.expectSent({ type: 'template' })).not.toThrow()
  })

  it('requires every criterion to match, not just one', async () => {
    mock = await withOneTemplateSend()
    expect(() => mock!.expectSent({ type: 'template', name: 'nope' })).toThrow()
  })

  it('normalizes the recipient before comparing', async () => {
    mock = await withOneTemplateSend()
    expect(() => mock!.expectSent({ to: `+${CUSTOMER}` })).not.toThrow()
  })

  it('returns the matched message, so callers can assert further', async () => {
    mock = await withOneTemplateSend()
    const match = mock.expectSent({ type: 'template' })
    expect(match.to).toBe(CUSTOMER)
    expect(match.id).toMatch(/^wamid\./)
  })

  it('names the traffic that WAS sent when nothing matches', async () => {
    mock = await withOneTemplateSend()
    // A bare failure sends you to a debugger; the actual traffic usually shows
    // the problem on sight.
    expect(() => mock!.expectSent({ type: 'text' })).toThrow(/recordatorio_24h \(es_MX\)/)
  })

  it('says so plainly when nothing was sent at all', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    expect(() => mock!.expectSent({ type: 'text' })).toThrow(/Nothing was sent/)
  })
})

describe('constructor options actually take effect', () => {
  it('windowMs shortens the service window', async () => {
    // Every option could have been ignored and no test would have failed.
    mock = await createWamock({ appSecret: 's', start: 1_000_000, windowMs: 1_000 })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    await mock.time.advance(999)
    await expect(mock.send({ to: CUSTOMER, text: 'aún abierta' })).resolves.toBeDefined()

    await mock.time.advance(2)
    await expect(mock.send({ to: CUSTOMER, text: 'ya cerrada' })).rejects.toMatchObject({
      code: 131047,
    })
  })

  it('the default window really is 24 hours', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    await mock.time.advance(HOURS(24) - 1)
    await expect(mock.send({ to: CUSTOMER, text: 'x' })).resolves.toBeDefined()

    await mock.time.advance(1)
    await expect(mock.send({ to: CUSTOMER, text: 'x' })).rejects.toMatchObject({ code: 131047 })
  })

  it('phoneNumberId, wabaId and displayPhoneNumber reach the payloads', async () => {
    const bodies: string[] = []
    mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      phoneNumberId: 'PNID_CUSTOM',
      wabaId: 'WABA_CUSTOM',
      displayPhoneNumber: '15559990000',
      onWebhook: (d) => {
        bodies.push(d.body)
      },
    })

    expect(mock.phoneNumberId).toBe('PNID_CUSTOM')
    expect(mock.wabaId).toBe('WABA_CUSTOM')

    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    const payload = JSON.parse(bodies[0]!)
    expect(payload.entry[0].id).toBe('WABA_CUSTOM')
    expect(payload.entry[0].changes[0].value.metadata).toMatchObject({
      phone_number_id: 'PNID_CUSTOM',
      display_phone_number: '+15559990000',
    })
  })

  it('start pins the virtual clock', async () => {
    mock = await createWamock({ appSecret: 's', start: 42_000 })
    expect(mock.time.now()).toBe(42_000)
  })
})

describe('the webhookUrl option', () => {
  it('POSTs to a real receiver with the signature intact', async () => {
    const seen: Array<{ signature: string | undefined; body: string }> = []
    receiver = Fastify()
    receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_r, body, done) => {
      done(null, { raw: body as string })
    })
    receiver.post('/webhook', async (request, reply) => {
      seen.push({
        signature: request.headers['x-hub-signature-256'] as string | undefined,
        body: (request.body as { raw: string }).raw,
      })
      return reply.send('ok')
    })
    const address = await receiver.listen({ port: 0, host: '127.0.0.1' })

    mock = await createWamock({
      appSecret: 'wh-secret',
      start: 1_750_000_000_000,
      webhookUrl: `${address}/webhook`,
    })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.signature).toMatch(/^sha256=/)
    expect(JSON.parse(seen[0]!.body).entry[0].changes[0].value.messages[0].from).toBe(CUSTOMER)
  })

  it('records a rejecting receiver as a failed delivery instead of throwing', async () => {
    // A receiver returning 500 must be visible in the log, not swallowed and
    // not fatal to the run.
    receiver = Fastify()
    receiver.post('/webhook', async (_request, reply) => reply.status(500).send('nope'))
    const address = await receiver.listen({ port: 0, host: '127.0.0.1' })

    mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      webhookUrl: `${address}/webhook`,
    })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    const log = mock.engine.deliverer.log()
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ ok: false })
    expect(log[0]!.error).toMatch(/500/)
  })
})

describe('send() shapes', () => {
  it('sends an interactive payload through', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    await mock.inbound({ from: CUSTOMER, text: 'hola' })

    await mock.send({
      to: CUSTOMER,
      interactive: {
        type: 'button',
        body: { text: 'Pick' },
        action: { buttons: [{ type: 'reply', reply: { id: 'y', title: 'Yes' } }] },
      },
    })

    expect(mock.expectSent({ type: 'interactive' }).payload).toHaveProperty('interactive')
  })

  it('passes template components through untouched', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    await mock.approveTemplate({ name: 'promo', language: 'es_MX', category: 'MARKETING' })

    await mock.send({
      to: CUSTOMER,
      template: {
        name: 'promo',
        language: 'es_MX',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Ana' }] }],
      },
    })

    const sent = mock.expectSent({ type: 'template' })
    expect((sent.payload['template'] as { components: unknown[] }).components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Ana' }] },
    ])
  })

  it('routes to a named phone number when given one', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    mock.engine.state.registerApp({ appId: 'APP_2', appSecret: 's2' })
    mock.engine.state.registerWaba({ wabaId: 'WABA_2', appId: 'APP_2' })
    mock.engine.state.subscribeApp('WABA_2', 'APP_2')
    mock.engine.state.registerPhoneNumber({
      phoneNumberId: 'PNID_2',
      wabaId: 'WABA_2',
      displayPhoneNumber: '15550002222',
    })
    mock.engine.windows.recordInbound('PNID_2', CUSTOMER, mock.time.now())

    await mock.send({ to: CUSTOMER, text: 'hola', phoneNumberId: 'PNID_2' })

    expect(mock.expectSent({ text: 'hola' }).phoneNumberId).toBe('PNID_2')
  })
})

describe('transitionTemplate from library mode', () => {
  it('drives a template to PAUSED and the send then fails with 132015', async () => {
    mock = await createWamock({ appSecret: 's', start: 1_750_000_000_000 })
    await mock.approveTemplate({ name: 'promo', language: 'es_MX' })

    await mock.transitionTemplate({ name: 'promo', language: 'es_MX', to: 'PAUSED' })

    await expect(
      mock.send({ to: CUSTOMER, template: { name: 'promo', language: 'es_MX' } }),
    ).rejects.toMatchObject({ code: 132015 })
  })
})
