import { afterEach, describe, expect, it, vi } from 'vitest'

import { verifyWebhookUrl } from '../../src/webhooks/handshake.js'
import { httpTransport } from '../../src/webhooks/transport.js'
import type { WebhookDelivery } from '../../src/webhooks/transport.js'

/**
 * Delivering over HTTP the way Meta does: only a 200 is a success, and a URL
 * receives nothing until it passes the verification handshake, which needs a
 * 200 whose body is exactly the challenge.
 */

const delivery = { body: '{}', signature: 'sha256=x', payload: {} as never, deliveredAt: 0 } as WebhookDelivery

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubReceiver(handler: (url: URL, init?: RequestInit) => Response) {
  const calls: Array<{ method: string; url: URL }> = []
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ method: init?.method ?? 'GET', url })
    return handler(url, init)
  })
  return calls
}

const echo = (url: URL) => new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 })

describe('the verification handshake', () => {
  it('passes on a 200 echoing the challenge exactly', async () => {
    stubReceiver(echo)
    expect((await verifyWebhookUrl('http://app/webhook', 'tok')).ok).toBe(true)
  })

  it('fails on any 2xx other than 200', async () => {
    stubReceiver((url) => new Response(url.searchParams.get('hub.challenge'), { status: 201 }))
    expect((await verifyWebhookUrl('http://app/webhook', 'tok')).ok).toBe(false)
  })

  it('fails when the echo carries extra whitespace', async () => {
    stubReceiver((url) => new Response(`${url.searchParams.get('hub.challenge')}\n`, { status: 200 }))
    expect((await verifyWebhookUrl('http://app/webhook', 'tok')).ok).toBe(false)
  })
})

describe('HTTP delivery', () => {
  it('counts only a 200 as delivered', async () => {
    stubReceiver((url, init) => (init?.method === 'POST' ? new Response(null, { status: 204 }) : echo(url)))
    await expect(httpTransport('http://app/webhook', { verifyToken: 'tok' })(delivery)).rejects.toThrow(/204/)
  })

  it('verifies the URL once, before the first delivery', async () => {
    const calls = stubReceiver((url, init) => (init?.method === 'POST' ? new Response('ok') : echo(url)))
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    await send(delivery)
    await send(delivery)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'POST'])
  })

  it('delivers nothing to an unverified URL, and tries the handshake again next time', async () => {
    let verified = false
    const calls = stubReceiver((url, init) => {
      if (init?.method === 'POST') return new Response('ok')
      return verified ? echo(url) : new Response('nope', { status: 403 })
    })
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    await expect(send(delivery)).rejects.toThrow(/not verified/)
    expect(calls.map((c) => c.method)).toEqual(['GET'])

    verified = true
    await send(delivery)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET', 'POST'])
  })

  it('delivers a WABA’s webhooks to its override_callback_uri, verified with its own token', async () => {
    const calls = stubReceiver((url, init) => {
      if (init?.method === 'POST') return new Response('ok')
      return url.searchParams.get('hub.verify_token') === 'tenant-vt' ? echo(url) : new Response('no', { status: 403 })
    })
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    await send({ ...delivery, callback: { url: 'http://tenant/hook', verifyToken: 'tenant-vt' } })
    expect(calls.map((c) => `${c.method} ${c.url.host}`)).toEqual(['GET tenant', 'POST tenant'])
  })

  it('verifies on demand once, and remembers the pass', async () => {
    const calls = stubReceiver(echo)
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    expect(await send.verify()).toEqual({ ok: true })
    expect(await send.verify()).toEqual({ ok: true })
    expect(calls.map((c) => c.method)).toEqual(['GET'])
  })

  it('has nothing to verify without a verify token', async () => {
    const calls = stubReceiver(echo)
    expect(await httpTransport('http://app/webhook').verify()).toEqual({ ok: true })
    expect(calls).toEqual([])
  })

  it('verifies an override_callback_uri once, at subscription, and not again per delivery', async () => {
    const calls = stubReceiver((url, init) => (init?.method === 'POST' ? new Response('ok') : echo(url)))
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    const callback = { url: 'http://tenant/hook', verifyToken: 'tenant-vt' }
    expect(await send.verifyCallback(callback.url, callback.verifyToken)).toEqual({ ok: true })
    await send({ ...delivery, callback })
    await send({ ...delivery, callback })
    expect(calls.map((c) => `${c.method} ${c.url.host}`)).toEqual(['GET tenant', 'POST tenant', 'POST tenant'])
  })

  it('forgets a verified override_callback_uri on reset too', async () => {
    const calls = stubReceiver((url, init) => (init?.method === 'POST' ? new Response('ok') : echo(url)))
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    const callback = { url: 'http://tenant/hook', verifyToken: 'tenant-vt' }
    await send({ ...delivery, callback })
    send.reset()
    await send({ ...delivery, callback })
    expect(calls.map((c) => `${c.method} ${c.url.host}`)).toEqual(['GET tenant', 'POST tenant', 'GET tenant', 'POST tenant'])
  })

  it('forgets verified URLs on reset, so the next run verifies again', async () => {
    const calls = stubReceiver((url, init) => (init?.method === 'POST' ? new Response('ok') : echo(url)))
    const send = httpTransport('http://app/webhook', { verifyToken: 'tok' })
    await send(delivery)
    send.reset()
    await send(delivery)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST'])
  })
})

