import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * The exact words of a rejected control-API body, for every shape the
 * `inbound`, `statuses` and `scenario` schemas can fail with.
 *
 * These used to be zod's own messages passed straight through. Moving from
 * zod 3 to zod 4 rewrote nearly all of them and the suite stayed green,
 * because `control-validation.test.ts` only checks that the field is NAMED.
 * Every row below is what 0.3.1 answered, captured from the published package.
 */

const EPOCH = 1_750_000_000_000

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async () => {} })
  app = createServer(engine)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

const CASES: [string, unknown, string][] = [
  ['/__mock/inbound', {}, 'from: Required'],
  ['/__mock/inbound', { text: 'a' }, 'from: Required'],
  ['/__mock/inbound', { from: 5, text: 'a' }, 'from: Expected string, received number'],
  ['/__mock/inbound', { from: '1', text: 'a', extra: 1, otra: 2 }, "Unrecognized key(s) in object: 'extra', 'otra'"],
  ['/__mock/inbound', { from: '1', button_reply: { id: '1', title: 't', x: 1 } }, "'1' is not a valid phone number"],
  ['/__mock/inbound', { from: '1', list_reply: { id: '1' } }, 'list_reply.title: Required'],
  ['/__mock/inbound', { from: '1', list_reply: 'x' }, 'list_reply: Expected object, received string'],
  ['/__mock/inbound', { from: '1', button_reply: null }, 'button_reply: Expected object, received null'],
  ['/__mock/inbound', null, 'Expected object, received null'],
  ['/__mock/inbound', ['a'], 'Expected object, received array'],
  ['/__mock/inbound', 'texto', 'Expected object, received string'],
  ['/__mock/inbound', 7, 'Expected object, received number'],
  ['/__mock/inbound', true, 'Expected object, received boolean'],
  ['/__mock/statuses', { id: 'w', status: 'nope' }, "status: Invalid enum value. Expected 'sent' | 'delivered' | 'read' | 'played' | 'failed', received 'nope'"],
  ['/__mock/statuses', { id: 'w', status: 3 }, "status: Expected 'sent' | 'delivered' | 'read' | 'played' | 'failed', received number"],
  ['/__mock/statuses', { id: 'w', status: 'sent', error: 1.5 }, 'error: Expected integer, received float'],
  ['/__mock/statuses', { id: 'w', status: 'sent', error: 'x' }, 'error: Expected number, received string'],
  ['/__mock/statuses', {}, 'id: Required; status: Required'],
  ['/__mock/scenario', { seeed: 1 }, "Unrecognized key(s) in object: 'seeed'"],
  ['/__mock/scenario', { seed: 1.5 }, 'seed: Expected integer, received float'],
  ['/__mock/scenario', { seed: 'x' }, 'seed: Expected number, received string'],
  ['/__mock/scenario', { latencyMs: -1 }, 'latencyMs: Number must be greater than or equal to 0'],
  ['/__mock/scenario', { latencyMs: { min: 1 } }, 'latencyMs: Invalid input'],
  ['/__mock/scenario', { latencyMs: { min: 1, max: 2, z: 1 } }, "latencyMs: Unrecognized key(s) in object: 'z'"],
  ['/__mock/scenario', { latencyMs: 'x' }, 'latencyMs: Invalid input'],
  ['/__mock/scenario', { sendFailureRate: 'x' }, 'sendFailureRate: Expected number, received string'],
  ['/__mock/scenario', { duplicateWebhooks: 'x' }, 'duplicateWebhooks: Expected boolean, received string'],
  ['/__mock/scenario', { nextError: { code: 1, times: 0 } }, 'nextError.times: Number must be greater than 0'],
  ['/__mock/scenario', { nextError: { code: 1, times: -2 } }, 'nextError.times: Number must be greater than 0'],
  ['/__mock/scenario', { nextError: { code: 1.2 } }, 'nextError.code: Expected integer, received float'],
  ['/__mock/scenario', { nextError: {} }, 'nextError.code: Required'],
  ['/__mock/scenario', { nextError: { code: 1, q: 1 } }, "nextError: Unrecognized key(s) in object: 'q'"],
  ['/__mock/scenario', { nextError: [] }, 'nextError: Expected object, received array'],
  ['/__mock/scenario', { seed: null }, 'seed: Expected number, received null'],
  // 0.3.1 reported both problems with a negative fraction; zod 4's `.int()`
  // stops at the first. Found by Codex against the published package.
  [
    '/__mock/scenario',
    { nextError: { code: 1, times: -0.5 } },
    'nextError.times: Expected integer, received float; nextError.times: Number must be greater than 0',
  ],
  [
    '/__mock/scenario',
    { seed: 1.5, sendFailureRate: 'x', zz: 1 },
    "seed: Expected integer, received float; sendFailureRate: Expected number, received string; Unrecognized key(s) in object: 'zz'",
  ],
]

/**
 * Bodies 0.3.1 ACCEPTED that zod 4 would reject on its own: integers past
 * Number.MAX_SAFE_INTEGER, which zod 4's `.int()` refuses. Found by Codex
 * against the published 0.3.1.
 */
const STILL_ACCEPTED: [string, unknown][] = [
  ['/__mock/scenario', { seed: 9007199254740992 }],
  ['/__mock/time/advance', { ms: 9007199254740992 }],
]

describe('bodies 0.3.1 accepted are still accepted', () => {
  it.each(STILL_ACCEPTED)('%s %j', async (url, body) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    expect(res.statusCode).toBe(200)
  })
})

/**
 * The one deliberate difference from 0.3.1. JSON like `1e400` parses to
 * Infinity, which 0.3.1 accepted: an infinite `latencyMs` meant statuses that
 * never arrived. zod 4 refuses non-finite numbers and wamock keeps that, but
 * words it truthfully instead of zod's "expected number, received number".
 * The bodies are raw JSON, because JSON.stringify(Infinity) is "null".
 */
const NON_FINITE: [string, string, string][] = [
  ['/__mock/scenario', '{"latencyMs":1e400}', 'latencyMs: Invalid input'],
  ['/__mock/scenario', '{"sendFailureRate":1e400}', 'sendFailureRate: Expected finite number, received Infinity'],
  ['/__mock/scenario', '{"seed":-1e400}', 'seed: Expected finite number, received -Infinity'],
]

describe('a non-finite number is refused, and says so', () => {
  it.each(NON_FINITE)('%s %s', async (url, payload, details) => {
    const res = await app.inject({ method: 'POST', url, headers: { 'content-type': 'application/json' }, payload })
    expect(res.statusCode).toBe(400)
    expect(res.json<{ error?: { error_data?: { details?: string } } }>().error?.error_data?.details).toBe(details)
  })
})

describe('a rejected control-API body is worded by wamock, not by its validator', () => {
  it.each(CASES)('%s %j', async (url, body, details) => {
    const res = await app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    })
    expect(res.statusCode).toBe(400)
    const json = res.json<{ error?: { error_data?: { details?: string } } }>()
    expect(json.error?.error_data?.details).toBe(details)
  })
})
