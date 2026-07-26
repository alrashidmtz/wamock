import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { WebhookDeliverer } from '../webhooks/delivery.js'
import { buildInboundPayload, buildStatusPayload } from '../webhooks/payloads.js'
import type { InboundContent } from '../webhooks/payloads.js'
import { nullTransport } from '../webhooks/transport.js'
import type { WebhookTransport } from '../webhooks/transport.js'
import { VirtualClock } from './clock.js'
import { makeFbtraceId, makeWamid } from './ids.js'
import { normalizeWaId } from './phone.js'
import { MockState } from './state.js'

/**
 * The mock's brain: state + clock + webhook queue, with the Graph API
 * behaviours on top. Every entry point (HTTP server, library mode, CLI) is a
 * thin shell over this, so the three modes cannot drift apart.
 */

/** How long after acceptance each delivery status fires, in virtual ms. */
const STATUS_DELAYS = {
  sent: 50,
  delivered: 500,
} as const

/** Message types accepted in v1. `reaction`/`image` are stubbed in later phases. */
const SUPPORTED_TYPES = new Set(['text'])

export interface WamockEngineOptions {
  appSecret: string
  /** `frozen` for tests (time only moves via advance), `live` for the server. */
  mode?: 'frozen' | 'live'
  start?: number
  transport?: WebhookTransport
  phoneNumberId?: string
  wabaId?: string
  displayPhoneNumber?: string
}

export interface SendMessageResponse {
  messaging_product: 'whatsapp'
  contacts: Array<{ input: string; wa_id: string }>
  messages: Array<{ id: string; message_status: string }>
}

export class WamockEngine {
  readonly clock: VirtualClock
  readonly state: MockState
  readonly deliverer: WebhookDeliverer

  constructor(options: WamockEngineOptions) {
    this.clock = new VirtualClock({
      mode: options.mode ?? 'live',
      ...(options.start !== undefined ? { start: options.start } : {}),
    })
    this.state = new MockState({
      appSecret: options.appSecret,
      ...(options.phoneNumberId !== undefined ? { phoneNumberId: options.phoneNumberId } : {}),
      ...(options.wabaId !== undefined ? { wabaId: options.wabaId } : {}),
      ...(options.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: options.displayPhoneNumber }
        : {}),
    })
    this.deliverer = new WebhookDeliverer({
      clock: this.clock,
      transport: options.transport ?? nullTransport,
    })
  }

  /** A deterministic `fbtrace_id` for the next error. */
  nextFbtraceId(): string {
    return makeFbtraceId(this.state.nextSeq())
  }

  /** Await any webhook deliveries the last `advance()` kicked off. */
  async settle(): Promise<void> {
    await this.deliverer.settle()
  }

  // --- POST /{version}/{phone_number_id}/messages -------------------------

  sendMessage(phoneNumberId: string, body: Record<string, unknown>): SendMessageResponse {
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      // Meta's wording for an object id it does not recognize.
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Unsupported post request',
        details: `Object with ID '${phoneNumberId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      })
    }

    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: "Param messaging_product must be 'whatsapp'",
      })
    }

    const rawTo = body['to']
    if (typeof rawTo !== 'string' || rawTo.trim() === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param to is required' })
    }

    const type = typeof body['type'] === 'string' ? body['type'] : 'text'
    if (!SUPPORTED_TYPES.has(type)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param type must be one of {${[...SUPPORTED_TYPES].join(', ')}}`,
      })
    }

    this.#assertTypePayload(type, body)

    // A well-formed request to an unreachable number is 131026, NOT 100. The
    // distinction is what tells an integration "fix your code" from "drop this
    // contact", and integrations really do branch on it.
    const waId = normalizeWaId(rawTo)
    if (!waId) {
      throw new GraphError(ERROR_CODES.UNDELIVERABLE)
    }

    const wamid = makeWamid(phoneNumberId, this.state.nextSeq())
    const { messaging_product: _mp, to: _to, type: _t, ...rest } = body

    this.state.recordOutbound({
      id: wamid,
      phoneNumberId,
      to: waId,
      type,
      payload: rest,
      sentAt: this.clock.now(),
    })

    this.#scheduleStatuses(phoneNumberId, wamid, waId)

    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: rawTo, wa_id: waId }],
      messages: [{ id: wamid, message_status: 'accepted' }],
    }
  }

  // --- control: simulate a customer writing in ----------------------------

  /**
   * Deliver an inbound message webhook, as if a customer had written. Returns
   * the generated wamid so callers can correlate.
   */
  simulateInbound(options: {
    from: string
    phoneNumberId?: string
    contactName?: string
    message: InboundContent
  }): { messageId: string } {
    const phoneNumberId = options.phoneNumberId ?? this.state.defaultPhoneNumberId
    const phoneNumber = this.state.phoneNumber(phoneNumberId)
    if (!phoneNumber) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    const waId = normalizeWaId(options.from)
    if (!waId) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `'${options.from}' is not a valid phone number`,
      })
    }

    const messageId = makeWamid(phoneNumberId, this.state.nextSeq())
    const payload = buildInboundPayload({
      wabaId: phoneNumber.wabaId,
      phoneNumberId,
      displayPhoneNumber: phoneNumber.displayPhoneNumber,
      from: waId,
      ...(options.contactName !== undefined ? { contactName: options.contactName } : {}),
      messageId,
      timestampMs: this.clock.now(),
      message: options.message,
    })

    this.#enqueue(phoneNumberId, payload)
    return { messageId }
  }

  reset(): void {
    this.deliverer.clear()
    this.state.reset()
  }

  // --- internals ----------------------------------------------------------

  #assertTypePayload(type: string, body: Record<string, unknown>): void {
    if (type === 'text') {
      const text = body['text'] as { body?: unknown } | undefined
      if (typeof text?.body !== 'string' || text.body === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param text[body] is required for type text',
        })
      }
    }
  }

  #scheduleStatuses(phoneNumberId: string, wamid: string, recipientId: string): void {
    for (const [status, delay] of Object.entries(STATUS_DELAYS)) {
      const at = this.clock.now() + delay
      const phoneNumber = this.state.phoneNumber(phoneNumberId)!
      this.#enqueue(
        phoneNumberId,
        buildStatusPayload({
          wabaId: phoneNumber.wabaId,
          phoneNumberId,
          displayPhoneNumber: phoneNumber.displayPhoneNumber,
          messageId: wamid,
          status: status as 'sent' | 'delivered',
          recipientId,
          timestampMs: at,
        }),
        at,
      )
    }
  }

  #enqueue(
    phoneNumberId: string,
    payload: ReturnType<typeof buildStatusPayload>,
    atMs?: number,
  ): void {
    const appSecret = this.state.appSecretForPhoneNumber(phoneNumberId)
    // Unknown number → no secret → nothing to sign with. Callers validate the
    // number first, so reaching here means a bug, not a user error.
    if (!appSecret) return
    this.deliverer.enqueue(payload, {
      appSecret,
      ...(atMs !== undefined ? { atMs } : {}),
    })
  }
}
