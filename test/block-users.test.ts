import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * The Block Users API, as Meta's "Block users" page describes it: a number
 * blocks customers who wrote in the last 24 hours, a blocked customer cannot
 * reach it, and messages to one fail.
 */

const EPOCH = 1_750_000_000_000
const DAY = 24 * 60 * 60 * 1000
const ANA = '5215555000001'
const LUIS = '5215555000002'

let engine: WamockEngine
let app: FastifyInstance
let bodies: string[]

beforeEach(async () => {
  bodies = []
  engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void bodies.push(d.body) })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const pnid = () => engine.state.defaultPhoneNumberId
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    ...(payload !== undefined ? { headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) } : {}),
  })
const users = (...list: string[]) => ({ messaging_product: 'whatsapp', block_users: list.map((user) => ({ user })) })
const writes = (from: string) => engine.simulateInbound({ from, message: { type: 'text', text: { body: 'hola' } } })
const statusesOf = (id: string) =>
  bodies.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((s) => s?.id === id)

describe('blocking a customer', () => {
  it('blocks one who wrote today, and lists them', async () => {
    writes(ANA)
    const res = await call('POST', `/v26.0/${pnid()}/block_users`, users(`+${ANA}`))
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ messaging_product: 'whatsapp', block_users: { added_users: [{ input: `+${ANA}`, wa_id: ANA }] } })

    const list = await call('GET', `/v26.0/${pnid()}/block_users`)
    expect(list.json().data).toEqual([{ messaging_product: 'whatsapp', wa_id: ANA }])
  })

  it('fails a message to a blocked customer on its status with 130403, unbilled', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    const sent = await call('POST', `/v26.0/${pnid()}/messages`, { messaging_product: 'whatsapp', to: ANA, type: 'text', text: { body: 'hola' } })
    expect(sent.statusCode).toBe(200)
    const id = sent.json().messages[0].id
    engine.clock.advance(60_000)
    await engine.settle()
    const statuses = statusesOf(id)
    expect(statuses.map((s) => [s.status, s.errors?.[0]?.code])).toEqual([['failed', 130403]])
    expect(statuses[0].errors[0].title).toBe('Unable to deliver the message. This business has blocked the end user on WhatsApp')
    expect(statuses[0]).not.toHaveProperty('pricing')
  })

  it('fails a reaction to a blocked customer the same way', async () => {
    const { messageId } = writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    const res = await call('POST', `/v26.0/${pnid()}/messages`, {
      messaging_product: 'whatsapp',
      to: ANA,
      type: 'reaction',
      reaction: { message_id: messageId, emoji: '👍' },
    })
    engine.clock.advance(60_000)
    await engine.settle()
    expect(statusesOf(res.json().messages[0].id).map((s) => [s.status, s.errors?.[0]?.code])).toEqual([['failed', 130403]])
  })

  it('lets nothing in from a blocked customer', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    const res = await call('POST', '/__mock/inbound', { from: ANA, text: 'hola de nuevo' })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/blocked/)
  })

  it('reports, per user, who could not be blocked, beside Meta’s 139100', async () => {
    writes(ANA)
    engine.clock.advance(DAY + 1)
    writes(LUIS)
    const business = engine.state.phoneNumber(pnid())!.displayPhoneNumber
    const res = await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA, LUIS, business, 'not a number'))
    expect(res.statusCode).toBe(400)
    const body = res.json()
    expect(body.messaging_product).toBe('whatsapp')
    expect(body.block_users.added_users).toEqual([{ input: LUIS, wa_id: LUIS }])
    const reengagement = { message: 'Re-engagement required', code: 131047, error_data: { details: 'User has not messaged in the last 24 hours' } }
    expect(body.block_users.failed_users).toEqual([
      { input: ANA, wa_id: ANA, errors: [reengagement] },
      { input: business, wa_id: business, errors: [{ message: 'Self block', code: 131021, error_data: { details: 'Cannot block your own phone number.' } }] },
      { input: 'not a number', errors: [reengagement] },
    ])
    expect(body.error).toMatchObject({
      message: '(#139100) Failed to block/unblock users',
      code: 139100,
      error_data: { details: 'Failed to block some users, see the block_users response list for details' },
    })
    // The users it could block are blocked all the same.
    expect((await call('GET', `/v26.0/${pnid()}/block_users`)).json().data).toEqual([{ messaging_product: 'whatsapp', wa_id: LUIS }])
  })

  it('takes at most 1,000 users a request, and refuses a malformed one', async () => {
    const many = users(...Array.from({ length: 1001 }, (_, i) => `52155550${String(i).padStart(5, '0')}`))
    expect((await call('POST', `/v26.0/${pnid()}/block_users`, many)).json().error.code).toBe(130429)
    // Any failure renders as 100, so which guard catches a malformed entry is
    // not contract; whether `{ user: '' }` is a missing param or an invalid
    // number (131047) the page does not say, so it is left unpinned.
    for (const body of [{ block_users: [{ user: ANA }] }, { messaging_product: 'whatsapp', block_users: [] }, { messaging_product: 'whatsapp', block_users: [{}] }]) {
      expect((await call('POST', `/v26.0/${pnid()}/block_users`, body)).json().error.code, JSON.stringify(body)).toBe(100)
    }
  })

  it('answers a number that does not exist with Graph’s unsupported request, naming the verb', async () => {
    for (const method of ['POST', 'DELETE', 'GET'] as const) {
      const res = await call(method, '/v26.0/PNID_GHOST/block_users', method === 'GET' ? undefined : users(ANA))
      expect(res.json().error, method).toMatchObject({
        code: 100,
        error_subcode: 33,
        message: expect.stringMatching(new RegExp(`^Unsupported ${method.toLowerCase()} request\\. Object with ID 'PNID_GHOST' does not exist`)),
      })
    }
  })

  it('takes exactly 1,000 users in one request', async () => {
    const thousand = Array.from({ length: 1000 }, (_, i) => `52155550${String(i).padStart(5, '0')}`)
    for (const from of thousand) writes(from)
    const res = await call('POST', `/v26.0/${pnid()}/block_users`, users(...thousand))
    expect(res.statusCode).toBe(200)
    expect(res.json().block_users.added_users).toHaveLength(1000)
  })

  it('keeps at most 64,000 blocked users, and fails the next one with 139101', async () => {
    const customer = (i: number) => `5216${String(i).padStart(8, '0')}`
    // Each customer only needs to have written in the last 24 hours. Opening
    // the window directly skips signing 64,001 webhooks nobody reads, which
    // took over 5 seconds on a loaded machine.
    for (let i = 0; i <= 64_000; i++) engine.windows.recordInbound(pnid(), customer(i), engine.clock.now())
    for (let batch = 0; batch < 64; batch++) {
      const list = Array.from({ length: 1000 }, (_, i) => customer(batch * 1000 + i))
      engine.blockUsers(pnid(), users(...list))
    }
    const full = await call('POST', `/v26.0/${pnid()}/block_users`, users(customer(64_000), customer(0)))
    expect(full.statusCode).toBe(400)
    expect(full.json().error.code).toBe(139100)
    // Blocking someone already on the full list is no new entry: it succeeds.
    expect(full.json().block_users).toEqual({
      added_users: [{ input: customer(0), wa_id: customer(0) }],
      failed_users: [
        {
          input: customer(64_000),
          wa_id: customer(64_000),
          errors: [{ message: 'Blocklist limit reached', code: 139101, error_data: { details: 'The blocklist has reached its 64,000 user limit.' } }],
        },
      ],
    })
  }, 30_000)
})

