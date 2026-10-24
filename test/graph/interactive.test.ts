import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

/**
 * Interactive message limits, exactly as Meta enforces them.
 *
 * Note the direction: a defensive CLIENT truncates to stay under the caps. The
 * MOCK must do the opposite and reject, because its job is to surface the 400
 * Meta would return — not to protect you from it. A mock that silently clips an
 * over-long title lets a bug ship.
 */

const EPOCH = 1_750_000_000_000
const CUSTOMER = '5215555000001'

function engine() {
  const e = new WamockEngine({ appSecret: 's', mode: 'frozen', start: EPOCH })
  e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
  return e
}

const send = (e: WamockEngine, interactive: unknown) =>
  e.sendMessage(e.state.defaultPhoneNumberId, {
    messaging_product: 'whatsapp',
    to: CUSTOMER,
    type: 'interactive',
    interactive,
  })

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError, but nothing was thrown')
}

const button = (id: string, title: string) => ({ type: 'reply', reply: { id, title } })

// Titles must be unique (Meta's rule), so only the first button gets `title`
// verbatim; the rest are suffixed with their index.
const buttons = (count: number, title = 'OK') => ({
  type: 'button',
  body: { text: 'Pick one' },
  action: {
    buttons: Array.from({ length: count }, (_, i) => button(`b${i}`, i === 0 ? title : `${title.slice(0, 18)}${i}`)),
  },
})

const listWith = (rowCounts: number[], rowTitle = 'Row') => ({
  type: 'list',
  body: { text: 'Choose' },
  action: {
    button: 'Open',
    sections: rowCounts.map((rows, s) => ({
      title: `Section ${s}`,
      rows: Array.from({ length: rows }, (_, i) => ({ id: `s${s}r${i}`, title: rowTitle })),
    })),
  },
})

describe('reply buttons', () => {
  it('accepts up to three buttons', () => {
    expect(() => send(engine(), buttons(3))).not.toThrow()
  })

  it('rejects a fourth button with 100', () => {
    expect(codeOf(() => send(engine(), buttons(4)))).toBe(100)
  })

  it('rejects an empty button list', () => {
    expect(codeOf(() => send(engine(), { ...buttons(0) }))).toBe(100)
  })

  it('accepts a 20-character button title', () => {
    expect(() => send(engine(), buttons(1, 'x'.repeat(20)))).not.toThrow()
  })

  it('rejects a 21-character button title', () => {
    expect(codeOf(() => send(engine(), buttons(1, 'x'.repeat(21))))).toBe(100)
  })

  it('rejects an empty reply id or title, not just a missing one', () => {
    // A client sending `id: ""` passes a `typeof === 'string'` check. Meta
    // rejects it; so must the mock, or the send looks fine here and 400s there.
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'button',
          body: { text: 'Pick' },
          action: { buttons: [{ type: 'reply', reply: { id: '', title: 'OK' } }] },
        }),
      ),
    ).toBe(100)
    expect(
      codeOf(() =>
        send(e, {
          type: 'button',
          body: { text: 'Pick' },
          action: { buttons: [{ type: 'reply', reply: { id: 'b', title: '' } }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects body text that is not a string', () => {
    expect(codeOf(() => send(engine(), { ...buttons(1), body: { text: 42 } }))).toBe(100)
  })

  it('rejects empty body text', () => {
    expect(codeOf(() => send(engine(), { ...buttons(1), body: { text: '' } }))).toBe(100)
  })

  it('requires body text', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, { type: 'button', action: { buttons: [button('b0', 'OK')] } }),
      ),
    ).toBe(100)
  })

  it('requires a title on each button', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'button',
          body: { text: 'Pick' },
          action: { buttons: [{ type: 'reply', reply: { id: 'b0' } }] },
        }),
      ),
    ).toBe(100)
  })

  it('requires a reply id on each button', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'button',
          body: { text: 'Pick' },
          action: { buttons: [{ type: 'reply', reply: { title: 'OK' } }] },
        }),
      ),
    ).toBe(100)
  })
})