describe('subscribing with an override over HTTP', () => {
  it('verifies the override first, and answers Meta’s 422 when it does not pass', async () => {
    const { WamockEngine } = await import('../../src/core/engine.js')
    const { createServer } = await import('../../src/server.js')
    stubReceiver((url) => (url.host === 'good' ? echo(url) : new Response('no', { status: 403 })))
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: httpTransport('http://app/webhook'),
    })
    const app = createServer(engine)
    await app.ready()
    try {
      const subscribe = (url: string) =>
        app.inject({
          method: 'POST',
          url: `/v26.0/${engine.state.defaultWabaId}/subscribed_apps`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ override_callback_uri: url, verify_token: 'vt' }),
        })
      const bad = await subscribe('http://bad/hook')
      expect(bad.statusCode).toBe(422)
      expect(bad.json().error).toMatchObject({
        message: 'Webhook callback URL is not reachable or invalid',
        type: 'GraphMethodException',
        code: 100,
      })
      expect(engine.state.waba(engine.state.defaultWabaId)?.callbackOverride).toBeUndefined()

      expect((await subscribe('http://good/hook')).json()).toEqual({ success: true })
      expect(engine.state.waba(engine.state.defaultWabaId)?.callbackOverride?.url).toBe('http://good/hook')
    } finally {
      await app.close()
    }
  })

  it('verifies a number’s override the same way, and delivers only what Meta lets it override', async () => {
    const { WamockEngine } = await import('../../src/core/engine.js')
    const { createServer } = await import('../../src/server.js')
    const calls = stubReceiver((url, init) => {
      if (init?.method === 'POST') return new Response('ok')
      return url.host === 'bad' ? new Response('no', { status: 403 }) : echo(url)
    })
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: httpTransport('http://app/webhook'),
    })
    const app = createServer(engine)
    await app.ready()
    const pnid = engine.state.defaultPhoneNumberId
    try {
      const configure = (url: string) =>
        app.inject({
          method: 'POST',
          url: `/v26.0/${pnid}`,
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ webhook_configuration: { override_callback_uri: url, verify_token: 'nvt' } }),
        })
      const bad = await configure('http://bad/hook')
      expect(bad.statusCode).toBe(422)
      expect(bad.json().error.message).toBe('Webhook callback URL is not reachable or invalid')
      expect(engine.state.phoneNumber(pnid)?.callbackOverride).toBeUndefined()
      expect((await configure('http://number/hook')).json()).toEqual({ success: true })

      const read = await app.inject({ method: 'GET', url: `/v26.0/${pnid}?fields=webhook_configuration` })
      expect(read.json().webhook_configuration).toEqual({ phone_number: 'http://number/hook', application: 'http://app/webhook' })

      calls.length = 0
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      engine.createTemplate(engine.state.defaultWabaId, {
        name: 'order_update',
        language: 'es_MX',
        category: 'UTILITY',
        components: [{ type: 'BODY', text: 'Hola' }],
      })
      engine.transitionTemplate(engine.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
      await engine.flush()
      const posts = calls.filter((c) => c.method === 'POST').map((c) => c.url.host)
      // The message to the number's override; the template update to the app.
      expect(posts.sort()).toEqual(['app', 'number'])
    } finally {
      await app.close()
    }
  })

  it('refuses an unknown WABA before calling its override, with Graph’s unsupported post request', async () => {
    const { WamockEngine } = await import('../../src/core/engine.js')
    const calls = stubReceiver(echo)
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: httpTransport('http://app/webhook'),
    })
    const subscribe = engine.subscribeAppVerified('WABA_GHOST', { override_callback_uri: 'http://tenant/hook', verify_token: 'vt' })
    await expect(subscribe).rejects.toMatchObject({
      code: 100,
      message: expect.stringMatching(/^Unsupported post request\. Object with ID 'WABA_GHOST'/),
    })
    expect(calls).toEqual([])
  })

  it('runs the handshake again after engine.reset()', async () => {
    const { WamockEngine } = await import('../../src/core/engine.js')
    const calls = stubReceiver((url, init) => (init?.method === 'POST' ? new Response('ok') : echo(url)))
    const engine = new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: httpTransport('http://app/webhook', { verifyToken: 'tok' }),
    })
    const inbound = async () => {
      engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      await engine.flush()
    }
    await inbound()
    engine.reset()
    await inbound()
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'GET', 'POST'])
  })

  it('reports a challenge it could not read as a failed handshake, not an exception', async () => {
    stubReceiver(() => {
      const response = new Response('x', { status: 200 })
      Object.defineProperty(response, 'text', { value: () => Promise.reject(new Error('terminated')) })
      return response
    })
    const result = await verifyWebhookUrl('http://app/webhook', 'tok')
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('terminated') })
  })
})

