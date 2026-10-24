import { request as httpRequest } from 'node:http'

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

  it('reads a Graph body as the form it is labelled, the way Meta does', async () => {
    // The body is complete and the window is open, so this send would succeed
    // if the body were read. An incomplete body would have failed for its own
    // reasons and proved nothing — mutation testing caught exactly that: the
    // path guard could be mutated away and this still passed.
    await app.inject({
      method: 'POST',
      url: '/__mock/inbound',
      payload: '{"from":"5215555000001","text":"hola"}',
      headers: FORM,
    })

    const payload = JSON.stringify({
      messaging_product: 'whatsapp',
      to: '5215555000001',
      type: 'text',
      text: { body: 'hola' },
    })

    const accepted = await app.inject({
      method: 'POST',
      url: '/v19.0/PNID_DEFAULT/messages',
      headers: { 'content-type': 'application/json' },
      payload,
    })
    expect(accepted.statusCode, 'the same body must succeed as JSON').toBe(200)

    // Meta's Messages API accepts form-urlencoded, with nested objects as
    // JSON-valued fields. A real form send works...
    const form = new URLSearchParams({
      messaging_product: 'whatsapp',
      to: '5215555000001',
      type: 'text',
      text: JSON.stringify({ body: 'hola' }),
    }).toString()
    const asForm = await app.inject({ method: 'POST', url: '/v19.0/PNID_DEFAULT/messages', headers: FORM, payload: form })
    expect(asForm.statusCode, 'a form-encoded send must succeed').toBe(200)

    // ...while JSON mislabelled as a form is read as a form, finds none of its
    // fields, and fails on them, as it would against Meta. Only the control
    // API reads any body as JSON.
    const mislabelled = await app.inject({ method: 'POST', url: '/v19.0/PNID_DEFAULT/messages', headers: FORM, payload })
    expect(mislabelled.statusCode).toBe(400)
    expect(mislabelled.json().error.error_data.details).toMatch(/messaging_product/)
  })

  it('treats an empty body as an empty object rather than a parse error', async () => {
    // `/__mock/reset` takes `{}`, and `curl -X POST .../__mock/reset` with no
    // -d at all sends nothing. Failing that with "not valid JSON" would be
    // technically true and useless.
    const res = await app.inject({
      method: 'POST',
      url: '/__mock/reset',
      headers: FORM,
      payload: '',
    })

    expect(res.statusCode).toBe(200)
  })
})

describe('a multipart content type on the control API', () => {
  it('is read as JSON like every other one', async () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: 1_750_000_000_000 })
    const app = createServer(engine)
    await app.ready()
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/__mock/scenario',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        payload: '{"seed":2}',
      })
      expect(res.statusCode).toBe(200)

      // Under the control API's own limit, not the one media uploads get.
      const huge = await app.inject({
        method: 'POST',
        url: '/__mock/time/advance',
        headers: { 'content-type': 'multipart/form-data; boundary=x' },
        payload: `{"ms":1}${' '.repeat(1024 * 1024)}`,
      })
      expect(huge.statusCode).toBe(400)
      expect(engine.clock.now()).toBe(1_750_000_000_000)

      // And through the same guarded parser as JSON: no __proto__ key.
      const poisoned = await app.inject({
        method: 'POST',
        url: '/__mock/scenario',
        headers: { 'content-type': 'text/plain' },
        payload: '{"__proto__":{"polluted":true}}',
      })
      expect(poisoned.statusCode).toBe(400)
    } finally {
      await app.close()
    }
  })
})

describe('a body that never ends, on the control API', () => {
  it('is cut off near the control limit over real HTTP, not read to the media upload’s 101 MiB', async () => {
    // Measured over a socket: an injected request buffers its whole stream
    // before Fastify sees it, which would hide what this checks.
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: 1_750_000_000_000 })
    const app = createServer(engine)
    await app.listen({ port: 0, host: '127.0.0.1' })
    const { port } = app.server.address() as { port: number }
    let sent = 0
    try {
      await new Promise<void>((resolve) => {
        const req = httpRequest(
          { host: '127.0.0.1', port, path: '/__mock/time/advance', method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=x' } },
          (res) => {
            res.resume()
            res.on('end', resolve)
          },
        )
        req.on('error', () => resolve())
        const chunk = Buffer.alloc(64 * 1024, 0x20)
        const pump = (): void => {
          while (sent < 50 * 1024 * 1024) {
            sent += chunk.length
            if (!req.write(chunk)) {
              req.once('drain', pump)
              return
            }
          }
          req.end()
        }
        pump()
      })
      expect(sent).toBeLessThan(10 * 1024 * 1024)
      expect(engine.clock.now()).toBe(1_750_000_000_000)
    } finally {
      await app.close()
    }
  })
})
