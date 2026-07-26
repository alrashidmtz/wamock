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
import { ServiceWindows } from './window.js'
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_STATUSES,
} from './templates.js'
import type { Template, TemplateCategory, TemplateStatus } from './templates.js'

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
const SUPPORTED_TYPES = new Set(['text', 'template'])

/**
 * Types that require an open 24h service window. Templates are exempt — being
 * the only way out of a closed window is what templates are for.
 */
const REQUIRES_OPEN_WINDOW = new Set(['text', 'interactive'])

export interface WamockEngineOptions {
  appSecret: string
  /** `frozen` for tests (time only moves via advance), `live` for the server. */
  mode?: 'frozen' | 'live'
  start?: number
  transport?: WebhookTransport
  /** Override the 24h service window length — useful for cheap expiry tests. */
  windowMs?: number
  phoneNumberId?: string
  wabaId?: string
  displayPhoneNumber?: string
}

export interface TemplateCreateResponse {
  id: string
  status: TemplateStatus
  category: TemplateCategory
}

const isTemplateCategory = (value: unknown): value is TemplateCategory =>
  typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)

export interface SendMessageResponse {
  messaging_product: 'whatsapp'
  contacts: Array<{ input: string; wa_id: string }>
  messages: Array<{ id: string; message_status: string }>
}

export class WamockEngine {
  readonly clock: VirtualClock
  readonly state: MockState
  readonly deliverer: WebhookDeliverer
  readonly windows: ServiceWindows

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
    this.windows = new ServiceWindows(
      options.windowMs !== undefined ? { windowMs: options.windowMs } : {},
    )
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

    if (REQUIRES_OPEN_WINDOW.has(type) && !this.windows.isOpen(phoneNumberId, waId, this.clock.now())) {
      throw new GraphError(ERROR_CODES.REENGAGEMENT)
    }

    if (type === 'template') {
      this.#assertTemplateSendable(phoneNumber.wabaId, body['template'] as Record<string, unknown>)
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

    // The customer writing is the ONLY thing that opens or renews the window.
    this.windows.recordInbound(phoneNumberId, waId, this.clock.now())

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

  // --- templates (spec §5.3) ----------------------------------------------

  /** `POST /{waba_id}/message_templates`. New templates land PENDING. */
  createTemplate(wabaId: string, body: Record<string, unknown>): TemplateCreateResponse {
    this.#assertWaba(wabaId)

    const name = body['name']
    if (typeof name !== 'string' || !TEMPLATE_NAME_PATTERN.test(name)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param name must contain only lowercase letters, digits and underscores',
      })
    }

    const language = body['language']
    if (typeof language !== 'string' || language === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param language is required' })
    }

    const category = body['category']
    if (!isTemplateCategory(category)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param category must be one of {${TEMPLATE_CATEGORIES.join(', ')}}`,
      })
    }

    // Meta answers a duplicate with an ERROR body whose text says "already
    // exists" — and every real integration treats that as success. Emitting the
    // error is what lets an integration test its own idempotent handling.
    if (this.state.template(wabaId, name, language)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: `Template name (${name}) already exists in ${language}`,
        details: `Template with name (${name}) already exists in language (${language}).`,
      })
    }

    const template: Template = {
      id: String(this.state.nextSeq() + 1_000_000_000_000_000),
      wabaId,
      name,
      language,
      category,
      status: 'PENDING',
      components: Array.isArray(body['components']) ? body['components'] : [],
    }
    this.state.putTemplate(template)

    return { id: template.id, status: template.status, category: template.category }
  }

  /** `GET /{waba_id}/message_templates`. */
  listTemplates(wabaId: string): { data: Template[] } {
    this.#assertWaba(wabaId)
    return { data: this.state.templatesForWaba(wabaId) }
  }

  /** `DELETE /{waba_id}/message_templates?name=…` — removes every language. */
  deleteTemplate(wabaId: string, name: string): { success: true } {
    this.#assertWaba(wabaId)
    if (this.state.deleteTemplatesByName(wabaId, name) === 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No template named (${name}) exists on this WhatsApp Business Account`,
      })
    }
    return { success: true }
  }

  template(wabaId: string, name: string, language: string): Template | undefined {
    return this.state.template(wabaId, name, language)
  }

  /**
   * Control-API transition (spec §6.4) — what Meta's reviewers would do,
   * on demand. Scoped to one language on purpose.
   */
  transitionTemplate(
    wabaId: string,
    name: string,
    language: string,
    to: TemplateStatus,
  ): { success: true; status: TemplateStatus } {
    if (!TEMPLATE_STATUSES.includes(to)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param to must be one of {${TEMPLATE_STATUSES.join(', ')}}`,
      })
    }

    const template = this.state.template(wabaId, name, language)
    if (!template) {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    this.state.putTemplate({ ...template, status: to })
    return { success: true, status: to }
  }

  reset(): void {
    this.deliverer.clear()
    this.state.reset()
    this.windows.clear()
  }

  // --- internals ----------------------------------------------------------

  #assertWaba(wabaId: string): void {
    if (!this.state.waba(wabaId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Unsupported post request',
        details: `Object with ID '${wabaId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`,
      })
    }
  }

  #assertTypePayload(type: string, body: Record<string, unknown>): void {
    if (type === 'text') {
      const text = body['text'] as { body?: unknown } | undefined
      if (typeof text?.body !== 'string' || text.body === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param text[body] is required for type text',
        })
      }
    }

    if (type === 'template') {
      const template = body['template'] as
        | { name?: unknown; language?: { code?: unknown } }
        | undefined
      if (typeof template?.name !== 'string') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param template[name] is required for type template',
        })
      }
      if (typeof template.language?.code !== 'string') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Param template[language][code] is required for type template',
        })
      }
    }
  }

  /**
   * Resolve a template by the exact `name` + `language` pair and check it is
   * usable. Two distinct failures, because integrations treat them differently:
   *
   * - **132001** — no such template in that translation. Permanent; the fix is
   *   to submit and get it approved. Also what you get for a PENDING or
   *   REJECTED one: it exists in your dashboard but not for sending.
   * - **132015** — it was approved and Meta paused it for quality. Recoverable
   *   without a resubmission, so it deserves a different alert.
   */
  #assertTemplateSendable(wabaId: string, spec: Record<string, unknown>): void {
    const name = spec['name'] as string
    const language = (spec['language'] as { code: string }).code

    const template = this.state.template(wabaId, name, language)
    if (!template || template.status === 'PENDING' || template.status === 'REJECTED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    if (template.status === 'PAUSED' || template.status === 'DISABLED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_PAUSED, {
        details: `template name (${name}) in ${language} is ${template.status}`,
      })
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