describe('requests that wait on a handshake', () => {
  /** A receiver whose GET answers only when the test releases it. */
  function heldReceiver() {
    let release: () => void = () => {}
    const posts: string[] = []
    stubReceiver((url, init) => {
      if (init?.method === 'POST') {
        posts.push(url.host)
        return new Response('ok')
      }
      return new Promise<Response>((resolve) => (release = () => resolve(echo(url)))) as unknown as Response
    })
    return { posts, release: () => release() }
  }

  async function engineWith(verifyToken?: string) {
    const { WamockEngine } = await import('../../src/core/engine.js')
    return new WamockEngine({
      appSecret: 's',
      mode: 'frozen',
      start: 1_750_000_000_000,
      transport: httpTransport('http://app/webhook', verifyToken !== undefined ? { verifyToken } : {}),
    })
  }

  it('sends nothing when the WABA unsubscribed while the handshake ran, and does not bring it back', async () => {
    const receiver = heldReceiver()
    const engine = await engineWith('tok')
    engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    engine.clock.advance(0)
    await Promise.resolve()
    engine.unsubscribeApp(engine.state.defaultWabaId)
    receiver.release()
    await engine.settle()
    expect(receiver.posts).toEqual([])
    // Cancelled, not failed: nothing logged, and nothing retried once the app
    // subscribes again.
    expect(engine.deliverer.log()).toEqual([])
    engine.subscribeApp(engine.state.defaultWabaId)
    for (let i = 0; i < 10; i++) {
      engine.clock.advance(60_000)
      await engine.settle()
    }
    expect(receiver.posts).toEqual([])
  })

  it('cancels, rather than fails, an attempt whose handshake failed after an unsubscribe', async () => {
    let release: () => void = () => {}
    const posts: string[] = []
    stubReceiver((url, init) => {
      if (init?.method === 'POST') {
        posts.push(url.host)
        return new Response('ok')
      }
      return new Promise<Response>((resolve) => (release = () => resolve(new Response('no', { status: 403 })))) as unknown as Response
    })
    const engine = await engineWith('tok')
    engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    engine.clock.advance(0)
    await Promise.resolve()
    engine.unsubscribeApp(engine.state.defaultWabaId)
    release()
    await engine.settle()
    expect(engine.deliverer.log()).toEqual([])
    engine.subscribeApp(engine.state.defaultWabaId)
    for (let i = 0; i < 10; i++) {
      engine.clock.advance(60_000)
      await engine.settle()
    }
    expect(posts).toEqual([])
  })

  it('sends to the new callback when the override changed while the handshake ran', async () => {
    const receiver = heldReceiver()
    const engine = await engineWith()
    const waba = engine.state.defaultWabaId
    engine.subscribeApp(waba, { override_callback_uri: 'http://a/hook', verify_token: 'vt' })
    engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    engine.clock.advance(0)
    await Promise.resolve()
    engine.subscribeApp(waba, { override_callback_uri: 'http://b/hook', verify_token: 'vt' })
    receiver.release()
    await engine.settle()
    // Rerouted at once: the next tick sends it to B, after B's handshake.
    engine.clock.advance(0)
    await Promise.resolve()
    receiver.release()
    await engine.settle()
    expect(receiver.posts).toEqual(['b'])
  })

  it('hands a rerouted webhook to onWebhook once, in the library', async () => {
    const { createWamock } = await import('../../src/lib.js')
    let release: () => void = () => {}
    const posts: string[] = []
    stubReceiver((url, init) => {
      if (init?.method === 'POST') {
        posts.push(url.host)
        return new Response('ok')
      }
      if (url.host === 'a') return new Promise<Response>((resolve) => (release = () => resolve(echo(url)))) as unknown as Response
      return echo(url)
    })
    const seen: string[] = []
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      webhookUrl: 'http://app/webhook',
      onWebhook: (d) => void seen.push(d.payload.entry[0]!.changes[0]!.field),
    })
    try {
      const waba = mock.engine.state.defaultWabaId
      mock.engine.subscribeApp(waba, { override_callback_uri: 'http://a/hook', verify_token: 'vt' })
      mock.engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
      // The helper waits for everything its advance led to, the reroute too.
      const advance = mock.time.advance(0)
      await new Promise((resolve) => setTimeout(resolve, 10))
      mock.engine.subscribeApp(waba, { override_callback_uri: 'http://b/hook', verify_token: 'vt' })
      release()
      await advance
      expect(posts).toEqual(['b'])
      expect(seen).toEqual(['messages'])
    } finally {
      await mock.close()
    }
  })

  it('checks again before every POST, verified URL or not, through the library too', async () => {
    const { createWamock } = await import('../../src/lib.js')
    const posts: string[] = []
    stubReceiver((url, init) => {
      if (init?.method === 'POST') posts.push(url.host)
      return init?.method === 'POST' ? new Response('ok') : echo(url)
    })
    let hold: Promise<void> = Promise.resolve()
    let release: () => void = () => {}
    const mock = await createWamock({
      appSecret: 's',
      start: 1_750_000_000_000,
      webhookUrl: 'http://app/webhook',
      verifyToken: 'tok',
      onWebhook: () => hold,
    })
    try {
      await mock.inbound({ from: '5215555000001', text: 'primero' })
      expect(posts).toEqual(['app'])

      hold = new Promise<void>((resolve) => (release = resolve))
      const pending = mock.inbound({ from: '5215555000001', text: 'segundo' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      mock.engine.unsubscribeApp(mock.engine.state.defaultWabaId)
      release()
      await pending
      expect(posts).toEqual(['app'])
      expect(mock.engine.deliverer.log().filter((r) => !r.ok)).toEqual([])
    } finally {
      await mock.close()
    }
  })

  it('sends nothing when the mock was reset while the handshake ran', async () => {
    const receiver = heldReceiver()
    const engine = await engineWith('tok')
    engine.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    engine.clock.advance(0)
    await Promise.resolve()
    engine.reset()
    receiver.release()
    await engine.settle()
    expect(receiver.posts).toEqual([])
    expect(engine.deliverer.log()).toEqual([])
  })

  it('does not apply a subscription whose handshake outlived a reset', async () => {
    const receiver = heldReceiver()
    const engine = await engineWith()
    const waba = engine.state.defaultWabaId
    const pending = engine.subscribeAppVerified(waba, { override_callback_uri: 'http://tenant/hook', verify_token: 'vt' })
    await Promise.resolve()
    engine.reset()
    receiver.release()
    await expect(pending).rejects.toMatchObject({ code: 100 })
    expect(engine.state.waba(waba)?.callbackOverride).toBeUndefined()
  })
})
