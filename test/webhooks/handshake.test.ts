import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

import { verifyWebhookUrl } from '../../src/webhooks/handshake.js'

/**
 * These run against a real HTTP receiver on an ephemeral port rather than a
 * mocked fetch: the handshake is precisely the thing that fails over the wire
 * (wrong content type, wrong body, a framework helpfully JSON-wrapping the
 * challenge), so faking the wire would test nothing.
 */

let receiver: FastifyInstance | undefined

afterEach(async () => {
  await receiver?.close()
  receiver = undefined
})

async function startReceiver(
  handler: (query: Record<string, string>) => { status: number; body: string },
): Promise<string> {
  receiver = Fastify()
  const seen: Record<string, string>[] = []
  receiver.get('/webhook', async (request, reply) => {
    const query = request.query as Record<string, string>
    seen.push(query)
    const result = handler(query)
    return reply.status(result.status).type('text/plain').send(result.body)
  })
  receiver.decorate('seen', seen)
  const address = await receiver.listen({ port: 0, host: '127.0.0.1' })
  return `${address}/webhook`
}

const echoIfTokenMatches =
  (expectedToken: string) =>
  (query: Record<string, string>): { status: number; body: string } =>
    query['hub.mode'] === 'subscribe' && query['hub.verify_token'] === expectedToken
      ? { status: 200, body: query['hub.challenge'] ?? '' }
      : { status: 403, body: 'Forbidden' }

describe('verifyWebhookUrl', () => {
  it('succeeds when the receiver echoes the challenge', async () => {
    const url = await startReceiver(echoIfTokenMatches('vt'))
    await expect(verifyWebhookUrl(url, 'vt')).resolves.toMatchObject({ ok: true })
  })

  it('sends hub.mode=subscribe with a token and a challenge, like Meta', async () => {
    const seen: Record<string, string>[] = []
    const url = await startReceiver((query) => {
      seen.push(query)
      return { status: 200, body: query['hub.challenge'] ?? '' }
    })

    await verifyWebhookUrl(url, 'vt')

    expect(seen[0]).toMatchObject({ 'hub.mode': 'subscribe', 'hub.verify_token': 'vt' })
    expect(seen[0]!['hub.challenge']).toEqual(expect.any(String))
  })

  it('fails when the receiver rejects the verify token', async () => {
    const url = await startReceiver(echoIfTokenMatches('the-right-token'))
    await expect(verifyWebhookUrl(url, 'the-wrong-token')).resolves.toMatchObject({ ok: false })
  })

  it('fails when the receiver answers 200 but echoes the wrong body', async () => {
    // A receiver that replies "ok" instead of the challenge looks healthy and
    // is not. Meta rejects it; so does wamock.
    const url = await startReceiver(() => ({ status: 200, body: 'ok' }))

    const result = await verifyWebhookUrl(url, 'vt')

    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/challenge/i)
  })

  it('fails without throwing on a malformed URL', async () => {
    const result = await verifyWebhookUrl('not-a-url', 'vt')
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/valid URL/i)
  })

  it('fails without throwing when nothing is listening', async () => {
    const result = await verifyWebhookUrl('http://127.0.0.1:1/webhook', 'vt')
    expect(result.ok).toBe(false)
    expect(result.reason).toEqual(expect.any(String))
  })

  it('preserves a query string already present on the webhook url', async () => {
    const seen: Record<string, string>[] = []
    const base = await startReceiver((query) => {
      seen.push(query)
      return { status: 200, body: query['hub.challenge'] ?? '' }
    })

    const result = await verifyWebhookUrl(`${base}?tenant=acme`, 'vt')

    expect(result.ok).toBe(true)
    expect(seen[0]).toMatchObject({ tenant: 'acme', 'hub.mode': 'subscribe' })
  })
})