describe('lists', () => {
  it('accepts ten rows spread across sections', () => {
    expect(() => send(engine(), listWith([5, 5]))).not.toThrow()
  })

  it('rejects an eleventh row, because the cap is GLOBAL not per section', () => {
    // The subtle one: two sections of six rows each look fine per section and
    // are rejected by Meta. A mock that checks per-section misses it.
    expect(codeOf(() => send(engine(), listWith([6, 5])))).toBe(100)
  })

  it('accepts a 24-character row title', () => {
    expect(() => send(engine(), listWith([1], 'x'.repeat(24)))).not.toThrow()
  })

  it('rejects a 25-character row title', () => {
    expect(codeOf(() => send(engine(), listWith([1], 'x'.repeat(25))))).toBe(100)
  })

  it('rejects a row description over 72 characters', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'Choose' },
          action: {
            button: 'Open',
            sections: [{ title: 'S', rows: [{ id: 'r', title: 'R', description: 'x'.repeat(73) }] }],
          },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a section title over 24 characters', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'Choose' },
          action: {
            button: 'Open',
            sections: [{ title: 'x'.repeat(25), rows: [{ id: 'r', title: 'R' }] }],
          },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a list button label over 20 characters', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'Choose' },
          action: { button: 'x'.repeat(21), sections: [{ rows: [{ id: 'r', title: 'R' }] }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a list with no action object', () => {
    expect(codeOf(() => send(engine(), { type: 'list', body: { text: 'C' } }))).toBe(100)
  })

  it('rejects a list with no button label', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { sections: [{ rows: [{ id: 'r', title: 'R' }] }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a section that is not an object', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { button: 'Open', sections: ['not-a-section'] },
        }),
      ),
    ).toBe(100)
    expect(
      codeOf(() => send(e, { type: 'list', body: { text: 'C' }, action: { button: 'Open', sections: [null] } })),
    ).toBe(100)
  })

  it('rejects a row with no id', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { button: 'Open', sections: [{ rows: [{ title: 'R' }] }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a row with no title', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { button: 'Open', sections: [{ rows: [{ id: 'r' }] }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects an empty row id or title', () => {
    const e = engine()
    for (const row of [{ id: '', title: 'R' }, { id: 'r', title: '' }]) {
      expect(
        codeOf(() =>
          send(e, {
            type: 'list',
            body: { text: 'C' },
            action: { button: 'Open', sections: [{ rows: [row] }] },
          }),
        ),
      ).toBe(100)
    }
  })

  it('rejects an empty list button label', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { button: '', sections: [{ rows: [{ id: 'r', title: 'R' }] }] },
        }),
      ),
    ).toBe(100)
  })

  it('rejects a list with no sections', () => {
    const e = engine()
    expect(
      codeOf(() => send(e, { type: 'list', body: { text: 'C' }, action: { button: 'Open', sections: [] } })),
    ).toBe(100)
  })

  it('rejects a section with no rows', () => {
    const e = engine()
    expect(
      codeOf(() =>
        send(e, {
          type: 'list',
          body: { text: 'C' },
          action: { button: 'Open', sections: [{ title: 'S', rows: [] }] },
        }),
      ),
    ).toBe(100)
  })
})

describe('interactive messages and the service window', () => {
  it('needs an open window, exactly like free-form text', () => {
    const e = engine()
    e.clock.advance(25 * 60 * 60 * 1000)

    expect(codeOf(() => send(e, buttons(2)))).toBe(131047)
  })
})

describe('unknown interactive types', () => {
  it('rejects an interactive type wamock does not emulate', () => {
    expect(codeOf(() => send(engine(), { type: 'product', body: { text: 'x' } }))).toBe(100)
  })

  it('rejects a missing interactive object', () => {
    const e = engine()
    expect(
      codeOf(() =>
        e.sendMessage(e.state.defaultPhoneNumberId, {
          messaging_product: 'whatsapp',
          to: CUSTOMER,
          type: 'interactive',
        }),
      ),
    ).toBe(100)
  })
})

describe('every documented interactive limit', () => {
  const buttons = (overrides: Record<string, unknown> = {}, list = [{ type: 'reply', reply: { id: 'a', title: 'A' } }]) => ({
    type: 'button',
    body: { text: 'Pick' },
    action: { buttons: list },
    ...overrides,
  })
  const listMsg = (sections: unknown[], overrides: Record<string, unknown> = {}) => ({
    type: 'list',
    body: { text: 'Pick' },
    action: { button: 'Open', sections },
    ...overrides,
  })
  const row = (id = 'r', title = 'Row') => ({ id, title })

  it.each([
    ['button body over 1024', buttons({ body: { text: 'x'.repeat(1025) } })],
    ['list body over 4096', listMsg([{ rows: [row()] }], { body: { text: 'x'.repeat(4097) } })],
    ['footer over 60', buttons({ footer: { text: 'x'.repeat(61) } })],
    ['text header over 60', buttons({ header: { type: 'text', text: 'x'.repeat(61) } })],
    ['button id over 256', buttons({}, [{ type: 'reply', reply: { id: 'x'.repeat(257), title: 'A' } }])],
    ['duplicate button titles', buttons({}, [{ type: 'reply', reply: { id: 'a', title: 'Same' } }, { type: 'reply', reply: { id: 'b', title: 'Same' } }])],
    ['row id over 200', listMsg([{ rows: [row('x'.repeat(201))] }])],
    ['more than 10 sections', listMsg(Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, rows: [] })))],
    ['two sections without titles', listMsg([{ rows: [row('a')] }, { rows: [row('b')] }])],
  ])('rejects %s with 100', (_name, interactive) => {
    const e = engine()
    expect(codeOf(() => send(e, interactive))).toBe(100)
  })

  it.each([
    ['button body of exactly 1024', buttons({ body: { text: 'x'.repeat(1024) } })],
    ['list body of exactly 4096', listMsg([{ rows: [row()] }], { body: { text: 'x'.repeat(4096) } })],
    ['footer and header of exactly 60', buttons({ footer: { text: 'x'.repeat(60) }, header: { type: 'text', text: 'y'.repeat(60) } })],
    ['a single untitled section', listMsg([{ rows: [row()] }])],
  ])('accepts %s', (_name, interactive) => {
    const e = engine()
    expect(() => send(e, interactive)).not.toThrow()
  })
})