describe('unblocking a customer', () => {
  it('unblocks, after which messages go through again', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    const res = await call('DELETE', `/v26.0/${pnid()}/block_users`, users(`+${ANA}`))
    expect(res.json()).toEqual({ messaging_product: 'whatsapp', block_users: { removed_users: [{ input: `+${ANA}`, wa_id: ANA }] } })
    expect((await call('GET', `/v26.0/${pnid()}/block_users`)).json().data).toEqual([])

    const id = (await call('POST', `/v26.0/${pnid()}/messages`, { messaging_product: 'whatsapp', to: ANA, type: 'text', text: { body: 'x' } })).json().messages[0].id
    engine.clock.advance(60_000)
    await engine.settle()
    expect(statusesOf(id).map((s) => s.status)).toEqual(['sent', 'delivered'])
  })

  it('unblocks a customer long after the block, though they could not write since', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    engine.clock.advance(30 * DAY)
    expect((await call('DELETE', `/v26.0/${pnid()}/block_users`, users(ANA))).statusCode).toBe(200)
  })

  it('unblocks on a number that never blocked anyone, as a no-op that succeeds', async () => {
    const res = await call('DELETE', `/v26.0/${pnid()}/block_users`, users(ANA))
    expect(res.statusCode).toBe(200)
    expect(res.json().block_users).toEqual({ removed_users: [{ input: ANA, wa_id: ANA }] })
  })

  it('reports an invalid number as failed, without a wa_id', async () => {
    const res = await call('DELETE', `/v26.0/${pnid()}/block_users`, users('nope'))
    expect(res.statusCode).toBe(400)
    expect(res.json().block_users).toEqual({ removed_users: [], failed_users: [{ input: 'nope', errors: [expect.objectContaining({ code: 131047 })] }] })
    expect(res.json().error.error_data.details).toBe('Failed to unblock some users, see the block_users response list for details')
  })
})

