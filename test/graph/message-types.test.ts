import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import type { GraphError } from '../../src/errors/graph-error.js'

/**
 * Every message type Meta's Messages API accepts besides text, template and
 * the reply-button / list interactives. Each used to be refused with (#100),
 * so an app sending a photo worked against Meta and failed against wamock.
 * Rules are from the per-type pages under messages/ in Meta's documentation.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

function engine(openWindow = true) {
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
  if (openWindow) e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
  return e
}

const send = (e: WamockEngine, type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', to: CUSTOMER, type, [type]: content, ...extra })

const failure = (fn: () => unknown): { code: number; details: string } => {
  try {
    fn()
  } catch (err) {
    const body = (err as GraphError).toBody('x').error
    return { code: body.code, details: body.error_data?.details ?? '' }
  }
  throw new Error('expected a GraphError')
}

/** An engine whose webhooks are captured, and the statuses one message got. */
function withWebhooks() {
  const received: string[] = []
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
  const statusesOf = (id: string) =>
    received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((st) => st?.id === id)
  const flush = async (ms = 60_000) => {
    e.clock.advance(ms)
    await e.settle()
  }
  return { e, statusesOf, flush }
}

describe('media messages', () => {
  const MIME: Record<string, string> = {
    image: 'image/jpeg',
    audio: 'audio/mpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    sticker: 'image/webp',
  }

  it.each(['image', 'audio', 'video', 'document', 'sticker'])('sends %s by link or by an uploaded id', (type) => {
    const e = engine()
    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: MIME[type],
      file: { bytes: Buffer.from('bytes') },
    })
    expect(() => send(e, type, { link: 'https://example.com/file' })).not.toThrow()
    expect(() => send(e, type, { id })).not.toThrow()
    expect(e.state.outbound().map((m) => m.type)).toEqual([type, type])
  })

  it('checks a media id wherever it sits: an interactive header, a template parameter', () => {
    const e = engine()
    const ghost = '999999999999999999'
    const buttons = {
      type: 'button',
      header: { type: 'image', image: { id: ghost } },
      body: { text: 'Pick' },
      action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] },
    }
    expect(failure(() => send(e, 'interactive', buttons)).code).toBe(131009)

    e.createTemplate(e.state.defaultWabaId, {
      name: 'with_image',
      language: 'es_MX',
      category: 'UTILITY',
      components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Hola' }],
    })
    e.transitionTemplate(e.state.defaultWabaId, 'with_image', 'es_MX', 'APPROVED')
    const template = {
      name: 'with_image',
      language: { code: 'es_MX' },
      components: [{ type: 'header', parameters: [{ type: 'image', image: { id: ghost } }] }],
    }
    expect(failure(() => send(e, 'template', template)).details).toMatch(/template parameter image\[id\]/)

    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('x') },
    })
    expect(() => send(e, 'interactive', { ...buttons, header: { type: 'image', image: { id } } })).not.toThrow()
  })

  it('refuses at once a media id whose type the message cannot carry, with 131053', () => {
    const e = engine()
    const { id: pdf } = e.uploadMedia(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: 'application/pdf',
      file: { bytes: Buffer.from('%PDF') },
    })
    expect(failure(() => send(e, 'image', { id: pdf })).code).toBe(131053)
    const buttons = {
      type: 'button',
      header: { type: 'image', image: { id: pdf } },
      body: { text: 'Pick' },
      action: { buttons: [{ type: 'reply', reply: { id: 'a', title: 'A' } }] },
    }
    expect(failure(() => send(e, 'interactive', buttons)).code).toBe(131053)
    expect(() => send(e, 'document', { id: pdf })).not.toThrow()
  })

  it('accepts a link it cannot fetch, then fails it on the status with 131053', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'image', { link: 'this is not a URL' }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()
    const statuses = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((st) => st?.id === id)
    expect(statuses.map((st) => [st.status, st.errors?.[0]?.code])).toEqual([['failed', 131053]])
    expect(statuses[0].errors[0].title).toBe('Unable to upload the media used in the message.')
    expect(statuses[0]).not.toHaveProperty('pricing')
  })

  it('sends back a voice note a customer sent, by its id', async () => {
    // A received voice note is `audio/ogg; codecs=opus`: Ogg audio, which an
    // audio message carries. Only the base type decides.
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    e.simulateInbound({ from: CUSTOMER, message: { type: 'audio', audio: { voice: true } } })
    e.clock.advance(0)
    await e.settle()
    const audio = JSON.parse(received[0]!).entry[0].changes[0].value.messages[0].audio
    expect(audio.mime_type).toBe('audio/ogg; codecs=opus')

    const id = send(e, 'audio', { id: audio.id, voice: true }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()
    const statuses = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((st) => st?.id === id)
    expect(statuses.map((st) => st.status)).toEqual(['sent', 'delivered'])
  })

  it('refuses a media id nobody uploaded, or one past its 30 days, with 131009', () => {
    const e = engine()
    expect(failure(() => send(e, 'image', { id: '1013859600285441' })).code).toBe(131009)

    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: 'image/jpeg',
      file: { bytes: Buffer.from('bytes') },
    })
    e.clock.advance(30 * 24 * 60 * 60 * 1000)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    expect(failure(() => send(e, 'image', { id })).code).toBe(131009)
  })

  it.each(['image', 'audio', 'video', 'document', 'sticker'])('%s needs exactly one of id and link', (type) => {
    const e = engine()
    expect(failure(() => send(e, type, {})).code).toBe(100)
    expect(failure(() => send(e, type, { id: '1', link: 'https://example.com/f' })).code).toBe(100)
  })

  it.each(['image', 'video', 'document'])('%s caption is capped at 1024', (type) => {
    const e = engine()
    expect(() => send(e, type, { link: 'https://example.com/f', caption: 'x'.repeat(1024) })).not.toThrow()
    expect(failure(() => send(e, type, { link: 'https://example.com/f', caption: 'x'.repeat(1025) })).details).toMatch(/1024/)
  })

  it('takes a document filename and an audio voice flag', () => {
    const e = engine()
    expect(() => send(e, 'document', { link: 'https://example.com/f.pdf', filename: 'invoice.pdf' })).not.toThrow()
    expect(() => send(e, 'audio', { link: 'https://example.com/v.ogg', voice: true })).not.toThrow()
    expect(failure(() => send(e, 'audio', { link: 'https://example.com/v.ogg', voice: 'yes' })).code).toBe(100)
  })

  it('delivers a send by an http or https link, and fails one by any other scheme on its status', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const links = ['https://example.com/a.jpg', 'http://example.com/a.jpg', 'ftp://example.com/a.jpg', 'file:///tmp/a.jpg']
    const ids = links.map((link) => send(e, 'image', { link }).messages[0]!.id)
    await flush()
    expect(ids.map((id) => statusesOf(id).map((st) => st.errors?.[0]?.code ?? st.status))).toEqual([
      ['sent', 'delivered'],
      ['sent', 'delivered'],
      [131053],
      [131053],
    ])
  })

  it('echoes biz_opaque_callback_data on a status that fails', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'image', { link: 'ftp://example.com/a.jpg' }, { biz_opaque_callback_data: 'order-7' }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((st) => [st.status, st.biz_opaque_callback_data])).toEqual([['failed', 'order-7']])
  })

  it('does not open a free entry point window with a send that fails on its status', async () => {
    // The window opens with the first reply that is delivered: a failed one
    // is not priced at all, so the next reply is the one that opens it.
    const HOUR = 60 * 60 * 1000
    const { e, statusesOf, flush } = withWebhooks()
    const referral = { source_url: 'https://fb.me/3cr4Wqqkv', source_id: '120226305854810726', source_type: 'ad' }
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'info?' }, referral } })
    send(e, 'image', { link: 'ftp://example.com/a.jpg' })
    e.clock.advance(HOUR)
    const id = send(e, 'text', { body: 'hola' }).messages[0]!.id
    await flush()
    const sent = statusesOf(id).find((st) => st.status === 'sent')
    expect(sent.conversation.expiration_timestamp).toBe(String((EPOCH + HOUR + 7 * 24 * HOUR) / 1000))
  })

  it.each(['image', 'audio', 'video', 'document', 'sticker'])('%s counts an empty or non-string id or link as absent', (type) => {
    const e = engine()
    for (const content of [{ id: '' }, { link: '' }, { id: 123 }, { link: 123 }]) {
      expect(failure(() => send(e, type, content)).code).toBe(100)
    }
  })

  it.each(['image', 'audio', 'video', 'document', 'sticker'])('%s refuses a payload that is not an object with 100', (type) => {
    const e = engine()
    expect(failure(() => send(e, type, null)).code).toBe(100)
    expect(failure(() => send(e, type, undefined)).code).toBe(100)
  })

  it.each(['audio', 'sticker'])('%s takes no caption', (type) => {
    const e = engine()
    expect(failure(() => send(e, type, { link: 'https://example.com/f', caption: 'hola' })).code).toBe(100)
  })

  it('refuses a caption or a document filename that is not a string', () => {
    const e = engine()
    expect(failure(() => send(e, 'image', { link: 'https://example.com/f', caption: 5 })).code).toBe(100)
    expect(failure(() => send(e, 'document', { link: 'https://example.com/f.pdf', filename: 5 })).code).toBe(100)
  })

  it('reads a template component that carries no parameters', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, { name: 'plain', language: 'es_MX', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hola' }] })
    e.transitionTemplate(e.state.defaultWabaId, 'plain', 'es_MX', 'APPROVED')
    const template = { name: 'plain', language: { code: 'es_MX' }, components: [{ type: 'body' }] }
    expect(() => send(e, 'template', template)).not.toThrow()
  })

  it('needs an open service window, like every non-template message', () => {
    const e = engine(false)
    expect(failure(() => send(e, 'image', { link: 'https://example.com/f' })).code).toBe(131047)
  })
})

