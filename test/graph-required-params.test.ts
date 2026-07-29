import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * Required-parameter rejection on the Graph routes, and the version segment.
 *
 * The same gap mutation testing found in the control API, on the other side:
 * `!clientId || !clientSecret || !code` survived five mutations,
 * `!inputToken || !accessToken` three, and `!name` two. Every existing test
 * called these endpoints correctly, so nothing pinned down what happens when
 * a caller does not — which is the case a caller actually hits.
 *
 * VERSION_PATTERN survived too. wamock answers v17 through v23 on purpose, so
 * what it refuses is part of that promise rather than an accident.
 */

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({
    appSecret: 's',
    mode: 'frozen',
    start: 1_750_000_000_000,
    transport: async () => {},
  })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const detailOf = (res: { json: () => unknown }): string =>
  ((res.json() as { error?: { error_data?: { details?: string } } }).error?.error_data?.details ??
    '') as string

describe('oauth/access_token requires all three parameters', () => {
  const complete = { client_id: 'APP_DEFAULT', client_secret: 'secret', code: 'CODE' }

  it.each([
    ['client_id', 'client_id'],
    ['client_secret', 'client_secret'],
    ['code', 'code'],
  ])('rejects a call missing %s', async (missing) => {
    const query = { ...complete } as Record<string, string>
    delete query[missing]
    const search = new URLSearchParams(query).toString()

    const res = await app.inject({ method: 'GET', url: `/v19.0/oauth/access_token?${search}` })

    expect(res.statusCode).toBe(400)
    expect(detailOf(res)).toMatch(/client_id, client_secret and code/)
  })

  it('rejects an empty value, not only an absent key', async () => {
    // `?code=` reaches the handler as '', which is falsy but present. A check
    // written as `code === undefined` would let it through to fail deeper.
    const res = await app.inject({
      method: 'GET',
      url: '/v19.0/oauth/access_token?client_id=APP_DEFAULT&client_secret=secret&code=',
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('debug_token requires both parameters', () => {
  it.each([
    ['input_token', 'input_token=T'],
    ['access_token', 'access_token=T'],
  ])('rejects a call carrying only %s', async (_name, only) => {
    const res = await app.inject({ method: 'GET', url: `/v19.0/debug_token?${only}` })

    expect(res.statusCode).toBe(400)
    expect(detailOf(res)).toMatch(/input_token and access_token/)
  })
})

describe('deleting a template requires a name', () => {
  it('rejects a delete with no name, before the name reaches the engine', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v19.0/WABA_DEFAULT/message_templates',
    })

    expect(res.statusCode).toBe(400)
    // /name/ alone was not enough: without this check the engine answers
    // "No template named (undefined) exists", which contains 'name' and is a
    // 400 too. It also puts the string "undefined" in front of a user, which
    // is the tell that a missing value travelled instead of being refused.
    expect(detailOf(res)).toMatch(/Param name is required/)
    expect(detailOf(res)).not.toMatch(/undefined/)
  })

  it('rejects an empty name', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v19.0/WABA_DEFAULT/message_templates?name=',
    })

    expect(res.statusCode).toBe(400)
  })
})

describe('the version segment is checked, not assumed', () => {
  it.each(['v17.0', 'v19.0', 'v23.0'])('answers on %s', async (version) => {
    const res = await app.inject({
      method: 'POST',
      url: `/${version}/PNID_DEFAULT/messages`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: '5215555000001', type: 'text' }),
    })

    // Whatever the outcome, it must not be the "unknown path" 404 — that would
    // mean the version segment was refused rather than the request judged.
    expect(res.statusCode).not.toBe(404)
  })

  it.each(['v19', 'version19.0', '19.0', 'vX.Y'])('refuses %s as a version', async (version) => {
    const res = await app.inject({
      method: 'POST',
      url: `/${version}/PNID_DEFAULT/messages`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: '5215555000001', type: 'text' }),
    })

    expect(res.statusCode).toBe(404)
    expect(detailOf(res)).toMatch(/Unknown path/)
  })
})
