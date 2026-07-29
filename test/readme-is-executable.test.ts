import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * Runs the control-API commands the README tells people to type.
 *
 * Two documentation defects shipped in a row because the text was written from
 * how something should behave and never executed: advice to run
 * `pnpm add wamock@latest`, which resolves to 0.1.0, and four `curl` examples
 * that all returned `(#100) Invalid parameter` because curl labels `-d` as
 * form-urlencoded. Both were only visible by running them.
 *
 * Prose cannot be tested, but a command can. This extracts every documented
 * `curl` against `/__mock/` and replays it, so an endpoint that gets renamed or
 * a body shape that changes breaks the build instead of the reader.
 */

// Normalised, because git checks the file out with CRLF on Windows and every
// pattern below is written against '\n'. Without this the extractor matched
// nothing there and every case passed vacuously — which is what the count
// assertion at the bottom exists to catch, and did.
const README = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'README.md'),
  'utf8',
).replace(/\r\n/g, '\n')

interface DocumentedCall {
  path: string
  payload: string
  headers: Record<string, string>
}

/**
 * Pull `curl -X POST localhost:4004/__mock/... -d '{...}'` out of the fenced
 * blocks. Deliberately literal: it matches what a reader would copy, so a
 * command that only works after being tidied up still fails here.
 */
function documentedCalls(markdown: string): DocumentedCall[] {
  const blocks = markdown.match(/```bash\n([\s\S]*?)```/g) ?? []
  const calls: DocumentedCall[] = []

  for (const block of blocks) {
    // Join the line continuations a multi-line curl uses.
    const flat = block.replace(/```bash\n|```/g, '').replace(/\\\n\s*/g, ' ')
    for (const line of flat.split('\n')) {
      if (!line.includes('/__mock/')) continue
      const path = line.match(/localhost:\d+(\/__mock\/[^\s'"]*)/)?.[1]
      const payload = line.match(/-d\s+'([^']*)'/)?.[1]
      if (!path || payload === undefined) continue
      const contentType = line.match(/-H\s+'content-type:\s*([^']*)'/i)?.[1]
      calls.push({
        path,
        payload,
        headers: contentType ? { 'content-type': contentType } : {},
      })
    }
  }
  return calls
}

let engine: WamockEngine
let app: FastifyInstance

beforeEach(async () => {
  engine = new WamockEngine({
    appSecret: 'shhh',
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

describe('the README documents commands that work', () => {
  const calls = documentedCalls(README)

  it('finds the documented control-API calls', () => {
    // A regex that silently matches nothing would make every case below vacuous.
    expect(calls.length).toBeGreaterThanOrEqual(5)
  })

  it.each(calls.map((c, i) => [i, c.path, c] as const))(
    'README call %i: POST %s',
    async (_i, _path, call) => {
      const res = await app.inject({
        method: 'POST',
        url: call.path,
        headers: call.headers,
        payload: call.payload,
      })

      expect(res.statusCode, `${call.path} with ${call.payload} → ${res.body}`).toBe(200)
    },
  )
})