describe('location messages', () => {
  it('sends with latitude and longitude, as numbers or numeric strings', () => {
    const e = engine()
    expect(() => send(e, 'location', { latitude: 37.44, longitude: -122.16, name: 'Philz', address: '101 Forest Ave' })).not.toThrow()
    expect(() => send(e, 'location', { latitude: '37.44216251868683', longitude: '-122.16153582049394' })).not.toThrow()
  })

  it('refuses a missing or out-of-range coordinate', () => {
    const e = engine()
    expect(failure(() => send(e, 'location', { latitude: 37.44 })).code).toBe(100)
    expect(failure(() => send(e, 'location', { latitude: 91, longitude: 0 })).code).toBe(100)
    expect(failure(() => send(e, 'location', { latitude: 0, longitude: 'east' })).code).toBe(100)
  })

  it('takes the poles and the antimeridian, both ways', () => {
    const e = engine()
    expect(() => send(e, 'location', { latitude: 90, longitude: 180 })).not.toThrow()
    expect(() => send(e, 'location', { latitude: -90, longitude: -180 })).not.toThrow()
  })

  it('refuses a coordinate that is blank, a boolean or null, and a missing location', () => {
    const e = engine()
    for (const latitude of [' ', true, null]) {
      expect(failure(() => send(e, 'location', { latitude, longitude: 0 })).code).toBe(100)
    }
    expect(failure(() => send(e, 'location', undefined)).code).toBe(100)
  })
})

