import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { createServer } from '../src/server.js'

/**
 * Every inbound message type a customer can send, as Meta's messages webhook
 * references show them. Integrations meet photos, voice notes, locations and
 * reactions on day one; a mock that can only simulate text leaves all of that
 * untested.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

function harness() {
  const bodies: string[] = []
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void bodies.push(d.body) })
  const lastMessage = async () => {
    e.clock.advance(0)
    await e.settle()
    return JSON.parse(bodies.at(-1)!).entry[0].changes[0].value.messages[0]
  }
  return { e, lastMessage }
}

describe('inbound media', () => {
  it('delivers an image with Meta’s fields, downloadable through the media API', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'image', image: { caption: 'Taj Mahal', mime_type: 'image/jpeg' } } })
    const message = await lastMessage()

    expect(message.image).toEqual({
      caption: 'Taj Mahal',
      mime_type: 'image/jpeg',
      sha256: expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/),
      id: expect.stringMatching(/^\d+$/),
      url: expect.stringContaining('/whatsapp_business/attachments/?mid='),
    })
    expect(e.getMedia(message.image.id)).toMatchObject({ mime_type: 'image/jpeg', sha256: message.image.sha256 })
  })

  it('keeps a received media id for 7 days, not 30', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'document', document: { filename: 'r.pdf', mime_type: 'application/pdf' } } })
    const { document } = await lastMessage()
    e.clock.advance(7 * 24 * 60 * 60 * 1000 - 1)
    expect(() => e.getMedia(document.id)).not.toThrow()
    e.clock.advance(1)
    expect(() => e.getMedia(document.id)).toThrow()
  })

  it('serves the bytes the test supplied', async () => {
    const { e, lastMessage } = harness()
    const bytes = Buffer.from('%PDF-1.4 fake')
    e.simulateInbound({ from: CUSTOMER, message: { type: 'document', document: { mime_type: 'application/pdf', bytes } } })
    const { document } = await lastMessage()
    const url = new URL(e.getMedia(document.id)['url'] as string)
    const downloaded = e.downloadMedia(Object.fromEntries(url.searchParams))
    expect(downloaded?.bytes.equals(bytes)).toBe(true)
    expect(document).not.toHaveProperty('bytes')
  })

  it('reports the MIME type the test gave, and the formats WhatsApp clients send otherwise', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'image', image: { mime_type: 'image/png' } } })
    expect((await lastMessage()).image.mime_type).toBe('image/png')
    e.simulateInbound({ from: CUSTOMER, message: { type: 'audio', audio: {} } })
    expect((await lastMessage()).audio.mime_type).toBe('audio/mpeg')
    e.simulateInbound({ from: CUSTOMER, message: { type: 'video', video: {} } })
    expect((await lastMessage()).video.mime_type).toBe('video/mp4')
  })

  it('serves some bytes when the test supplied none', async () => {
    // A received file is never empty; an empty body would hash and download
    // like a broken attachment.
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'image', image: {} } })
    const { image } = await lastMessage()
    const url = new URL(e.getMedia(image.id)['url'] as string)
    expect(e.downloadMedia(Object.fromEntries(url.searchParams))!.bytes.length).toBeGreaterThan(0)
  })

  it('marks a voice note, and an animated sticker', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'audio', audio: { voice: true } } })
    expect((await lastMessage()).audio).toMatchObject({ mime_type: 'audio/ogg; codecs=opus', voice: true })
    e.simulateInbound({ from: CUSTOMER, message: { type: 'sticker', sticker: { animated: true } } })
    expect((await lastMessage()).sticker).toMatchObject({ mime_type: 'image/webp', animated: true })
  })
})

describe('inbound location, contacts and reactions', () => {
  it('passes them through as Meta shapes them', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'location', location: { latitude: 37.44, longitude: -122.16, name: 'Philz' } } })
    expect((await lastMessage()).location).toEqual({ latitude: 37.44, longitude: -122.16, name: 'Philz' })

    e.simulateInbound({ from: CUSTOMER, message: { type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } } })
    expect((await lastMessage()).reaction).toEqual({ message_id: 'wamid.X', emoji: '👍' })
  })
})

describe('removed reactions and the media flags', () => {
  it('reports a removed reaction without emoji, as Meta does', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'reaction', reaction: { message_id: 'wamid.X' } } })
    expect((await lastMessage()).reaction).toEqual({ message_id: 'wamid.X' })
  })

  it('always says whether audio is a voice note and a sticker is animated', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'audio', audio: {} } })
    expect((await lastMessage()).audio.voice).toBe(false)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'sticker', sticker: {} } })
    expect((await lastMessage()).sticker.animated).toBe(false)
  })
})

describe('replies and quick replies', () => {
  it('carries context {from, id} when the customer replies to a message', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, contextId: 'wamid.ORIGINAL', message: { type: 'text', text: { body: 'sí' } } })
    expect((await lastMessage()).context).toEqual({ from: '15550001111', id: 'wamid.ORIGINAL' })
  })

  it('delivers a template quick-reply tap as type button', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, contextId: 'wamid.TEMPLATE', message: { type: 'button', button: { payload: 'STOP', text: 'Stop promotions' } } })
    const message = await lastMessage()
    expect(message).toMatchObject({ type: 'button', button: { payload: 'STOP', text: 'Stop promotions' }, context: { id: 'wamid.TEMPLATE' } })
  })

  it('reports an unsupported message with 131051', async () => {
    const { e, lastMessage } = harness()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'unsupported', unsupported: { type: 'edit' } } })
    expect(await lastMessage()).toMatchObject({
      type: 'unsupported',
      unsupported: { type: 'edit' },
      errors: [
        {
          code: 131051,
          title: 'Message type unknown',
          message: 'Message type unknown',
          error_data: { details: 'Message type is currently not supported.' },
        },
      ],
    })
  })
})

describe('the same through the control API and the library', () => {
  it('takes every type on POST /__mock/inbound', async () => {
    const bodies: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void bodies.push(d.body) })
    const app = createServer(e)
    await app.ready()
    const post = (payload: unknown) => app.inject({ method: 'POST', url: '/__mock/inbound', payload: JSON.stringify(payload) })
    const last = () => JSON.parse(bodies.at(-1)!).entry[0].changes[0].value.messages[0]
    try {
      await post({ from: CUSTOMER, image: { caption: 'foto' } })
      expect(last()).toMatchObject({ type: 'image', image: { caption: 'foto', mime_type: 'image/jpeg' } })
      await post({ from: CUSTOMER, location: { latitude: 1, longitude: 2 } })
      expect(last().location).toEqual({ latitude: 1, longitude: 2 })
      await post({ from: CUSTOMER, reaction: { message_id: 'wamid.X', emoji: '❤️' } })
      expect(last().type).toBe('reaction')
      await post({ from: CUSTOMER, button: { payload: 'P', text: 'T' }, context_id: 'wamid.T' })
      expect(last()).toMatchObject({ type: 'button', context: { id: 'wamid.T' } })
      await post({ from: CUSTOMER, text: 'x', context_id: 'wamid.R' })
      expect(last().context).toEqual({ from: '15550001111', id: 'wamid.R' })
      const bad = await post({ from: CUSTOMER, image: { colour: 'red' } })
      expect(bad.json().error.error_data.details).toBe("image: Unrecognized key(s) in object: 'colour'")
    } finally {
      await app.close()
    }
  })

  it('takes every type in mock.inbound', async () => {
    const { createWamock } = await import('../src/lib.js')
    const payloads: string[] = []
    const mock = await createWamock({ appSecret: 's', start: EPOCH, onWebhook: (d) => void payloads.push(d.body) })
    try {
      await mock.inbound({ from: CUSTOMER, document: { filename: 'a.pdf', bytes: Buffer.from('x') } })
      await mock.inbound({ from: CUSTOMER, contacts: [{ name: { formatted_name: 'Ana' } }] })
      await mock.inbound({ from: CUSTOMER, text: 'ok', contextId: 'wamid.R' })
      await mock.inbound({ from: CUSTOMER, reaction: { message_id: 'wamid.R' } })
      await mock.inbound({ from: CUSTOMER, unsupported: { type: 'edit' } })
      const types = payloads.map((b) => JSON.parse(b).entry[0].changes[0].value.messages[0])
      expect(types.map((m) => m.type)).toEqual(['document', 'contacts', 'text', 'reaction', 'unsupported'])
      expect(types[4].errors[0].code).toBe(131051)
      expect(types[0].document).toMatchObject({ filename: 'a.pdf', mime_type: 'application/pdf' })
      expect(types[2].context.id).toBe('wamid.R')
    } finally {
      await mock.close()
    }
  })
})
