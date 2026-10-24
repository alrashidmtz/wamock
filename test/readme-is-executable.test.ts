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
 * `curl` against `/__mock/`, and every one against a Graph route, and replays
 * it, so an endpoint that gets renamed or a body shape that changes breaks the
 * build instead of the reader. A Graph example once shipped posting JSON with
 * curl's default form content type, and failed for anyone who copied it.
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
  method: string
  path: string
  payload: string
  headers: Record<string, string>
}

/** curl lines the extractor could not read: each one must fail the build, not vanish. */
const unreadable: string[] = []

/**
 * Pull `curl -X POST localhost:4004/__mock/... -d '{...}'` out of the fenced
 * blocks. Deliberately literal: it matches what a reader would copy, so a
 * command that only works after being tidied up still fails here.
 */
/**
 * Split a shell line into words as the shell would for the commands the README
 * uses: single- and double-quoted strings stay whole. Returns undefined for
 * anything this does not model (an unclosed quote, a backslash escape), and
 * marks control operators (`&&`, `;`, `|`) as words of their own.
 */
function shellWords(line: string, vars: Record<string, string>): string[] | undefined {
  // `$NAME` expands outside quotes and inside double quotes, as in Bash; a
  // single-quoted one stays literal. One this does not know is unreadable.
  const expand = (text: string): string | undefined => {
    let unknown = false
    const out = text.replace(/\$([A-Za-z_]\w*)/g, (_m, name: string) => {
      if (vars[name] === undefined) unknown = true
      return vars[name] ?? ''
    })
    return unknown ? undefined : out
  }
  const words: string[] = []
  let word = ''
  let started = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === "'" || ch === '"') {
      const end = line.indexOf(ch, i + 1)
      if (end < 0) return undefined
      const quoted = line.slice(i + 1, end)
      // A line continuation left inside single quotes (see joinContinuations).
      if (quoted.includes(KEPT_NEWLINE)) return undefined
      const text = ch === '"' ? expand(quoted) : quoted
      if (text === undefined) return undefined
      word += text
      started = true
      i = end
    } else if (ch === '$') {
      const name = line.slice(i + 1).match(/^[A-Za-z_]\w*/)?.[0]
      if (name === undefined || vars[name] === undefined) return undefined
      word += vars[name]
      started = true
      i += name.length
    } else if (ch === '\\') {
      return undefined
    } else if (/\s/.test(ch)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else if (ch === ';' || ch === '|' || ch === '&') {
      if (started) words.push(word)
      words.push(ch === '&' && line[i + 1] === '&' ? '&&' : ch === '|' && line[i + 1] === '|' ? '||' : ch)
      if (line[i + 1] === ch) i++
      word = ''
      started = false
    } else {
      word += ch
      started = true
    }
  }
  if (started) words.push(word)
  return words
}

/**
 * Read one curl command into a request, or undefined when it uses anything
 * this does not replay as curl would: another option, a body that is not one
 * quoted argument, several bodies, or more than one URL.
 */
function curlCall(words: string[]): DocumentedCall | undefined {
  const host = /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(\/.*)$/
  let method: string | undefined
  let url: string | undefined
  let payload: string | undefined
  const headers: Record<string, string> = {}
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    if (word === '-s') continue
    if (word === '-X' || word === '-H' || word === '-d') {
      const value = words[++i]
      if (value === undefined) return undefined
      if (word === '-X') method = value
      else if (word === '-H') {
        const [name, ...rest] = value.split(':')
        headers[name!.trim().toLowerCase()] = rest.join(':').trim()
      } else {
        // curl reads `-d @file` from a file, and joins several -d with `&`.
        if (payload !== undefined || value.startsWith('@')) return undefined
        payload = value
      }
      continue
    }
    if (word.startsWith('-') || url !== undefined) return undefined
    url = word
  }
  const path = url?.match(host)?.[1]
  if (path === undefined || !(path.startsWith('/__mock/') || /^\/v\d+\.\d+\//.test(path))) return undefined
  // A control call documents its body; a Graph call may have none.
  if (payload === undefined && path.startsWith('/__mock/')) return undefined
  // curl posts whenever there is a -d, even an empty one.
  return { method: method ?? (payload !== undefined ? 'POST' : 'GET'), path, payload: payload ?? '', headers }
}

/** Marks a backslash-newline that Bash keeps, because it is inside single quotes. */
const KEPT_NEWLINE = '\u0000'

/**
 * Join the line continuations a multi-line command uses, as Bash does: a
 * backslash-newline outside single quotes is removed; inside them it stays,
 * so the line that holds it is marked rather than silently joined.
 */
function joinContinuations(text: string): string {
  let out = ''
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === '\\' && text[i + 1] === '\n') {
      if (quote === "'") out += KEPT_NEWLINE
      i++
      continue
    }
    if (ch === "'" || ch === '"') quote = quote === undefined ? ch : quote === ch ? undefined : quote
    if (ch === '\n') quote = undefined
    out += ch
  }
  return out
}

/** What the README's placeholders stand for: the seeded objects. */
const README_VARS: Record<string, string> = (() => {
  const seeded = new WamockEngine({ appSecret: 's', mode: 'frozen' })
  return { WABA_ID: seeded.state.defaultWabaId, PHONE_NUMBER_ID: seeded.state.defaultPhoneNumberId }
})()

function documentedCalls(markdown: string): DocumentedCall[] {
  // Every fenced block, whatever its language: a curl in a `sh` block is as
  // copyable as one in a `bash` block.
  const blocks = markdown.match(/```[^\n]*\n([\s\S]*?)```/g) ?? []
  const calls: DocumentedCall[] = []

  for (const block of blocks) {
    // Join the line continuations a multi-line curl uses.
    const flat = joinContinuations(block.replace(/```[^\n]*\n|```/g, ''))
    for (const raw of flat.split('\n')) {
      // A curl command, not a comment, nor output that happens to mention curl.
      if (/^\s*#/.test(raw) || !/(?:^|[\s;&|\\])curl\s+[-\w$'"]/.test(raw)) continue
      const line = raw.replace(/^\s*\$\s+/, '')
      const words = shellWords(line, README_VARS)
      // Run as written, alone: a prefix (`TOKEN=x curl`, `sudo`, `\curl`) or a
      // second command on the line is not something this replays.
      const call =
        words !== undefined && words[0] === 'curl' && !words.some((w) => ['&&', '||', ';', '|', '&'].includes(w))
          ? curlCall(words)
          : undefined
      if (call === undefined) unreadable.push(raw.trim())
      else calls.push(call)
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

  it('finds the documented control-API calls, and reads every curl it meets', () => {
    // A regex that silently matches nothing would make every case below vacuous,
    // and one that skips a curl it cannot read leaves that example untested.
    expect(calls.length).toBeGreaterThanOrEqual(5)
    expect(unreadable).toEqual([])
  })

  it.each(calls.map((c, i) => [i, c.path, c] as const))(
    'README call %i: %s',
    async (_i, _path, call) => {
      const res = await app.inject({
        method: call.method as 'GET' | 'POST' | 'DELETE',
        url: call.path,
        headers: call.headers,
        payload: call.payload,
      })

      expect(res.statusCode, `${call.path} with ${call.payload} → ${res.body}`).toBe(200)
    },
  )
})