describe('the header and footer an interactive message shares', () => {
  const withFrame = (frame: Record<string, unknown>) => ({ ...buttons(1), ...frame })

  it.each([
    ['a footer with no text', { footer: {} }],
    ['a footer with empty text', { footer: { text: '' } }],
    ['a footer that is not an object', { footer: 'Bye' }],
    ['a header that is null', { header: null }],
    ['a text header with no text', { header: { type: 'text' } }],
    ['a text header with empty text', { header: { type: 'text', text: '' } }],
    ['a text header whose text is not a string', { header: { type: 'text', text: 42 } }],
    ['a header of a type Meta does not take', { header: { type: 'audio', audio: { link: 'https://example.com/a.ogg' } } }],
    ['a media header with an empty link', { header: { type: 'image', image: { link: '' } } }],
    ['a media header with an empty id', { header: { type: 'image', image: { id: '' } } }],
  ])('rejects %s with 100', (_name, frame) => {
    expect(codeOf(() => send(engine(), withFrame(frame)))).toBe(100)
  })

  it.each(['image', 'video', 'document'])('accepts a %s header by link or by id', (type) => {
    const e = engine()
    expect(() => send(e, withFrame({ header: { type, [type]: { link: `https://example.com/h.${type}` } } }))).not.toThrow()
    const { id } = e.uploadMedia(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      type: { image: 'image/jpeg', video: 'video/mp4', document: 'application/pdf' }[type],
      file: { bytes: Buffer.from('x') },
    })
    expect(() => send(e, withFrame({ header: { type, [type]: { id } } }))).not.toThrow()
  })

  it('takes no media header on a list, even a complete one', () => {
    const list = { ...listWith([1]), header: { type: 'video', video: { link: 'https://example.com/v.mp4' } } }
    expect(codeOf(() => send(engine(), list))).toBe(100)
  })
})

describe('call-to-action URL buttons', () => {
  const cta = (parameters: Record<string, unknown>) => ({
    type: 'cta_url',
    body: { text: 'See the catalog' },
    action: { name: 'cta_url', parameters },
  })

  it('opens an http or https URL', () => {
    const e = engine()
    expect(() => send(e, cta({ display_text: 'Open', url: 'https://example.com/catalog' }))).not.toThrow()
    expect(() => send(e, cta({ display_text: 'Open', url: 'http://example.com/catalog' }))).not.toThrow()
  })

  it.each([
    ['no display text', { url: 'https://example.com' }],
    ['empty display text', { display_text: '', url: 'https://example.com' }],
    ['a URL a browser cannot open', { display_text: 'Open', url: 'ftp://example.com/file' }],
    ['a javascript: URL', { display_text: 'Open', url: 'javascript:alert(1)' }],
    // `new URL()` stringifies its argument, so a one-element array would parse.
    ['a URL that is not a string', { display_text: 'Open', url: ['https://example.com'] }],
  ])('rejects %s with 100', (_name, parameters) => {
    expect(codeOf(() => send(engine(), cta(parameters)))).toBe(100)
  })
})

describe('the section cap', () => {
  it('accepts ten sections of one row each', () => {
    expect(() => send(engine(), listWith(Array.from({ length: 10 }, () => 1)))).not.toThrow()
  })
  // An eleventh section cannot be told apart from the row cap: every section
  // needs a row, so eleven sections are eleven rows and fail either way. The
  // section check only changes the details text, so its `> MAX_SECTIONS`
  // removal survives Stryker by design.
})
