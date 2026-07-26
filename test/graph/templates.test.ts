import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../../src/core/engine.js'
import { GraphError } from '../../src/errors/graph-error.js'

const EPOCH = 1_750_000_000_000

function engine() {
  return new WamockEngine({ appSecret: 'app-secret', mode: 'frozen', start: EPOCH })
}

const templateBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'order_update',
  language: 'es_MX',
  category: 'UTILITY',
  components: [
    {
      type: 'BODY',
      text: 'Hola {{1}}, tu pedido {{2}} va en camino.',
      example: { body_text: [['Ana', 'A-123']] },
    },
  ],
  ...overrides,
})

const catchGraphError = (fn: () => unknown): GraphError => {
  try {
    fn()
  } catch (err) {
    if (err instanceof GraphError) return err
    throw err
  }
  throw new Error('expected a GraphError, but nothing was thrown')
}

describe('createTemplate', () => {
  it('starts life PENDING, like a real submission to Meta', () => {
    const e = engine()
    const res = e.createTemplate(e.state.defaultWabaId, templateBody())

    expect(res).toMatchObject({ status: 'PENDING', category: 'UTILITY' })
    expect(res.id).toEqual(expect.any(String))
  })

  it('treats a duplicate as an idempotent success, the way Meta does', () => {
    // Spec §7 / §9.4: on reconnect Meta answers "already exists" as an ERROR
    // body, and every real integration treats it as success. Reproducing the
    // error wording is what lets an integration test that handling.
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())

    const err = catchGraphError(() => e.createTemplate(e.state.defaultWabaId, templateBody()))

    expect(err.toBody('t').error.message).toMatch(/already exists/i)
  })

  it('allows the same name in a different language — approval is per language', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())

    expect(() =>
      e.createTemplate(e.state.defaultWabaId, templateBody({ language: 'en_US' })),
    ).not.toThrow()
  })

  it('rejects an unknown WABA', () => {
    expect(catchGraphError(() => engine().createTemplate('WABA_GHOST', templateBody())).code).toBe(
      100,
    )
  })

  it('rejects a category outside Meta’s three', () => {
    const e = engine()
    expect(
      catchGraphError(() => e.createTemplate(e.state.defaultWabaId, templateBody({ category: 'PROMO' })))
        .code,
    ).toBe(100)
  })

  it('rejects a name with characters Meta does not allow', () => {
    // Meta requires lowercase alphanumerics and underscores. Integrations that
    // pass a human-readable name fail at submission time, not at send time.
    const e = engine()
    expect(
      catchGraphError(() => e.createTemplate(e.state.defaultWabaId, templateBody({ name: 'Order Update' })))
        .code,
    ).toBe(100)
  })

  it('rejects a missing language', () => {
    const e = engine()
    const body = templateBody()
    delete (body as Record<string, unknown>)['language']
    expect(catchGraphError(() => e.createTemplate(e.state.defaultWabaId, body)).code).toBe(100)
  })
})

describe('listTemplates', () => {
  it('returns the Graph list envelope with each template’s status', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.createTemplate(e.state.defaultWabaId, templateBody({ language: 'en_US' }))

    const res = e.listTemplates(e.state.defaultWabaId)

    expect(res.data).toHaveLength(2)
    expect(res.data[0]).toMatchObject({ name: 'order_update', status: 'PENDING' })
  })

  it('is empty for a WABA with no templates', () => {
    expect(engine().listTemplates(engine().state.defaultWabaId).data).toEqual([])
  })

  it('does not leak templates across WABAs', () => {
    const e = engine()
    e.state.registerApp({ appId: 'APP_2', appSecret: 's2' })
    e.state.registerWaba({ wabaId: 'WABA_2', appId: 'APP_2' })
    e.createTemplate(e.state.defaultWabaId, templateBody())

    expect(e.listTemplates('WABA_2').data).toEqual([])
  })
})

describe('deleteTemplate', () => {
  it('removes every language of a name, like Meta’s delete by name', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.createTemplate(e.state.defaultWabaId, templateBody({ language: 'en_US' }))

    expect(e.deleteTemplate(e.state.defaultWabaId, 'order_update')).toEqual({ success: true })
    expect(e.listTemplates(e.state.defaultWabaId).data).toEqual([])
  })

  it('rejects deleting a name that does not exist', () => {
    const e = engine()
    expect(catchGraphError(() => e.deleteTemplate(e.state.defaultWabaId, 'nope')).code).toBe(100)
  })
})

describe('transitionTemplate', () => {
  it('moves a template through the states Meta uses', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())

    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')

    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')?.status).toBe('APPROVED')
  })

  it('affects only the language it names', () => {
    // The trap this reproduces: approving es_MX does NOT approve en_US, and a
    // send in the unapproved language fails with 132001 in production only.
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.createTemplate(e.state.defaultWabaId, templateBody({ language: 'en_US' }))

    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')

    expect(e.template(e.state.defaultWabaId, 'order_update', 'en_US')?.status).toBe('PENDING')
  })

  it('rejects a transition for a template that does not exist', () => {
    const e = engine()
    expect(
      catchGraphError(() => e.transitionTemplate(e.state.defaultWabaId, 'nope', 'es_MX', 'APPROVED'))
        .code,
    ).toBe(132001)
  })

  it('rejects a status that is not one of Meta’s', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    expect(
      catchGraphError(() =>
        e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'BANANA' as never),
      ).code,
    ).toBe(100)
  })
})

describe('reset', () => {
  it('drops templates created during a test', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.reset()
    expect(e.listTemplates(e.state.defaultWabaId).data).toEqual([])
  })
})
