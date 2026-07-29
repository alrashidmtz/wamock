import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * The control API's rejection paths and its optional parameters.
 *
 * Mutation testing pointed here: `if (!parsed.success)` survived in six
 * separate routes, and so did every optional-field spread. Nothing checked
 * that a bad body is refused, or that naming an optional field changes
 * anything — the suite only ever sent well-formed, minimal bodies.
 *
 * The rejection path is the one a reader meets first. Guessing `{messageId}`
 * where the API wants `{id}` is how the shape of a request gets learned, so
 * that 400 has to say which field is wrong rather than just failing.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: EPOCH,
    transport: async () => {},
  })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const post = (url: string, body: unknown) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })

const detailOf = (res: { json: () => unknown }): string =>
  ((res.json() as { error?: { error_data?: { details?: string } } }).error?.error_data?.details ??
    '') as string

describe('a rejected control-API body says which field is wrong', () => {
  it.each([
    ['/__mock/inbound', { text: 'hola' }, /from/],
    ['/__mock/statuses', { messageId: 'wamid.x', status: 'read' }, /messageId|id/],
    ['/__mock/scenario', { seed: 'not-a-number' }, /seed/],
    ['/__mock/tokens', { kind: 'eternal' }, /kind/],
    ['/__mock/quality', { quality_rating: 'PURPLE' }, /quality_rating/],
    ['/__mock/tier', { tier: 'TIER_BILLION' }, /tier/],
  ])('%s rejects %j', async (url, body, expected) => {
    const res = await post(url, body)

    expect(res.statusCode).toBe(400)
    // Not just "it failed" — the message has to name the offending field,
    // which is the only part that helps whoever has to fix the call.
    expect(detailOf(res)).toMatch(expected)
  })

  it('names an unrecognised key rather than silently dropping it', async () => {
    // The schemas are .strict() on purpose: a typo'd field that is quietly
    // ignored is worse than a rejection, because the call appears to work.
    const res = await post('/__mock/inbound', { from: CUSTOMER, text: 'hola', typo: 1 })

    expect(res.statusCode).toBe(400)
    expect(detailOf(res)).toMatch(/typo/)
  })

  it('rejects a negative clock advance without leaking an internal error', async () => {
    const res = await post('/__mock/time/advance', { ms: -1000 })

    expect(res.statusCode).toBe(400)
    expect(engine.clock.now()).toBe(EPOCH)
    // Status alone does not pin this down: VirtualClock.advance() also throws
    // on a negative, so dropping the route's own check still yields a 400 —
    // but one whose message names an internal class. The route has to be the
    // one answering, and it has to say what to pass instead.
    expect(detailOf(res)).toMatch(/non-negative/)
    expect(detailOf(res)).not.toMatch(/Clock\.advance/)
  })
})

describe('optional control-API parameters take effect', () => {
  /** The seed hosts one number; a second is minted the documented way. */
  const secondNumber = async (): Promise<string> => {
    const res = await post('/__mock/embedded-signup', {})
    return (res.json() as { phone_number_id: string }).phone_number_id
  }

  it('inbound honours phone_number_id', async () => {
    const other = await secondNumber()

    const res = await post('/__mock/inbound', { from: CUSTOMER, text: 'hola', phone_number_id: other })

    expect(res.statusCode).toBe(200)
    // The window belongs to the number that was addressed, not the default.
    expect(engine.windows.isOpen(other, CUSTOMER, engine.clock.now())).toBe(true)
    expect(engine.windows.isOpen(engine.state.defaultPhoneNumberId, CUSTOMER, engine.clock.now())).toBe(false)
  })

  it('inbound honours name, which rides along on the webhook contact', async () => {
    // Rebuilt with a capturing transport: the engine takes it at construction,
    // so reassigning it afterwards would observe nothing.
    const delivered: string[] = []
    const observed = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d: { body: string }) => {
        delivered.push(d.body)
      },
    })
    const observedApp = createServer(observed)
    await observedApp.ready()

    await observedApp.inject({
      method: 'POST',
      url: '/__mock/inbound',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ from: CUSTOMER, text: 'hola', name: 'Ana Ruiz' }),
    })
    observed.clock.advance(0)
    await new Promise((r) => setTimeout(r, 30))
    await observedApp.close()

    expect(delivered.join()).toMatch(/Ana Ruiz/)
  })

  it('tokens honours kind and scopes', async () => {
    const res = await post('/__mock/tokens', {
      kind: 'permanent',
      scopes: ['whatsapp_business_messaging'],
    })

    expect(res.statusCode).toBe(200)
    const token = (res.json() as { access_token: string }).access_token
    // A permanent token is distinguishable from the short-lived default —
    // otherwise `kind` could be ignored and nothing would notice.
    expect(token).not.toMatch(/^SHORT_/)
  })

  it('quality honours phone_number_id', async () => {
    const other = await secondNumber()

    const res = await post('/__mock/quality', { quality_rating: 'RED', phone_number_id: other })

    expect(res.statusCode).toBe(200)
    expect(engine.state.phoneNumber(other)?.qualityRating).toBe('RED')
    // Scoped: the default number must be untouched, or the parameter is decorative.
    expect(engine.state.phoneNumber(engine.state.defaultPhoneNumberId)?.qualityRating).not.toBe('RED')
  })
})
