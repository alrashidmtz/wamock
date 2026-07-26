import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

const EPOCH = 1_750_000_000_000
const HOUR = 60 * 60 * 1000
const CUSTOMER = '5215555000001'

function engine() {
  return new WamockEngine({ appSecret: 'app-secret', mode: 'frozen', start: EPOCH })
}

/** A customer writes in, opening the service window. */
function customerWrites(e: WamockEngine) {
  e.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })
}

const text = { messaging_product: 'whatsapp', to: CUSTOMER, type: 'text', text: { body: 'hi' } }

const template = (name = 'order_update', language = 'es_MX') => ({
  messaging_product: 'whatsapp',
  to: CUSTOMER,
  type: 'template',
  template: { name, language: { code: language }, components: [] },
})

const approvedTemplate = (e: WamockEngine, language = 'es_MX') => {
  e.createTemplate(e.state.defaultWabaId, {
    name: 'order_update',
    language,
    category: 'UTILITY',
    components: [],
  })
  e.transitionTemplate(e.state.defaultWabaId, 'order_update', language, 'APPROVED')
}

const codeOf = (fn: () => unknown): number => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err.code
    throw err
  }
  throw new Error('expected a GraphError, but nothing was thrown')
}

describe('the 24h service window gates free-form sends', () => {
  it('allows a text message while the window is open', () => {
    const e = engine()
    customerWrites(e)

    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
  })

  it('rejects a text message with 131047 once 24h have passed', () => {
    const e = engine()
    customerWrites(e)
    e.clock.advance(25 * HOUR)

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(131047)
  })

  it('rejects a text message to a customer who never wrote', () => {
    // No prior inbound means no window at all — not an open one.
    expect(codeOf(() => engine().sendMessage(engine().state.defaultPhoneNumberId, text))).toBe(
      131047,
    )
  })

  it('reopens the window when the customer writes again', () => {
    const e = engine()
    customerWrites(e)
    e.clock.advance(25 * HOUR)
    customerWrites(e)

    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, text)).not.toThrow()
  })

  it('does not let an outbound message hold the window open', () => {
    // Only the customer can renew it. A business that keeps sending does not
    // extend its own permission to send.
    const e = engine()
    customerWrites(e)
    e.clock.advance(20 * HOUR)
    e.sendMessage(e.state.defaultPhoneNumberId, text)
    e.clock.advance(5 * HOUR)

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, text))).toBe(131047)
  })

  it('keeps windows separate per customer', () => {
    const e = engine()
    customerWrites(e)

    const other = { ...text, to: '5215555000009' }
    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, other))).toBe(131047)
  })
})

describe('templates escape the window', () => {
  it('sends an APPROVED template long after the window closed', () => {
    // This is the entire point of templates and the reason 131047 is a
    // permanent error: the fix is a template, not a retry.
    const e = engine()
    approvedTemplate(e)
    e.clock.advance(72 * HOUR)

    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, template())).not.toThrow()
  })

  it('records the template send with its name and language', () => {
    const e = engine()
    approvedTemplate(e)
    e.sendMessage(e.state.defaultPhoneNumberId, template())

    expect(e.state.outbound()[0]).toMatchObject({
      type: 'template',
      payload: { template: { name: 'order_update' } },
    })
  })
})

describe('template state gates template sends', () => {
  it('rejects a template that does not exist with 132001', () => {
    expect(codeOf(() => engine().sendMessage(engine().state.defaultPhoneNumberId, template()))).toBe(
      132001,
    )
  })

  it('rejects a template approved in another language with 132001', () => {
    // The trap: es_MX is APPROVED, en_US was never submitted. Naive mocks key
    // templates by name alone and let this through, so the failure first shows
    // up in production.
    const e = engine()
    approvedTemplate(e, 'es_MX')

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, template('order_update', 'en_US')))).toBe(
      132001,
    )
  })

  it('rejects a PENDING template with 132001', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, {
      name: 'order_update',
      language: 'es_MX',
      category: 'UTILITY',
      components: [],
    })

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, template()))).toBe(132001)
  })

  it('rejects a REJECTED template with 132001', () => {
    const e = engine()
    approvedTemplate(e)
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'REJECTED')

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, template()))).toBe(132001)
  })

  it('rejects a PAUSED template with 132015, distinct from not-found', () => {
    // 132015 is recoverable (Meta may unpause); 132001 means you never had it.
    // Integrations alert differently on each.
    const e = engine()
    approvedTemplate(e)
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')

    expect(codeOf(() => e.sendMessage(e.state.defaultPhoneNumberId, template()))).toBe(132015)
  })

  it('sends again once a paused template is reinstated', () => {
    const e = engine()
    approvedTemplate(e)
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')

    expect(() => e.sendMessage(e.state.defaultPhoneNumberId, template())).not.toThrow()
  })

  it('rejects a template send with no template object', () => {
    const e = engine()
    expect(
      codeOf(() =>
        e.sendMessage(e.state.defaultPhoneNumberId, {
          messaging_product: 'whatsapp',
          to: CUSTOMER,
          type: 'template',
        }),
      ),
    ).toBe(100)
  })

  it('rejects a template send with no language code', () => {
    const e = engine()
    expect(
      codeOf(() =>
        e.sendMessage(e.state.defaultPhoneNumberId, {
          messaging_product: 'whatsapp',
          to: CUSTOMER,
          type: 'template',
          template: { name: 'order_update' },
        }),
      ),
    ).toBe(100)
  })
})
