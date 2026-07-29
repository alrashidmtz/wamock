import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * `curl -d '{"ms":1000}' .../__mock/time/advance` sends
 * `application/x-www-form-urlencoded`, because that is what curl defaults to
 * when you use `-d` without naming a type. Every control-API example anyone
 * types in a terminal looks like that, and four of the README's own did.
 *
 * The control API is wamock's own affordance rather than a surface that has to
 * match Meta, so the ergonomic reading wins: a body that parses as JSON is
 * JSON, whatever the header claims. The Graph routes stay strict — fidelity is
 * the whole point there.
 */

const EPOCH = 1_750_000_000_000

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

const FORM = { 'content-type': 'application/x-www-form-urlencoded' }

describe('control API accepts a JSON body whatever curl labels it', () => {
  it('advances the clock from a form-urlencoded body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/time/advance',
      headers: FORM,
      payload: '{"ms":90000000}',
    })

    expect(res.statusCode).toBe(200)
    expect(engine.clock.now()).toBe(EPOCH + 90_000_000)
  })

  it('sets a scenario from a form-urlencoded body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/scenario',
      headers: FORM,
      payload: '{"duplicateWebhooks":true,"outOfOrderStatuses":true}',
    })

    expect(res.statusCode).toBe(200)
  })

  it('issues a token from a form-urlencoded body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/tokens',
      headers: FORM,
      payload: '{"kind":"short"}',
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('access_token')
  })

  it('takes an inbound message when the header is absent', async () => {
    // Absent, not empty. A client that omits the header sends no header; an
    // empty `content-type:` is malformed HTTP, and Fastify rejects it before
    // any parser runs. Asserting the empty case would have been asserting a
    // request no client makes.
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/inbound',
      headers: {},
      payload: '{"from":"5215555000001","text":"hola"}',
    })

    expect(res.statusCode).toBe(200)
  })

  it('takes a text/plain body, which Fastify would otherwise hand over as a string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/time/advance',
      headers: { 'content-type': 'text/plain' },
      payload: '{"ms":1000}',
    })

    expect(res.statusCode).toBe(200)
    expect(engine.clock.now()).toBe(EPOCH + 1000)
  })

  it('still rejects a body that is not JSON, and says so', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/time/advance',
      headers: FORM,
      payload: 'ms=1000',
    })

    expect(res.statusCode).toBe(400)
    // The old failure blamed the parameters for what was a body-parsing
    // problem; whatever we return has to name the real cause.
    expect(JSON.stringify(res.json())).toMatch(/JSON/i)
  })

  it('leaves the Graph routes strict, since Meta is the contract there', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v19.0/PNID_DEFAULT/messages',
      headers: FORM,
      payload: '{"messaging_product":"whatsapp","to":"5215555000001","type":"text"}',
    })

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
  })
})
