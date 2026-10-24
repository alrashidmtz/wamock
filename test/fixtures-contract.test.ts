import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { WamockEngine } from '../src/core/engine.js'
import { ERROR_CODES, GraphError } from '../src/errors/graph-error.js'
import { buildInboundPayload, buildStatusPayload } from '../src/webhooks/payloads.js'

/**
 * The fixtures, held to what the mock actually emits.
 *
 * `test/fixtures/` is documented as the contract wamock is tested against, and
 * for a long time nothing read it. `status-failed.json` carried an
 * `error_data.details` the builder never produced, and nobody noticed: a
 * fixture no test reads is prose, and prose rots. Each one is now rebuilt from
 * the real builders with the placeholder ids it uses, and must match exactly.
 */

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures')
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))

const CONTEXT = { wabaId: 'WABA_1', phoneNumberId: 'PNID_1', displayPhoneNumber: '15550001111' }
const CUSTOMER = '5215555000001'
const USER = { waId: CUSTOMER, userId: 'MX.13491208655302741918', phoneShared: true, name: 'Test Customer' }

describe('webhook fixtures', () => {
  it('inbound-text.json', () => {
    expect(
      buildInboundPayload({
        ...CONTEXT,
        user: USER,
        messageId: 'wamid.TEST1',
        timestampMs: 1_750_000_000_000,
        message: { type: 'text', text: { body: 'hola' } },
      }),
    ).toEqual(fixture('inbound-text.json'))
  })

  it('inbound-interactive-reply.json', () => {
    const expected = fixture('inbound-interactive-reply.json') as {
      entry: Array<{ changes: Array<{ value: { messages: Array<{ id: string }> } }> }>
    }
    expect(
      buildInboundPayload({
        ...CONTEXT,
        user: USER,
        messageId: expected.entry[0]!.changes[0]!.value.messages[0]!.id,
        timestampMs: 1_750_000_060_000,
        message: {
          type: 'interactive',
          interactive: { type: 'button_reply', button_reply: { id: 'confirm_yes', title: 'Yes' } },
        },
      }),
    ).toEqual(expected)
  })

  it('statuses-only.json', () => {
    expect(
      buildStatusPayload({
        ...CONTEXT,
        messageId: 'wamid.TESTOUT1',
        status: 'delivered',
        user: USER,
        sentTo: 'phone',
        timestampMs: 1_750_000_120_000,
        pricing: {
          billable: false,
          pricing_model: 'PMP',
          type: 'free_customer_service',
          category: 'service',
        },
      }),
    ).toEqual(fixture('statuses-only.json'))
  })

  it('status-failed.json', () => {
    expect(
      buildStatusPayload({
        ...CONTEXT,
        messageId: 'wamid.TESTOUT2',
        status: 'failed',
        user: USER,
        sentTo: 'phone',
        timestampMs: 1_750_000_180_000,
        errorCode: ERROR_CODES.UNDELIVERABLE,
      }),
    ).toEqual(fixture('status-failed.json'))
  })
})

describe('Graph response fixtures', () => {
  it('error-131047-reengagement.json', () => {
    expect(new GraphError(ERROR_CODES.REENGAGEMENT).toBody('AtEsT0000000000000000001')).toEqual(
      fixture('error-131047-reengagement.json'),
    )
  })

  it('error-132001-template-not-found.json', () => {
    expect(
      new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: 'template name (order_update) does not exist in en_US',
      }).toBody('AtEsT0000000000000000002'),
    ).toEqual(fixture('error-132001-template-not-found.json'))
  })

  it('error-190-token-expired.json', () => {
    expect(new GraphError(ERROR_CODES.TOKEN_EXPIRED).toBody('AtEsT0000000000000000003')).toEqual(
      fixture('error-190-token-expired.json'),
    )
  })

  it('send-text-response.json', () => {
    const engine = new WamockEngine({ appSecret: 's', mode: 'frozen', start: 1_750_000_000_000 })
    engine.simulateInbound({ from: CUSTOMER, message: { type: 'text', text: { body: 'hola' } } })

    const res = engine.sendMessage(engine.state.defaultPhoneNumberId, {
      messaging_product: 'whatsapp',
      to: CUSTOMER,
      type: 'text',
      text: { body: 'hi' },
    })

    // The wamid is generated; everything else must match the fixture exactly.
    expect(res.messages[0]!.id).toMatch(/^wamid\./)
    expect({ ...res, messages: [{ ...res.messages[0]!, id: 'wamid.TESTOUT1' }] }).toEqual(
      fixture('send-text-response.json'),
    )
  })
})
