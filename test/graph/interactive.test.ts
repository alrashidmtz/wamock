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

const buttons = (count: number, title = 'OK') => ({
  type: 'button',
  body: { text: 'Pick one' },
  action: { buttons: Array.from({ length: count }, (_, i) => button(`b${i}`, title)) },
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
