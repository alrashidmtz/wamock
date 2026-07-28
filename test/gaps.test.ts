import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { parseArgs } from '../src/cli-args.js'
import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

/**
 * Branches that mutation testing proved nothing was exercising.
 *
 * Each of these had full line coverage and zero real verification: the line
 * ran, but flipping its condition changed no test outcome. That is the gap
 * coverage cannot show you.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

describe('CLI flags that no test touched', () => {
  it('accepts the long and short quiet flags', () => {
    // `--quiet` could be hardcoded to false and every test still passed.
    expect(parseArgs(['start', '--quiet']).options.quiet).toBe(true)
    expect(parseArgs(['start', '-q']).options.quiet).toBe(true)
  })

  it('leaves quiet off by default', () => {
    expect(parseArgs(['start']).options.quiet).toBe(false)
  })

  it('accepts the short version and help flags', () => {
    expect(parseArgs(['-v']).command).toBe('version')
    expect(parseArgs(['-h']).command).toBe('help')
  })
})

describe('port bounds, at the boundaries themselves', () => {
  // The old tests used 'abc' and 99999 — far outside the range, so `< 1` could
  // become `<= 1` and nothing noticed. Bugs live on the boundary, not beyond it.
  it('accepts the lowest and highest valid ports', () => {
    expect(parseArgs(['start', '--port', '1']).options.port).toBe(1)
    expect(parseArgs(['start', '--port', '65535']).options.port).toBe(65535)
  })

  it('rejects one below and one above the range', () => {
    expect(() => parseArgs(['start', '--port', '0'])).toThrow(/port/i)
    expect(() => parseArgs(['start', '--port', '65536'])).toThrow(/port/i)
  })

  it('rejects a negative and a fractional port', () => {
    expect(() => parseArgs(['start', '--port', '-1'])).toThrow(/port/i)
    expect(() => parseArgs(['start', '--port', '80.5'])).toThrow(/port/i)
  })
})

describe('control API paths with no HTTP coverage', () => {
  let engine: WamockEngine
  let app: FastifyInstance
  let received: string[]

  beforeEach(async () => {
    received = []
    engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    app = createServer(engine)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const post = async (url: string, payload: unknown): Promise<LightMyRequestResponse> =>
    app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(payload),
    })

  it('simulates a list reply, not just a button reply', async () => {
    // `if (input.list_reply)` could be replaced with `false` and nothing failed:
    // the branch existed, was covered by the button test walking past it, and
    // was never actually taken.
    const res = await post('/__mock/inbound', {
      from: CUSTOMER,
      list_reply: { id: 'svc_corte', title: 'Corte', description: 'Servicio' },
    })
    expect(res.statusCode).toBe(200)

    engine.clock.advance(0)
    await engine.settle()

    const message = JSON.parse(received[0]!).entry[0].changes[0].value.messages[0]
    expect(message).toMatchObject({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'svc_corte', title: 'Corte' } },
    })
  })

  it('routes an inbound to a named phone number rather than the default', async () => {
    engine.state.registerApp({ appId: 'APP_2', appSecret: 's2' })
    engine.state.registerWaba({ wabaId: 'WABA_2', appId: 'APP_2' })
    engine.state.subscribeApp('WABA_2', 'APP_2')
    engine.state.registerPhoneNumber({
      phoneNumberId: 'PNID_2',
      wabaId: 'WABA_2',
      displayPhoneNumber: '15550002222',
    })

    await post('/__mock/inbound', { from: CUSTOMER, text: 'hola', phone_number_id: 'PNID_2' })
    engine.clock.advance(0)
    await engine.settle()

    const value = JSON.parse(received[0]!).entry[0].changes[0].value
    expect(value.metadata.phone_number_id).toBe('PNID_2')
  })

  it('rejects an inbound carrying an unknown field', async () => {
    // The strict schema's rejection path had no HTTP test.
    const res = await post('/__mock/inbound', { from: CUSTOMER, text: 'hola', tpyo: true })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('rejects a malformed time advance', async () => {
    expect((await post('/__mock/time/advance', { ms: 'soon' })).statusCode).toBe(400)
    expect((await post('/__mock/time/advance', {})).statusCode).toBe(400)
  })

  it('rejects a status transition with no id', async () => {
    expect((await post('/__mock/statuses', { status: 'read' })).statusCode).toBe(400)
  })

  it('rejects a template transition with a missing body', async () => {
    expect((await post('/__mock/templates/x/es_MX/transition', {})).statusCode).toBe(400)
  })

  it('rejects an embedded-signup call with an unknown option', async () => {
    expect((await post('/__mock/embedded-signup', { subscribe: false })).statusCode).toBe(400)
  })

  it('rejects a token request with an unknown kind', async () => {
    expect((await post('/__mock/tokens', { kind: 'eternal' })).statusCode).toBe(400)
  })

  it('rejects a tier that is not one of Meta’s', async () => {
    const res = await post('/__mock/tier', { tier: 'TIER_GOLD' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/TIER_/)
  })

  it('reports the drop counters in the state endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/__mock/state' })
    expect(res.json()).toMatchObject({ droppedOutbound: 0, droppedWebhookLog: 0 })
  })
})

describe('unknown routes', () => {
  let engine: WamockEngine
  let app: FastifyInstance

  beforeEach(async () => {
    engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
    app = createServer(engine)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('answers a Meta-shaped 404, not a fastify one', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope/at/all' })

    expect(res.statusCode).toBe(404)
    expect(res.json().error).toMatchObject({ code: 100, type: 'OAuthException' })
    expect(res.json().error.message).toMatch(/Unsupported request/)
  })

  it('404s an unknown control endpoint too', async () => {
    expect((await app.inject({ method: 'POST', url: '/__mock/nope' })).statusCode).toBe(404)
  })
})
