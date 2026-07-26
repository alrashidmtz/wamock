import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { httpTransport, inProcessTransport, nullTransport } from '../../src/webhooks/transport.js'
import type { WebhookDelivery } from '../../src/webhooks/transport.js'

const delivery = (): WebhookDelivery => ({
  body: '{"object":"whatsapp_business_account","entry":[]}',
  signature: 'sha256=deadbeef',
  payload: { object: 'whatsapp_business_account', entry: [] },
  deliveredAt: 1_750_000_000_000,
})

let receiver: FastifyInstance | undefined

afterEach(async () => {
  await receiver?.close()
  receiver = undefined
})

interface CapturedRequest {
  headers: Record<string, string | string[] | undefined>
  rawBody: string
}

async function startReceiver(status = 200): Promise<{ url: string; seen: CapturedRequest[] }> {
  const seen: CapturedRequest[] = []
  receiver = Fastify()
  // Capture the RAW bytes: the whole point of the signature is that it covers
  // exactly what came off the socket.
  receiver.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, { raw: body as string })
  })
  receiver.post('/webhook', async (request, reply) => {
    seen.push({ headers: request.headers, rawBody: (request.body as { raw: string }).raw })
    return reply.status(status).send('ok')
  })
  const address = await receiver.listen({ port: 0, host: '127.0.0.1' })
  return { url: `${address}/webhook`, seen }
}

describe('httpTransport', () => {
  it('POSTs the body untouched, byte for byte', async () => {
    const { url, seen } = await startReceiver()

    await httpTransport(url)(delivery())

    expect(seen[0]!.rawBody).toBe(delivery().body)
  })

  it('sends the signature in the X-Hub-Signature-256 header Meta uses', async () => {
    const { url, seen } = await startReceiver()

    await httpTransport(url)(delivery())

    expect(seen[0]!.headers['x-hub-signature-256']).toBe('sha256=deadbeef')
    expect(seen[0]!.headers['content-type']).toContain('application/json')
  })

  it('rejects when the receiver answers with an error status', async () => {
    // A receiver returning 500 must surface as a failed delivery, not a silent
    // success — otherwise a broken integration looks healthy in the log.
    const { url } = await startReceiver(500)

    await expect(httpTransport(url)(delivery())).rejects.toThrow(/500/)
  })

  it('rejects when nothing is listening', async () => {
    await expect(httpTransport('http://127.0.0.1:1/webhook')(delivery())).rejects.toThrow()
  })
})

describe('inProcessTransport', () => {
  it('hands the delivery straight to the handler with no network', async () => {
    const handler = vi.fn()

    await inProcessTransport(handler)(delivery())

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ signature: 'sha256=deadbeef' }))
  })

  it('awaits an async handler before resolving', async () => {
    let finished = false
    const handler = async () => {
      await new Promise((r) => setTimeout(r, 10))
      finished = true
    }

    await inProcessTransport(handler)(delivery())

    expect(finished).toBe(true)
  })

  it('propagates a handler failure so it lands in the delivery log', async () => {
    const handler = () => {
      throw new Error('receiver blew up')
    }

    await expect(inProcessTransport(handler)(delivery())).rejects.toThrow('receiver blew up')
  })
})

describe('nullTransport', () => {
  it('accepts everything and resolves', async () => {
    await expect(nullTransport(delivery())).resolves.toBeUndefined()
  })
})
