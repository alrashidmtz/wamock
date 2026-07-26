import { afterEach, describe, expect, it, vi } from 'vitest'

import { installGraphInterceptor } from '../src/intercept.js'
import type { FetchInput } from '../src/intercept.js'

/**
 * Redirecting a client that hardcodes graph.facebook.com.
 *
 * The dogfood pass against two production integrations found that BOTH build
 * their Graph URLs as string literals — neither has a base-URL setting. That
 * makes "just point it at the mock" impossible by configuration, which is the
 * common case rather than the exception, so wamock has to solve it.
 */

let restore: (() => void) | undefined

afterEach(() => {
  restore?.()
  restore = undefined
})

describe('installGraphInterceptor', () => {
  it('redirects a hardcoded Graph URL to the mock', async () => {
    const seen: string[] = []
    const original = vi.fn(async (input: FetchInput) => {
      seen.push(typeof input === 'string' ? input : input.toString())
      return new Response('{}', { status: 200 })
    })
    restore = installGraphInterceptor({ baseUrl: 'http://127.0.0.1:4004', fetchImpl: original })

    await globalThis.fetch('https://graph.facebook.com/v19.0/PNID_1/messages', { method: 'POST' })

    expect(seen[0]).toBe('http://127.0.0.1:4004/v19.0/PNID_1/messages')
  })

  it('preserves the path, query string and method', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    restore = installGraphInterceptor({
      baseUrl: 'http://127.0.0.1:4004',
      fetchImpl: async (input, init) => {
        capturedUrl = input.toString()
        capturedInit = init
        return new Response('{}')
      },
    })

    await globalThis.fetch(
      'https://graph.facebook.com/v19.0/PNID_1?fields=display_phone_number',
      { method: 'GET', headers: { Authorization: 'Bearer t' } },
    )

    expect(capturedUrl).toBe('http://127.0.0.1:4004/v19.0/PNID_1?fields=display_phone_number')
    expect(capturedInit?.method).toBe('GET')
    expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe('Bearer t')
  })

  it('leaves every other host alone', async () => {
    // A test run must not have its unrelated HTTP quietly rerouted.
    const seen: string[] = []
    restore = installGraphInterceptor({
      baseUrl: 'http://127.0.0.1:4004',
      fetchImpl: async (input) => {
        seen.push(input.toString())
        return new Response('{}')
      },
    })

    await globalThis.fetch('https://example.com/api/thing')

    expect(seen[0]).toBe('https://example.com/api/thing')
  })

  it('also redirects the regional Graph hosts Meta uses', async () => {
    const seen: string[] = []
    restore = installGraphInterceptor({
      baseUrl: 'http://127.0.0.1:4004',
      fetchImpl: async (input) => {
        seen.push(input.toString())
        return new Response('{}')
      },
    })

    await globalThis.fetch('https://graph.facebook.com/v19.0/a')
    await globalThis.fetch('https://graph.instagram.com/v19.0/b')

    expect(seen).toEqual([
      'http://127.0.0.1:4004/v19.0/a',
      'http://127.0.0.1:4004/v19.0/b',
    ])
  })

  it('accepts a URL object, not just a string', async () => {
    const seen: string[] = []
    restore = installGraphInterceptor({
      baseUrl: 'http://127.0.0.1:4004',
      fetchImpl: async (input) => {
        seen.push(input.toString())
        return new Response('{}')
      },
    })

    await globalThis.fetch(new URL('https://graph.facebook.com/v19.0/PNID_1/messages'))

    expect(seen[0]).toBe('http://127.0.0.1:4004/v19.0/PNID_1/messages')
  })

  it('accepts a Request object and keeps its method and body', async () => {
    let captured: Request | undefined
    restore = installGraphInterceptor({
      baseUrl: 'http://127.0.0.1:4004',
      fetchImpl: async (input) => {
        captured = input as Request
        return new Response('{}')
      },
    })

    await globalThis.fetch(
      new Request('https://graph.facebook.com/v19.0/PNID_1/messages', {
        method: 'POST',
        body: '{"a":1}',
        headers: { 'content-type': 'application/json' },
      }),
    )

    expect(captured?.url).toBe('http://127.0.0.1:4004/v19.0/PNID_1/messages')
    expect(captured?.method).toBe('POST')
    await expect(captured?.text()).resolves.toBe('{"a":1}')
  })

  it('restore() puts the original fetch back', async () => {
    const before = globalThis.fetch
    const undo = installGraphInterceptor({ baseUrl: 'http://127.0.0.1:4004' })

    expect(globalThis.fetch).not.toBe(before)
    undo()

    expect(globalThis.fetch).toBe(before)
  })

  it('restore() is idempotent', () => {
    const before = globalThis.fetch
    const undo = installGraphInterceptor({ baseUrl: 'http://127.0.0.1:4004' })
    undo()
    undo()

    expect(globalThis.fetch).toBe(before)
  })

  it('rejects a baseUrl that is not a URL, instead of silently doing nothing', () => {
    // A typo'd base would otherwise leave every Graph call going to Meta for
    // real, which is the worst possible failure for a testing tool.
    expect(() => installGraphInterceptor({ baseUrl: 'not-a-url' })).toThrow(/baseUrl/i)
  })
})
