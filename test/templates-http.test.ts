import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'

const EPOCH = 1_750_000_000_000

let engine: WamockEngine
let app: FastifyInstance
let waba: string

beforeEach(async () => {
  engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
  app = createServer(engine)
  waba = engine.state.defaultWabaId
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

const body = (overrides: Record<string, unknown> = {}) => ({
  name: 'order_update',
  language: 'es_MX',
  category: 'UTILITY',
  components: [],
  ...overrides,
})

describe('POST /{version}/{waba_id}/message_templates', () => {
  it('creates a template in PENDING', async () => {
    const res = await post(`/v19.0/${waba}/message_templates`, body())

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'PENDING', category: 'UTILITY' })
  })

  it('answers a duplicate with an "already exists" error body', async () => {
    // Real integrations treat this error as success on reconnect, matching on
    // the phrase itself — so the wording is part of the contract, not decoration.
    await post(`/v19.0/${waba}/message_templates`, body())

    const res = await post(`/v19.0/${waba}/message_templates`, body())

    expect(res.statusCode).toBe(400)
    expect(res.json().error.message).toMatch(/already exists/i)
  })

  it('404s on a bad version segment', async () => {
    expect((await post(`/vX/${waba}/message_templates`, body())).statusCode).toBe(404)
  })
})

describe('GET /{version}/{waba_id}/message_templates', () => {
  it('lists templates with their per-language status', async () => {
    await post(`/v19.0/${waba}/message_templates`, body())
    await post(`/v19.0/${waba}/message_templates`, body({ language: 'en_US' }))
    await post('/__mock/templates/order_update/es_MX/transition', { to: 'APPROVED' })

    const res = await app.inject({ method: 'GET', url: `/v19.0/${waba}/message_templates` })

    expect(res.statusCode).toBe(200)
    const byLanguage = Object.fromEntries(
      res.json().data.map((t: { language: string; status: string }) => [t.language, t.status]),
    )
    expect(byLanguage).toEqual({ es_MX: 'APPROVED', en_US: 'PENDING' })
  })

  it('404s on a bad version segment', async () => {
    const res = await app.inject({ method: 'GET', url: `/vX/${waba}/message_templates` })
    expect(res.statusCode).toBe(404)
  })
})

describe('DELETE /{version}/{waba_id}/message_templates', () => {
  it('deletes by name, taking every language', async () => {
    await post(`/v19.0/${waba}/message_templates`, body())
    await post(`/v19.0/${waba}/message_templates`, body({ language: 'en_US' }))

    const res = await app.inject({
      method: 'DELETE',
      url: `/v19.0/${waba}/message_templates?name=order_update`,
    })

    expect(res.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: `/v19.0/${waba}/message_templates` })
    expect(list.json().data).toEqual([])
  })

  it('requires the name query parameter', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v19.0/${waba}/message_templates`,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe(100)
  })

  it('404s on a bad version segment', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/vX/${waba}/message_templates?name=order_update`,
    })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /__mock/templates/{name}/{language}/transition', () => {
  it('rejects a status outside Meta’s set', async () => {
    await post(`/v19.0/${waba}/message_templates`, body())

    const res = await post('/__mock/templates/order_update/es_MX/transition', { to: 'BANANA' })

    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/APPROVED/)
  })

  it('targets a named WABA when asked', async () => {
    engine.state.registerApp({ appId: 'APP_2', appSecret: 's2' })
    engine.state.registerWaba({ wabaId: 'WABA_2', appId: 'APP_2' })
    await post(`/v19.0/WABA_2/message_templates`, body())

    const res = await post(
      '/__mock/templates/order_update/es_MX/transition?waba_id=WABA_2',
      { to: 'APPROVED' },
    )

    expect(res.statusCode).toBe(200)
    expect(engine.template('WABA_2', 'order_update', 'es_MX')?.status).toBe('APPROVED')
  })
})