describe('contacts messages', () => {
  it('sends contact cards with a formatted name', () => {
    const e = engine()
    expect(() =>
      send(e, 'contacts', [{ name: { formatted_name: 'Pablo Morales', first_name: 'Pablo' }, phones: [{ phone: '+16505551234', type: 'WORK', wa_id: '16505551234' }] }]),
    ).not.toThrow()
  })

  it('refuses an empty list, a card without formatted_name, and unknown properties', () => {
    const e = engine()
    expect(failure(() => send(e, 'contacts', [])).code).toBe(100)
    expect(failure(() => send(e, 'contacts', [{ name: { first_name: 'Pablo' } }])).details).toMatch(/formatted_name/)
    expect(failure(() => send(e, 'contacts', [{ name: { formatted_name: 'P' }, nickname: 'p' }])).details).toMatch(/nickname/)
  })

  it('takes every property Meta’s contact card has', () => {
    const e = engine()
    const card = {
      addresses: [{ street: '1 Hacker Way', city: 'Menlo Park', type: 'WORK' }],
      birthday: '2012-08-18',
      emails: [{ email: 'pablo@example.com', type: 'WORK' }],
      name: { formatted_name: 'Pablo Morales' },
      org: { company: 'WhatsApp' },
      phones: [{ phone: '+16505551234', type: 'WORK' }],
      urls: [{ url: 'https://www.whatsapp.com', type: 'WORK' }],
    }
    expect(() => send(e, 'contacts', [card])).not.toThrow()
  })

  it('refuses a card that is not an object, and a formatted_name that is empty or not a string', () => {
    const e = engine()
    expect(failure(() => send(e, 'contacts', [null])).code).toBe(100)
    expect(failure(() => send(e, 'contacts', [{ name: { formatted_name: '' } }])).code).toBe(100)
    expect(failure(() => send(e, 'contacts', [{ name: { formatted_name: 5 } }])).code).toBe(100)
  })
})

