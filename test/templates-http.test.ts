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

describe('POST /__mock/templates/{name}/{language}/recategorize', () => {
  it('sends the notice before answering, and names a bad category', async () => {
    await post(`/v26.0/${waba}/message_templates`, body())
    const res = await post('/__mock/templates/order_update/es_MX/recategorize', { to: 'MARKETING' })
    expect(res.json()).toEqual({ success: true })

    const bad = await post('/__mock/templates/order_update/es_MX/recategorize', { to: 'PROMO' })
    expect(bad.json().error.error_data.details).toBe(
      "to: Invalid enum value. Expected 'UTILITY' | 'MARKETING' | 'AUTHENTICATION', received 'PROMO'",
    )
  })
})

describe('GET /{version}/{waba_id}/message_templates pages like Graph', () => {
  const list = (query = '', version = 'v26.0') => app.inject({ method: 'GET', url: `/${version}/${waba}/message_templates${query}` })
  const create = async (count: number) => {
    for (let i = 0; i < count; i++) await post(`/v26.0/${waba}/message_templates`, body({ name: `t_${String(i).padStart(2, '0')}` }))
  }
  const names = (res: LightMyRequestResponse) => res.json().data.map((t: { name: string }) => t.name)

  it('answers 25 a page by default, with a next link to the rest', async () => {
    // An integration that never follows paging.next loses every template past
    // the 25th in production; it should here too.
    await create(30)
    const first = await list()
    expect(first.json().data).toHaveLength(25)
    const next = new URL(first.json().paging.next)
    expect(next.pathname).toBe(`/v26.0/${waba}/message_templates`)
    const rest = await list(next.search)
    expect(names(rest)).toEqual(['t_25', 't_26', 't_27', 't_28', 't_29'])
    expect(rest.json().paging).not.toHaveProperty('next')
    expect(rest.json().paging.previous).toBeDefined()
  })

  it('walks back with before, and keeps limit and name in its links', async () => {
    await create(5)
    const page = await list('?limit=2&after=' + (await list('?limit=2')).json().paging.cursors.after)
    expect(names(page)).toEqual(['t_02', 't_03'])
    const back = new URL(page.json().paging.previous)
    expect(back.searchParams.get('limit')).toBe('2')
    expect(names(await list(back.search))).toEqual(['t_00', 't_01'])

    await post(`/v26.0/${waba}/message_templates`, body({ name: 't_01', language: 'en_US' }))
    const named = await list('?name=t_01&limit=1')
    expect(names(named)).toEqual(['t_01'])
    expect(new URL(named.json().paging.next).searchParams.get('name')).toBe('t_01')
  })

  it('answers a cursor that names no template with 131059 from v24, as Meta’s changelog says', async () => {
    await create(2)
    const res = await list('?after=bm90LWEtdGVtcGxhdGU')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatchObject({ code: 131059, message: '(#131059) Invalid pagination cursor' })
    expect((await list('?before=bm90LWEtdGVtcGxhdGU', 'v24.0')).json().error.code).toBe(131059)
    expect((await list('?after=bm90LWEtdGVtcGxhdGU', 'v23.0')).json().error.code).toBe(100)
  })

  it('refuses a limit outside 1 to 100, like every paged edge', async () => {
    for (const limit of ['0', '101', 'x']) expect((await list(`?limit=${limit}`)).json().error.code).toBe(100)
  })
})
