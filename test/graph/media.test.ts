import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'
import { createServer } from '../../src/server.js'
import type { FastifyInstance } from 'fastify'

/**
 * Media, as Meta's media guide describes it: a multipart upload, an id that
 * lives 30 days, a download URL that lives 5 minutes and is renewed by asking
 * for the id again, a binary download that needs a token, and deletion.
 */

const EPOCH = 1_750_000_000_000
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])

const engine = () => new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError')
}

/** The message of a Graph error, as the API renders it. */
const messageOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.toBody('x').error.message
    throw err
  }
  throw new Error('expected a GraphError')
}

const upload = (e: WamockEngine, overrides: Record<string, unknown> = {}) =>
  e.uploadMedia(e.state.defaultPhoneNumberId, {
    messaging_product: 'whatsapp',
    type: 'image/jpeg',
    file: { bytes: JPEG, filename: 'photo.jpg', contentType: 'image/jpeg' },
    ...overrides,
  })

describe('uploading media', () => {
  it('answers with an id only, as Meta does', () => {
    const e = engine()
    expect(upload(e)).toEqual({ id: expect.stringMatching(/^\d+$/) })
  })

  it('is deterministic across a reset', () => {
    const e = engine()
    const first = upload(e).id
    e.reset()
    expect(upload(e).id).toBe(first)
  })

  it('requires messaging_product, a type and the file', () => {
    const e = engine()
    expect(codeOf(() => upload(e, { messaging_product: undefined }))).toBe(100)
    expect(codeOf(() => upload(e, { type: undefined, file: { bytes: JPEG } }))).toBe(100)
    expect(codeOf(() => upload(e, { file: undefined }))).toBe(100)
  })

  it('takes the type from the file part, as Meta’s own example sends it', () => {
    // `-F 'file=@video.mp4;type=video/mp4'` with no `type` field.
    const e = engine()
    const { id } = upload(e, { type: undefined, file: { bytes: JPEG, contentType: 'image/jpeg' } })
    expect(e.getMedia(id)['mime_type']).toBe('image/jpeg')
  })

  it('refuses a type that is only a property every object has', () => {
    const e = engine()
    for (const type of ['constructor', 'toString', '__proto__']) {
      expect(codeOf(() => upload(e, { type }))).toBe(100)
    }
  })

  it('refuses a type Meta does not support, such as a GIF or a made-up one', () => {
    const e = engine()
    expect(codeOf(() => upload(e, { type: 'image/gif' }))).toBe(100)
    expect(codeOf(() => upload(e, { type: 'made/up' }))).toBe(100)
  })

  it('enforces the size limit of the type: 5 MB for an image', () => {
    const e = engine()
    const big = Buffer.alloc(5 * 1024 * 1024 + 1)
    expect(codeOf(() => upload(e, { file: { bytes: big } }))).toBe(100)
    expect(() => upload(e, { file: { bytes: Buffer.alloc(5 * 1024 * 1024) } })).not.toThrow()
  })

  // Meta's "Supported media types" table, one small file each.
  it.each([
    'audio/aac',
    'audio/amr',
    'audio/mpeg',
    'audio/mp4',
    'audio/ogg',
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'video/3gpp',
    'video/mp4',
  ])('accepts %s, a type Meta supports', (type) => {
    const e = engine()
    const { id } = upload(e, { type, file: { bytes: JPEG } })
    expect(e.getMedia(id)['mime_type']).toBe(type)
  })

  it('reads the type as MIME types are read: case-insensitive, parameters aside', () => {
    const e = engine()
    expect(e.getMedia(upload(e, { type: 'Image/PNG' }).id)['mime_type']).toBe('image/png')
    expect(e.getMedia(upload(e, { type: 'image/png ; name=p.png' }).id)['mime_type']).toBe('image/png')
  })

  it('takes the type field over the file part’s, and an empty field as none', () => {
    const e = engine()
    const png = { bytes: JPEG, contentType: 'image/png' }
    expect(e.getMedia(upload(e, { type: 'image/jpeg', file: png }).id)['mime_type']).toBe('image/jpeg')
    expect(e.getMedia(upload(e, { type: '', file: png }).id)['mime_type']).toBe('image/png')
  })

  it('rejects an unknown phone number', () => {
    expect(codeOf(() => engine().uploadMedia('PNID_GHOST', { messaging_product: 'whatsapp', type: 'image/jpeg', file: { bytes: JPEG } }))).toBe(100)
  })
})

