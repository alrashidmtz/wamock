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

describe('template status webhooks', () => {
  it('reach a WABA that has no phone numbers yet', async () => {
    // A template belongs to the WABA, not to a number. Tech providers create
    // templates right after signup, before any number is registered, and the
    // approval must still arrive.
    const received: string[] = []
    const e = new WamockEngine({
      appSecret: 'app-secret',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    e.state.registerWaba({
      wabaId: 'WABA_EMPTY',
      appId: e.state.defaultAppId,
      subscribedApps: new Set([e.state.defaultAppId]),
    })
    e.createTemplate('WABA_EMPTY', templateBody())
    e.transitionTemplate('WABA_EMPTY', 'order_update', 'es_MX', 'APPROVED')
    await e.flush()

    expect(received.map((b) => JSON.parse(b).entry[0])).toMatchObject([
      { id: 'WABA_EMPTY', changes: [{ field: 'message_template_status_update' }] },
    ])
  })
})

describe('the template list speaks Meta’s shape', () => {
  it('returns each template with Meta’s field names, not wamock’s internals', () => {
    const e = engine()
    const created = e.createTemplate(e.state.defaultWabaId, templateBody())

    expect(e.listTemplates(e.state.defaultWabaId).data).toEqual([
      {
        name: 'order_update',
        parameter_format: 'POSITIONAL',
        components: templateBody().components,
        language: 'es_MX',
        status: 'PENDING',
        category: 'UTILITY',
        id: created.id,
      },
    ])
  })

  it('records a named parameter format, accepted in either case', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody({ parameter_format: 'named' }))
    expect(e.listTemplates(e.state.defaultWabaId).data[0]!.parameter_format).toBe('NAMED')
  })

  it('rejects a parameter format Meta does not have', () => {
    const e = engine()
    expect(catchGraphError(() => e.createTemplate(e.state.defaultWabaId, templateBody({ parameter_format: 'numbered' }))).code).toBe(100)
  })
})

