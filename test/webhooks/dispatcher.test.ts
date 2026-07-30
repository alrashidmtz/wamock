import { describe, expect, it } from 'vitest'

import { VirtualClock } from '../../src/core/clock.js'
import { ScenarioController } from '../../src/core/scenario.js'
import { MockState } from '../../src/core/state.js'
import { WebhookDeliverer } from '../../src/webhooks/delivery.js'
import { WebhookDispatcher } from '../../src/webhooks/dispatcher.js'
import { buildStatusPayload } from '../../src/webhooks/payloads.js'
import { verifySignature } from '../../src/webhooks/signature.js'

/**
 * The dispatcher is the single gate every webhook passes through, so its three
 * rules are tested here directly rather than only through the endpoints that
 * happen to exercise them.
 */

const EPOCH = 1_750_000_000_000

function harness() {
  const clock = new VirtualClock({ mode: 'frozen', start: EPOCH })
  const state = new MockState({ appSecret: 'platform-secret' })
  const scenario = new ScenarioController()
  const sent: Array<{ body: string; signature: string }> = []
  const deliverer = new WebhookDeliverer({
    clock,
    transport: async (d) => {
      sent.push({ body: d.body, signature: d.signature })
    },
  })
  const dispatcher = new WebhookDispatcher(state, deliverer, scenario)
  return { clock, state, scenario, deliverer, dispatcher, sent }
}

const payload = (state: MockState) =>
  buildStatusPayload({
    wabaId: state.defaultWabaId,
    phoneNumberId: state.defaultPhoneNumberId,
    displayPhoneNumber: '15550001111',
    messageId: 'wamid.X',
    status: 'sent',
    recipientId: '5215555000001',
    timestampMs: EPOCH,
  })

const flush = async (h: ReturnType<typeof harness>) => {
  h.clock.advance(0)
  await h.deliverer.settle()
}

describe('rule 1 — the subscription gate', () => {
  it('delivers for a subscribed WABA', async () => {
    const h = harness()
    h.dispatcher.dispatch(h.state.defaultPhoneNumberId, payload(h.state))
    await flush(h)

    expect(h.sent).toHaveLength(1)
  })

  it('delivers NOTHING for an unsubscribed WABA, and reports no error', async () => {
    // Meta's actual behaviour is silence. Returning an error here would make
    // the mock friendlier and useless for the one thing this reproduces: a
    // number that connects fine and never receives anything.
    const h = harness()
    h.state.registerApp({ appId: 'APP_T', appSecret: 's' })
    h.state.registerWaba({ wabaId: 'WABA_T', appId: 'APP_T' }) // no subscription
    h.state.registerPhoneNumber({
      phoneNumberId: 'PNID_T',
      wabaId: 'WABA_T',
      displayPhoneNumber: '15550002222',
    })

    expect(() => h.dispatcher.dispatch('PNID_T', payload(h.state))).not.toThrow()
    await flush(h)

    expect(h.sent).toHaveLength(0)
  })

  it('ignores a phone number it does not host', async () => {
    const h = harness()
    h.dispatcher.dispatch('PNID_GHOST', payload(h.state))
    await flush(h)

    expect(h.sent).toHaveLength(0)
  })
})

describe('rule 2 — per-tenant signing', () => {
  it('signs with the secret of the app that owns the number', async () => {
    const h = harness()
    h.state.registerApp({ appId: 'APP_T', appSecret: 'tenant-secret' })
    h.state.registerWaba({ wabaId: 'WABA_T', appId: 'APP_T' })
    h.state.subscribeApp('WABA_T', 'APP_T')
    h.state.registerPhoneNumber({
      phoneNumberId: 'PNID_T',
      wabaId: 'WABA_T',
      displayPhoneNumber: '15550002222',
    })

    h.dispatcher.dispatch('PNID_T', payload(h.state))
    await flush(h)

    const delivery = h.sent[0]!
    expect(verifySignature({ appSecret: 'tenant-secret', body: delivery.body, header: delivery.signature })).toBe(true)
    expect(verifySignature({ appSecret: 'platform-secret', body: delivery.body, header: delivery.signature })).toBe(false)
  })
})

describe('rule 3 — at-least-once', () => {
  it('sends one copy by default', async () => {
    const h = harness()
    h.dispatcher.dispatch(h.state.defaultPhoneNumberId, payload(h.state))
    await flush(h)

    expect(h.sent).toHaveLength(1)
  })

  it('sends two copies under the duplication scenario', async () => {
    const h = harness()
    h.scenario.configure({ duplicateWebhooks: true })

    h.dispatcher.dispatch(h.state.defaultPhoneNumberId, payload(h.state))
    await flush(h)

    expect(h.sent).toHaveLength(2)
    expect(h.sent[0]!.body).toBe(h.sent[1]!.body)
  })
})

describe('dispatchStatus', () => {
  it('builds and delivers a status for a hosted number', async () => {
    const h = harness()
    h.dispatcher.dispatchStatus(h.state.defaultPhoneNumberId, {
      messageId: 'wamid.Y',
      status: 'read',
      recipientId: '5215555000001',
      timestampMs: EPOCH,
    })
    await flush(h)

    const value = JSON.parse(h.sent[0]!.body).entry[0].changes[0].value
    expect(value.statuses[0]).toMatchObject({ id: 'wamid.Y', status: 'read' })
  })

  it('does nothing for a number it does not host', async () => {
    const h = harness()
    h.dispatcher.dispatchStatus('PNID_GHOST', {
      messageId: 'wamid.Y',
      status: 'read',
      recipientId: '5215555000001',
      timestampMs: EPOCH,
    })
    await flush(h)

    expect(h.sent).toHaveLength(0)
  })
})