describe('getting a media URL', () => {
  it('returns Meta’s envelope, with file_size as a string', () => {
    const e = engine()
    const { id } = upload(e)
    expect(e.getMedia(id)).toEqual({
      messaging_product: 'whatsapp',
      url: expect.stringContaining(`mid=${id}`),
      mime_type: 'image/jpeg',
      sha256: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/),
      file_size: String(JPEG.length),
      id,
    })
  })

  it('keeps the id valid for 30 days, and renews the URL on every lookup', () => {
    const e = engine()
    const { id } = upload(e)
    const first = e.getMedia(id)['url']
    e.clock.advance(10 * MINUTE)
    // The old URL is dead by now, but the id still answers with a new one.
    const second = e.getMedia(id)['url']
    expect(second).not.toBe(first)
    e.clock.advance(30 * DAY - 10 * MINUTE - 1)
    expect(() => e.getMedia(id)).not.toThrow()
    e.clock.advance(1)
    expect(codeOf(() => e.getMedia(id))).toBe(100)
  })

  it('answers only for the number that uploaded it, when phone_number_id is given', () => {
    const e = engine()
    const { id } = upload(e)
    expect(() => e.getMedia(id, { phoneNumberId: e.state.defaultPhoneNumberId })).not.toThrow()
    expect(codeOf(() => e.getMedia(id, { phoneNumberId: 'PNID_OTHER' }))).toBe(100)
  })

  it('rejects a media id it never issued, with Graph’s unsupported get request', () => {
    expect(codeOf(() => engine().getMedia('999999999999999'))).toBe(100)
    expect(messageOf(() => engine().getMedia('999999999999999'))).toMatch(
      /^Unsupported get request\. Object with ID '999999999999999' does not exist/,
    )
  })
})

describe('deleting media', () => {
  it('answers success and forgets the id', () => {
    const e = engine()
    const { id } = upload(e)
    expect(e.deleteMedia(id)).toEqual({ success: true })
    expect(codeOf(() => e.getMedia(id))).toBe(100)
    expect(messageOf(() => e.deleteMedia(id))).toMatch(new RegExp(`^Unsupported delete request\\. Object with ID '${id}'`))
  })

  it('honours phone_number_id like the lookup does', () => {
    const e = engine()
    const { id } = upload(e)
    expect(codeOf(() => e.deleteMedia(id, { phoneNumberId: 'PNID_OTHER' }))).toBe(100)
    expect(() => e.getMedia(id)).not.toThrow()
  })
})

// The signing key's value and the hash's length are not contract: what
// matters, pinned here, is that a URL only works exactly as issued.
describe('downloading by URL', () => {
  const query = (url: string) => Object.fromEntries(new URL(url).searchParams) as { mid: string; ext: string; hash: string }

  it('serves the bytes only for a URL exactly as issued', () => {
    const e = engine()
    const { id } = upload(e)
    const { id: other } = upload(e)
    const issued = query(e.getMedia(id)['url'] as string)
    expect(e.downloadMedia(issued)?.bytes.equals(JPEG)).toBe(true)

    const forged = (changes: Record<string, string | undefined>) => {
      const q: Record<string, string> = {}
      for (const [k, v] of Object.entries({ ...issued, ...changes })) if (v !== undefined) q[k] = v
      return e.downloadMedia(q)
    }
    // A URL cannot be stretched past its 5 minutes, pointed at other media,
    // or used without its hash.
    expect(forged({ ext: String(Number(issued.ext) + 3600) })).toBeUndefined()
    expect(forged({ mid: other })).toBeUndefined()
    expect(forged({ hash: issued.hash.replace(/^./, (c) => (c === '0' ? '1' : '0')) })).toBeUndefined()
    expect(forged({ hash: undefined })).toBeUndefined()
    expect(forged({ hash: '' })).toBeUndefined()
  })
})