describe('listing blocked customers', () => {
  it('pages with limit and cursors, like every Graph edge', async () => {
    for (const from of [ANA, LUIS, '5215555000003']) writes(from)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA, LUIS, '5215555000003'))
    const first = (await call('GET', `/v26.0/${pnid()}/block_users?limit=2`)).json()
    expect(first.data.map((u: { wa_id: string }) => u.wa_id)).toEqual([ANA, LUIS])
    const next = new URL(first.paging.next)
    expect((await call('GET', `${next.pathname}${next.search}`)).json().data).toEqual([{ messaging_product: 'whatsapp', wa_id: '5215555000003' }])
  })

  it('answers 139102 to a cursor from before the list changed, and 100 to one that is no cursor', async () => {
    for (const from of [ANA, LUIS, '5215555000003']) writes(from)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA, LUIS))
    const first = (await call('GET', `/v26.0/${pnid()}/block_users?limit=1`)).json()
    await call('POST', `/v26.0/${pnid()}/block_users`, users('5215555000003'))
    const stale = await call('GET', `/v26.0/${pnid()}/block_users?limit=1&after=${first.paging.cursors.after}`)
    expect(stale.json().error).toMatchObject({ code: 139102, message: '(#139102) Blocklist concurrent update' })
    expect((await call('GET', `/v26.0/${pnid()}/block_users?after=bm9wZQ`)).json().error.code).toBe(100)
    // Blocking someone already blocked changes nothing, and keeps cursors good.
    const fresh = (await call('GET', `/v26.0/${pnid()}/block_users?limit=1`)).json()
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    expect((await call('GET', `/v26.0/${pnid()}/block_users?limit=1&after=${fresh.paging.cursors.after}`)).statusCode).toBe(200)
  })

  it('answers 139102 to a cursor from before an unblock, and keeps cursors good when an unblock changes nothing', async () => {
    for (const from of [ANA, LUIS]) writes(from)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA, LUIS))
    const first = (await call('GET', `/v26.0/${pnid()}/block_users?limit=1`)).json()
    await call('DELETE', `/v26.0/${pnid()}/block_users`, users('5215555000003'))
    expect((await call('GET', `/v26.0/${pnid()}/block_users?limit=1&after=${first.paging.cursors.after}`)).statusCode).toBe(200)
    await call('DELETE', `/v26.0/${pnid()}/block_users`, users(LUIS))
    const stale = await call('GET', `/v26.0/${pnid()}/block_users?limit=1&after=${first.paging.cursors.after}`)
    expect(stale.json().error.code).toBe(139102)
  })

  it('answers 139102 to a stale cursor however many times the list has changed', async () => {
    const customers = Array.from({ length: 11 }, (_, i) => `52155550000${String(i + 10)}`)
    for (const from of customers) writes(from)
    for (const customer of customers.slice(0, 10)) await call('POST', `/v26.0/${pnid()}/block_users`, users(customer))
    const page = (await call('GET', `/v26.0/${pnid()}/block_users?limit=1`)).json()
    await call('POST', `/v26.0/${pnid()}/block_users`, users(customers[10]!))
    expect((await call('GET', `/v26.0/${pnid()}/block_users?after=${page.paging.cursors.after}`)).json().error.code).toBe(139102)
  })

  it('answers 100, not 139102, to a cursor that only looks versioned', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    // The list is at version 1 after one block.
    for (const fake of ['0|definitely-not-a-phone', `x0|${ANA}`, `0|${ANA}x`, `1|${LUIS}`]) {
      const cursor = Buffer.from(fake).toString('base64url')
      expect((await call('GET', `/v26.0/${pnid()}/block_users?after=${cursor}`)).json().error.code, fake).toBe(100)
    }
  })

  it('links the neighbouring pages at the version and host of the call, keeping its limit', async () => {
    for (const from of [ANA, LUIS, '5215555000003']) writes(from)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA, LUIS, '5215555000003'))
    const first = (await call('GET', `/v23.0/${pnid()}/block_users?limit=1`)).json()
    expect(first.paging.next).toBe(`http://localhost/v23.0/${pnid()}/block_users?limit=1&after=${first.paging.cursors.after}`)
    // Without a limit there is one page after the cursor, and no limit to keep.
    const rest = (await call('GET', `/v26.0/${pnid()}/block_users?after=${first.paging.cursors.after}`)).json()
    expect(rest.data).toHaveLength(2)
    expect(rest.paging.previous).toBe(`http://localhost/v26.0/${pnid()}/block_users?before=${rest.paging.cursors.before}`)
    // Called as a library, the links point at Graph itself.
    expect(engine.listBlockedUsers(pnid(), { limit: 1 }).paging?.['next']).toBe(
      `https://graph.facebook.com/v26.0/${pnid()}/block_users?limit=1&after=${first.paging.cursors.after}`,
    )
  })

  // Not pinned: which cursor wins when a call passes both `after` and
  // `before`; Graph's paging docs do not say.
  it('answers an empty page before the first blocked user', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    const first = (await call('GET', `/v26.0/${pnid()}/block_users`)).json()
    const res = await call('GET', `/v26.0/${pnid()}/block_users?before=${first.paging.cursors.before}`)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ data: [] })
  })

  it('starts empty again after a reset', async () => {
    writes(ANA)
    await call('POST', `/v26.0/${pnid()}/block_users`, users(ANA))
    engine.reset()
    expect((await call('GET', `/v26.0/${pnid()}/block_users`)).json().data).toEqual([])
  })
})