describe('reaction messages', () => {
  it('reacts to a message in the thread, and only a sent status follows', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'reaction', { message_id: messageId, emoji: '👍' }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()

    const statuses = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((s) => s?.id === id)
    expect(statuses.map((s) => s.status)).toEqual(['sent'])
  })

  it('fails on its status with 131009 when the target is not in the thread', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'reaction', { message_id: 'wamid.NOT_HERE', emoji: '👍' }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()

    const statuses = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).filter((s) => s?.id === id)
    expect(statuses.map((s) => s.status)).toEqual(['failed'])
    expect(statuses[0].errors[0].code).toBe(131009)
  })

  it('fails with 131009 when reacting to a message older than 30 days', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    e.clock.advance(31 * 24 * 60 * 60 * 1000)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'otra vez' } } })
    const id = send(e, 'reaction', { message_id: messageId, emoji: '👍' }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()

    const failed = received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).find((s) => s?.id === id)
    expect(failed.status).toBe('failed')
  })

  async function reactionStatus(target: (e: WamockEngine) => string) {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'reaction', { message_id: target(e), emoji: '👍' }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()
    return received.map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0]).find((s) => s?.id === id).status
  }

  it('fails when the target belongs to another customer’s chat', async () => {
    const status = await reactionStatus(
      (e) => e.simulateInbound({ from: '5215555000002', message: { type: 'text', text: { body: 'yo' } } }).messageId,
    )
    expect(status).toBe('failed')
  })

  it('fails when the target is itself a reaction, and succeeds on an outbound message', async () => {
    expect(await reactionStatus((e) => send(e, 'text', { body: 'hola' }).messages[0]!.id)).toBe('sent')
    expect(
      await reactionStatus((e) => {
        const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'x' } } })
        return send(e, 'reaction', { message_id: messageId, emoji: '❤️' }).messages[0]!.id
      }),
    ).toBe('failed')
  })

  it('fails when the target is a reaction the customer sent', async () => {
    expect(
      await reactionStatus(
        (e) => e.simulateInbound({ from: CUSTOMER, message: { type: 'reaction', reaction: { message_id: 'wamid.X', emoji: '👍' } } }).messageId,
      ),
    ).toBe('failed')
  })

  it('does not use up the month’s free service messages', async () => {
    const received: string[] = []
    const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH, transport: async (d) => void received.push(d.body) })
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    send(e, 'reaction', { message_id: messageId, emoji: '👍' })
    let last = ''
    for (let i = 0; i < 1000; i++) last = send(e, 'text', { body: `m${i}` }).messages[0]!.id
    e.clock.advance(60_000)
    await e.settle()
    const delivered = received
      .map((b) => JSON.parse(b).entry[0].changes[0].value.statuses?.[0])
      .find((s) => s?.id === last && s.status === 'delivered')
    expect(delivered.pricing.type).toBe('free_customer_service')
  })

  it('needs message_id and emoji', () => {
    const e = engine()
    expect(failure(() => send(e, 'reaction', { emoji: '👍' })).code).toBe(100)
    expect(failure(() => send(e, 'reaction', { message_id: 'wamid.x' })).code).toBe(100)
  })

  it('refuses a missing reaction, and a message_id that is empty or not a string', () => {
    const e = engine()
    expect(failure(() => send(e, 'reaction', undefined)).code).toBe(100)
    expect(failure(() => send(e, 'reaction', { message_id: '', emoji: '👍' })).code).toBe(100)
    expect(failure(() => send(e, 'reaction', { message_id: 5, emoji: '👍' })).code).toBe(100)
  })

  it('reacts to a message exactly 30 days old', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    e.clock.advance(30 * 24 * 60 * 60 * 1000)
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'otra vez' } } })
    const id = send(e, 'reaction', { message_id: messageId, emoji: '👍' }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((st) => st.status)).toEqual(['sent'])
  })

  it('fails when the target is not in the thread, even once the business has sent messages there', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    send(e, 'text', { body: 'hola' })
    const id = send(e, 'reaction', { message_id: 'wamid.NOT_HERE', emoji: '👍' }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((st) => st.status)).toEqual(['failed'])
  })

  it('fails when the target was sent to another customer', async () => {
    const OTHER = '5215555000002'
    const { e, statusesOf, flush } = withWebhooks()
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    e.simulateInbound({ from: OTHER, message: { type: 'text', text: { body: 'hola' } } })
    const theirs = e.sendMessage(e.state.defaultPhoneNumberId, { messaging_product: 'whatsapp', to: OTHER, type: 'text', text: { body: 'hi' } })
    const id = send(e, 'reaction', { message_id: theirs.messages[0]!.id, emoji: '👍' }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((st) => st.status)).toEqual(['failed'])
  })

  it('fails when the target is the same customer’s chat with another of the business’s numbers', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    const other = e.createSignup({ subscribed: true }).phone_number_id
    e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const received = e.simulateInbound({ phoneNumberId: other, from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } }).messageId
    const sent = e.sendMessage(other, { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } }).messages[0]!.id
    const ids = [received, sent].map((target) => send(e, 'reaction', { message_id: target, emoji: '👍' }).messages[0]!.id)
    await flush()
    expect(ids.map((id) => statusesOf(id).map((st) => st.status))).toEqual([['failed'], ['failed']])
  })

  it('echoes biz_opaque_callback_data on its status', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'reaction', { message_id: messageId, emoji: '👍' }, { biz_opaque_callback_data: 'r-1' }).messages[0]!.id
    await flush()
    expect(statusesOf(id).map((st) => st.biz_opaque_callback_data)).toEqual(['r-1'])
  })

  it('sends its status after the configured latency, like any other status', async () => {
    const { e, statusesOf, flush } = withWebhooks()
    e.scenario.configure({ latencyMs: 1000 })
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
    const id = send(e, 'reaction', { message_id: messageId, emoji: '👍' }).messages[0]!.id
    await flush(1049)
    expect(statusesOf(id)).toEqual([])
    await flush(1)
    expect(statusesOf(id).map((st) => st.status)).toEqual(['sent'])
  })
})