describe('template status webhooks follow Meta’s reference', () => {
  const HOUR = 60 * 60 * 1000

  function withInbox() {
    const received: string[] = []
    const e = new WamockEngine({
      appSecret: 'app-secret',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    const created = e.createTemplate(e.state.defaultWabaId, templateBody())
    const value = (i: number) => JSON.parse(received[i]!).entry[0].changes[0].value as Record<string, unknown>
    const drain = async () => {
      e.clock.advance(0)
      await e.settle()
    }
    return { e, received, value, drain, id: created.id }
  }

  it('carries the category, an integer id and the entry time on approval', async () => {
    const { e, received, value, drain, id } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    await drain()

    expect(JSON.parse(received[0]!).entry[0].time).toBe(Math.floor(EPOCH / 1000))
    expect(value(0)).toEqual({
      event: 'APPROVED',
      message_template_id: Number(id),
      message_template_name: 'order_update',
      message_template_language: 'es_MX',
      reason: 'NONE',
      message_template_category: 'UTILITY',
    })
  })

  it('explains a rejection with rejection_info, using Meta’s own example', async () => {
    const { e, value, drain } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'REJECTED')
    await drain()

    expect(value(0)).toMatchObject({
      event: 'REJECTED',
      reason: 'INVALID_FORMAT',
      rejection_info: {
        reason: 'Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.',
        recommendation: 'Separate parameters with descriptive text and ensure each parameter is clearly contextualized.',
      },
    })
  })

  it('reports a pause with reason NONE and other_info FIRST_PAUSE', async () => {
    const { e, value, drain } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    await drain()

    expect(value(1)).toMatchObject({
      event: 'PAUSED',
      reason: 'NONE',
      other_info: { title: 'FIRST_PAUSE' },
    })
  })

  it('unpauses on its own after 3 hours the first time, announcing UNPAUSE', async () => {
    const { e, value, received, drain } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    await drain()

    e.clock.advance(3 * HOUR - 1)
    await e.settle()
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('PAUSED')

    e.clock.advance(1)
    await e.settle()
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('APPROVED')
    expect(value(received.length - 1)).toMatchObject({
      event: 'APPROVED',
      other_info: { title: 'UNPAUSE', description: 'Your WhatsApp message template has been unpaused.' },
    })
  })

  it('pauses for 6 hours the second time', async () => {
    const { e, value, drain } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    e.clock.advance(3 * HOUR)
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    await drain()

    expect(value(3)).toMatchObject({ event: 'PAUSED', other_info: { title: 'SECOND_PAUSE' } })
    e.clock.advance(6 * HOUR - 1)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('PAUSED')
    e.clock.advance(1)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('APPROVED')
  })

  it('disables the template on the third pause instead of pausing it', async () => {
    const { e, value, received, drain } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    for (const wait of [3 * HOUR, 6 * HOUR]) {
      e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
      e.clock.advance(wait)
    }
    const res = e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    await drain()

    expect(res.status).toBe('DISABLED')
    expect(value(received.length - 1)).toMatchObject({
      event: 'DISABLED',
      other_info: { title: 'DISABLED' },
      disable_info: { disable_date: Math.floor(e.clock.now() / 1000) },
    })
  })

  it('does not let a stale unpause timer revive a template reapproved by hand and paused again', () => {
    const { e } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    e.clock.advance(HOUR)
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    // The first pause's timer comes due at +3h; the second pause lasts 6h.
    e.clock.advance(2 * HOUR)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('PAUSED')
  })

  it('cancels pending unpauses on reset', () => {
    const { e } = withInbox()
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED') // due at +3h
    e.reset()

    e.clock.advance(HOUR)
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED') // due at +4h

    // At +3h only the pre-reset timer is due. Had it survived, it would
    // unpause the new template an hour early.
    e.clock.advance(2 * HOUR)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('PAUSED')
  })

})

describe('automatic recategorization', () => {
  const HOUR = 60 * 60 * 1000

  function approved() {
    const received: string[] = []
    const e = new WamockEngine({
      appSecret: 'app-secret',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    const { id } = e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    const categoryUpdates = () =>
      received
        .map((b) => JSON.parse(b).entry[0])
        .filter((entry) => entry.changes[0].field === 'template_category_update')
    return { e, id, categoryUpdates }
  }

  it('warns 24 hours ahead, with new_category holding the CURRENT category', async () => {
    const { e, id, categoryUpdates } = approved()
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING' })
    await e.flush()

    expect(categoryUpdates()).toEqual([
      {
        id: e.state.defaultWabaId,
        time: Math.floor(EPOCH / 1000),
        changes: [
          {
            field: 'template_category_update',
            value: {
              message_template_id: Number(id),
              message_template_name: 'order_update',
              message_template_language: 'es_MX',
              // Meta's own trap: during the notice, `new_category` is the
              // category the template still has.
              new_category: 'UTILITY',
              correct_category: 'MARKETING',
              category_update_timestamp: Math.floor((EPOCH + 24 * HOUR) / 1000),
            },
          },
        ],
      },
    ])
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.category).toBe('UTILITY')
  })

  it('changes the category 24 hours later, announcing previous and new', async () => {
    const { e, categoryUpdates } = approved()
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING' })
    e.clock.advance(24 * HOUR)
    await e.settle()

    expect(categoryUpdates()[1]!.changes[0].value).toMatchObject({
      previous_category: 'UTILITY',
      new_category: 'MARKETING',
    })
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.category).toBe('MARKETING')
  })

  it('keeps the template APPROVED, and bills it under the new category from then on', async () => {
    const received: string[] = []
    const e = new WamockEngine({
      appSecret: 'app-secret',
      mode: 'frozen',
      start: EPOCH,
      transport: async (d) => {
        received.push(d.body)
      },
    })
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING' })
    e.clock.advance(24 * HOUR)

    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('APPROVED')
    e.sendMessage(e.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: '5215555000001',
      type: 'template',
      template: { name: 'order_update', language: { code: 'es_MX' } },
    })
    e.clock.advance(60_000)
    await e.settle()

    const priced = received
      .map((b) => JSON.parse(b).entry[0].changes[0])
      .filter((c) => c.field === 'messages' && c.value.statuses?.[0]?.pricing)
    expect(priced[0]!.value.statuses[0].pricing.category).toBe('marketing')
  })

  it('changes at once, with no notice, when told the business gets none', async () => {
    const { e, categoryUpdates } = approved()
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING', notice: false })
    await e.flush()

    expect(categoryUpdates()).toHaveLength(1)
    expect(categoryUpdates()[0]!.changes[0].value).toMatchObject({ previous_category: 'UTILITY', new_category: 'MARKETING' })
  })

  it('forgets a pending recategorization on reset', () => {
    const { e } = approved()
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING' })
    e.reset()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.clock.advance(24 * HOUR)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.category).toBe('UTILITY')
  })

  it('refuses a category Meta does not have, and a template that does not exist', () => {
    const { e } = approved()
    expect(catchGraphError(() => e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'PROMO' as never })).code).toBe(100)
    expect(catchGraphError(() => e.recategorizeTemplate(e.state.defaultWabaId, 'nope', 'es_MX', { to: 'MARKETING' })).code).toBe(132001)
  })
})

describe('template timers belong to the template that set them', () => {
  const HOUR = 60 * 60 * 1000

  it('a recategorization scheduled on a deleted template does not touch its replacement', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.recategorizeTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', { to: 'MARKETING' })
    e.deleteTemplate(e.state.defaultWabaId, 'order_update')
    e.createTemplate(e.state.defaultWabaId, templateBody())

    e.clock.advance(24 * HOUR)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.category).toBe('UTILITY')
  })

  it('an unpause scheduled on a deleted template does not revive its replacement', () => {
    const e = engine()
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    e.deleteTemplate(e.state.defaultWabaId, 'order_update')
    e.createTemplate(e.state.defaultWabaId, templateBody())
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'APPROVED')
    e.transitionTemplate(e.state.defaultWabaId, 'order_update', 'es_MX', 'PAUSED') // second pause: 6h

    e.clock.advance(3 * HOUR)
    expect(e.template(e.state.defaultWabaId, 'order_update', 'es_MX')!.status).toBe('PAUSED')
  })
})