describe('media Meta cannot use', () => {
  it('fails the status with 131053 and the error code reference’s details', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    e.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: '5215555000001',
      type: 'image',
      image: { link: 'not a URL' },
    })
    e.clock.advance(MINUTE)
    await e.settle()
    const failed = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).find((st) => st?.status === 'failed')
    expect(failed.errors[0].error_data).toEqual({
      details: 'The media could not be uploaded for one or more reasons, such as an unsupported media type.',
    })
  })

  // What each message kind can carry, by Meta's supported media types.
  it.each([
    ['image', 'image/jpeg'],
    ['image', 'image/png'],
    ['video', 'video/3gpp'],
    ['video', 'video/mp4'],
    ['audio', 'audio/aac'],
    ['audio', 'audio/amr'],
    ['audio', 'audio/mpeg'],
    ['audio', 'audio/mp4'],
    ['audio', 'audio/ogg'],
    ['sticker', 'image/webp'],
    ['document', 'text/plain'],
    ['document', 'application/vnd.ms-excel'],
    ['document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['document', 'application/msword'],
    ['document', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['document', 'application/vnd.ms-powerpoint'],
    ['document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['document', 'application/pdf'],
  ])('sends an uploaded %s of type %s by its id', (kind, type) => {
    const e = engine()
    e.simulateInbound({ from: '5215555000001', message: { type: 'text', text: { body: 'hola' } } })
    const { id } = upload(e, { type, file: { bytes: JPEG } })
    expect(() =>
      e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', to: '5215555000001', type: kind, [kind]: { id } }),
    ).not.toThrow()
  })
})

describe('media over HTTP', () => {
  let e: WamockEngine
  let app: FastifyInstance

  beforeEach(async () => {
    e = engine()
    app = createServer(e)
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
  })

  const multipart = (fields: Record<string, string>, file?: { bytes: Buffer; type: string; name: string }) => {
    const boundary = '----wamock-test-boundary'
    const parts: Buffer[] = []
    for (const [name, value] of Object.entries(fields)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
    }
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
        ),
        file.bytes,
        Buffer.from('\r\n'),
      )
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`))
    return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
  }

  it('uploads with the multipart body Meta documents, then downloads the same bytes', async () => {
    const body = multipart({ messaging_product: 'whatsapp', type: 'image/jpeg' }, { bytes: JPEG, type: 'image/jpeg', name: 'p.jpg' })
    const res = await app.inject({ method: 'POST', url: `/v26.0/${e.state.defaultPhoneNumberId}/media`, ...body })
    expect(res.statusCode).toBe(200)
    const { id } = res.json()

    const meta = (await app.inject({ method: 'GET', url: `/v26.0/${id}`, headers: { host: 'localhost:4004' } })).json()
    const url = new URL(meta.url)
    expect(url.host).toBe('localhost:4004')

    const download = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: { authorization: 'Bearer any' } })
    expect(download.statusCode).toBe(200)
    expect(download.headers['content-type']).toBe('image/jpeg')
    expect(download.rawPayload.equals(JPEG)).toBe(true)
  })

  it('needs a token to download, and answers 404 once the URL is 5 minutes old', async () => {
    const { id } = upload(e)
    const url = new URL(e.getMedia(id, { baseUrl: 'http://localhost:4004' })['url'] as string)
    const path = url.pathname + url.search

    expect((await app.inject({ method: 'GET', url: path })).statusCode).toBe(401)
    e.clock.advance(5 * MINUTE)
    expect((await app.inject({ method: 'GET', url: path, headers: { authorization: 'Bearer any' } })).statusCode).toBe(404)
  })

  it('deletes with DELETE /{media_id}', async () => {
    const { id } = upload(e)
    const res = await app.inject({ method: 'DELETE', url: `/v26.0/${id}` })
    expect(res.json()).toEqual({ success: true })
  })

  it('refuses a JSON upload, which carries no file', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v26.0/${e.state.defaultPhoneNumberId}/media`,
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ messaging_product: 'whatsapp', type: 'image/jpeg' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.error_data.details).toMatch(/file/)
  })
})