describe('call-to-action URL interactive messages', () => {
  const cta = (overrides: Record<string, unknown> = {}) => ({
    type: 'cta_url',
    body: { text: 'See the catalog' },
    action: { name: 'cta_url', parameters: { display_text: 'Open', url: 'https://example.com' } },
    ...overrides,
  })

  it('sends a CTA URL button', () => {
    const e = engine()
    expect(() => send(e, 'interactive', cta({ header: { type: 'text', text: 'Hi' }, footer: { text: 'Bye' } }))).not.toThrow()
  })

  it('enforces its documented limits', () => {
    const e = engine()
    expect(failure(() => send(e, 'interactive', cta({ body: { text: 'x'.repeat(1025) } }))).code).toBe(100)
    expect(
      failure(() => send(e, 'interactive', cta({ action: { name: 'cta_url', parameters: { display_text: 'x'.repeat(21), url: 'https://e.com' } } }))).code,
    ).toBe(100)
    expect(failure(() => send(e, 'interactive', cta({ action: { name: 'cta_url', parameters: { display_text: 'Open' } } }))).details).toMatch(/url/)
    expect(
      failure(() => send(e, 'interactive', cta({ action: { name: 'open', parameters: { display_text: 'Open', url: 'https://e.com' } } }))).code,
    ).toBe(100)
  })
})

describe('documented limits on contacts and the interactive frame', () => {
  it('takes up to 257 contacts', () => {
    const e = engine()
    const card = { name: { formatted_name: 'Ana' } }
    expect(() => send(e, 'contacts', Array.from({ length: 257 }, () => card))).not.toThrow()
    expect(failure(() => send(e, 'contacts', Array.from({ length: 258 }, () => card))).code).toBe(100)
  })

  it('needs footer text, header content, and a real URL', () => {
    const e = engine()
    const cta = (extra: Record<string, unknown>, url = 'https://example.com') => ({
      type: 'cta_url',
      body: { text: 'See' },
      action: { name: 'cta_url', parameters: { display_text: 'Open', url } },
      ...extra,
    })
    expect(failure(() => send(e, 'interactive', cta({ footer: {} }))).details).toMatch(/footer/)
    expect(failure(() => send(e, 'interactive', cta({ header: { type: 'image' } }))).details).toMatch(/image/)
    expect(failure(() => send(e, 'interactive', cta({ header: { type: 'gif' } }))).code).toBe(100)
    expect(failure(() => send(e, 'interactive', cta({}, 'just some text'))).details).toMatch(/url/)
    expect(() => send(e, 'interactive', cta({ header: { type: 'image', image: { link: 'https://example.com/a.png' } } }))).not.toThrow()
    expect(
      failure(() => send(e, 'interactive', cta({ header: { type: 'image', image: { link: 'https://example.com/a.png', id: '1' } } })))
        .details,
    ).toMatch(/exactly one/)
  })

  it('takes only a text header on a list', () => {
    const e = engine()
    const list = {
      type: 'list',
      header: { type: 'image', image: { link: 'https://example.com/a.png' } },
      body: { text: 'Pick' },
      action: { button: 'Options', sections: [{ rows: [{ id: 'a', title: 'A' }] }] },
    }
    expect(failure(() => send(e, 'interactive', list)).details).toMatch(/text for a list/)
  })
})

describe('the context of a reply', () => {
  it('accepts context.message_id and records it with the message', () => {
    const e = engine()
    const { messageId } = e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: '¿precio?' } } })
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      context: { message_id: messageId },
      text: { body: '$10' },
    })
    expect(e.state.outbound()[0]!.payload['context']).toEqual({ message_id: messageId })
  })
})

// Mutation survivors left on purpose (message-content.ts, and the media and
// reaction paths of messaging-service.ts):
// - `details:` strings and field names inside them: debug text, not contract.
// - `audio: {}` / `sticker: {}` (caption undefined is as falsy as false), the
//   `typeof number !== 'number'` guard (Number.isFinite already rejects every
//   non-number), isWebUrl's `catch` returning undefined (as falsy as false),
//   `MIME_TYPES_BY_KIND[kind]?.` and the `?? 'application/octet-stream'`
//   fallback (kind is always a media type): equivalent.
// - `...(x !== undefined ? {…} : {})` forced true: a key holding undefined,
//   which the payload builders skip the same way.
// - The guards in #checkMediaReferences that pick out where media can sit:
//   loosening them only reaches fields a valid payload does not have there.
// - `.trim()` on the MIME base type: only matters for whitespace before `;`
//   in a MIME type a test supplied itself.
// - A stray `filename`/`voice` on another media type, and a non-string
//   biz_opaque_callback_data (silently dropped today): no Meta source says
//   whether those are refused, so neither behaviour is pinned.
