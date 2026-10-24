import type { MockContext } from '../core/context.js'
import type { PricingCategory } from '../core/pricing.js'
import { requireWaba } from '../core/guards.js'
import {
  PARAMETER_FORMATS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_STATUSES,
  templateKey,
  toTemplateView,
} from '../core/templates.js'
import type {
  ParameterFormat,
  Template,
  TemplateCategory,
  TemplateStatus,
  TemplateView,
} from '../core/templates.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { buildTemplateCategoryPayload, buildTemplateStatusPayload } from '../webhooks/tech-payloads.js'

/**
 * Message templates and their state machine (spec §5.3, §6.4).
 *
 * Everything here turns on one rule: **approval is per language**. A template
 * is identified by `wabaId` + `name` + `language`, and there is deliberately no
 * lookup that falls back to another language — that leniency is exactly what
 * hides the trap until production.
 */

export interface TemplateCreateResponse {
  id: string
  status: TemplateStatus
  category: TemplateCategory
}

/**
 * The `reason` Meta attaches to a template status webhook. `NONE` on a clean
 * approval — the field is always present, so a receiver reading it never gets
 * undefined.
 */
const TRANSITION_REASONS: Record<TemplateStatus, string> = {
  APPROVED: 'NONE',
  PENDING: 'NONE',
  REJECTED: 'INVALID_FORMAT',
  // Meta's reference: "NONE — Indicates template was paused."
  PAUSED: 'NONE',
  DISABLED: 'NONE',
}

/** Meta's own example for an INVALID_FORMAT rejection, verbatim. */
const REJECTION_INFO = {
  reason:
    'Your template has parameters placed next to each other (like {{1}}{{2}}) without text or punctuation between them.',
  recommendation:
    'Separate parameters with descriptive text and ensure each parameter is clearly contextualized.',
}

/** How far ahead Meta warns before recategorizing a template. */
const RECATEGORIZATION_NOTICE_MS = 24 * 60 * 60 * 1000

/** How long each quality pause lasts before the template unpauses itself. */
const PAUSE_MS = [3 * 60 * 60 * 1000, 6 * 60 * 60 * 1000] as const

/**
 * `other_info` on pause events. Meta documents the titles and only the unpause
 * description; the pause and disable descriptions are wamock's wording, so
 * match on `title`.
 */
const OTHER_INFO = {
  FIRST_PAUSE: 'Your WhatsApp message template has been paused for 3 hours due to low quality.',
  SECOND_PAUSE: 'Your WhatsApp message template has been paused for 6 hours due to low quality.',
  DISABLED: 'Your WhatsApp message template has been disabled after being paused too many times.',
  UNPAUSE: 'Your WhatsApp message template has been unpaused.',
} as const

const toParameterFormat = (value: unknown): ParameterFormat | undefined => {
  const upper = typeof value === 'string' ? value.toUpperCase() : undefined
  return (PARAMETER_FORMATS as readonly (string | undefined)[]).includes(upper)
    ? (upper as ParameterFormat)
    : undefined
}

const isTemplateCategory = (value: unknown): value is TemplateCategory =>
  typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)

/** Meta names pricing categories after template categories, lowercased. */
const toPricingCategory = (category: TemplateCategory): PricingCategory =>
  category.toLowerCase() as PricingCategory

export class TemplateService {
  readonly #context: MockContext
  /** Pending unpause timers, by template key, so a reset can cancel them. */
  readonly #unpauses = new Map<string, number>()
  /** Pending recategorizations, by template key, so a reset can cancel them. */
  readonly #recategorizations = new Map<string, number>()

  constructor(context: MockContext) {
    this.#context = context
  }

  /** `POST /{waba_id}/message_templates`. New templates land PENDING. */
  create(wabaId: string, body: Record<string, unknown>): TemplateCreateResponse {
    requireWaba(this.#context, wabaId)
    const { state } = this.#context

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

    // Positional unless told otherwise. Meta's request takes lowercase and its
    // list answers uppercase; wamock accepts either and stores the latter.
    const parameterFormat =
      body['parameter_format'] === undefined ? 'POSITIONAL' : toParameterFormat(body['parameter_format'])
    if (parameterFormat === undefined) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param parameter_format must be one of {named, positional}',
      })
    }

    // Meta answers a duplicate with an ERROR body whose text says "already
    // exists" — and every real integration treats that as success. Emitting the
    // error is what lets an integration test its own idempotent handling.
    if (state.template(wabaId, name, language)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: `Template name (${name}) already exists in ${language}`,
        details: `Template with name (${name}) already exists in language (${language}).`,
      })
    }

    const template: Template = {
      id: String(state.nextSeq() + 1_000_000_000_000_000),
      wabaId,
      name,
      language,
      category,
      status: 'PENDING',
      parameterFormat,
      components: Array.isArray(body['components']) ? body['components'] : [],
      pauses: 0,
    }
    state.putTemplate(template)

    return { id: template.id, status: template.status, category: template.category }
  }

  /** `GET /{waba_id}/message_templates`. */
  list(wabaId: string): { data: TemplateView[] } {
    requireWaba(this.#context, wabaId)
    return { data: this.#context.state.templatesForWaba(wabaId).map(toTemplateView) }
  }

  /** `DELETE /{waba_id}/message_templates?name=…` — removes every language. */
  delete(wabaId: string, name: string): { success: true } {
    requireWaba(this.#context, wabaId)
    if (this.#context.state.deleteTemplatesByName(wabaId, name) === 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `No template named (${name}) exists on this WhatsApp Business Account`,
      })
    }
    return { success: true }
  }

  find(wabaId: string, name: string, language: string): Template | undefined {
    return this.#context.state.template(wabaId, name, language)
  }

  /**
   * Control-API transition (spec §6.4) — what Meta's reviewers would do, on
   * demand. Scoped to one language on purpose.
   */
  transition(
    wabaId: string,
    name: string,
    language: string,
    to: TemplateStatus,
  ): { success: true; status: TemplateStatus } {
    const { state, clock } = this.#context

    if (!TEMPLATE_STATUSES.includes(to)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param to must be one of {${TEMPLATE_STATUSES.join(', ')}}`,
      })
    }

    const template = state.template(wabaId, name, language)
    if (!template) {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    const key = templateKey(wabaId, name, language)
    this.#cancelUnpause(key)

    // A pause is never just a pause: the third one disables the template for
    // good, and the first two lift themselves after 3 and 6 hours.
    if (to === 'PAUSED') {
      const pauses = template.pauses + 1
      if (pauses > PAUSE_MS.length) {
        this.#apply(template, 'DISABLED', { pauses, otherInfo: 'DISABLED' })
        return { success: true, status: 'DISABLED' }
      }
      this.#apply(template, 'PAUSED', {
        pauses,
        otherInfo: pauses === 1 ? 'FIRST_PAUSE' : 'SECOND_PAUSE',
      })
      this.#unpauses.set(
        key,
        clock.at(clock.now() + PAUSE_MS[pauses - 1]!, () => {
          this.#unpauses.delete(key)
          const current = state.template(wabaId, name, language)
          if (current?.status === 'PAUSED') this.#apply(current, 'APPROVED', { otherInfo: 'UNPAUSE' })
        }),
      )
      return { success: true, status: 'PAUSED' }
    }

    this.#apply(template, to, to === 'DISABLED' ? { otherInfo: 'DISABLED' } : {})
    return { success: true, status: to }
  }

  /**
   * Control API: Meta's automated recategorization of an approved template.
   *
   * By default it warns 24 hours ahead and changes the category when that
   * time comes. The template stays APPROVED throughout, so nothing fails: the
   * only visible effect is that sends start billing under the new category.
   * `notice: false` changes it at once, as Meta does for businesses it has
   * already warned for misuse.
   */
  recategorize(
    wabaId: string,
    name: string,
    language: string,
    options: { to: TemplateCategory; notice?: boolean },
  ): { success: true } {
    const { state, clock, dispatcher } = this.#context

    if (!isTemplateCategory(options.to)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param to must be one of {${TEMPLATE_CATEGORIES.join(', ')}}`,
      })
    }
    const template = state.template(wabaId, name, language)
    if (!template) {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    const key = templateKey(wabaId, name, language)
    const pending = this.#recategorizations.get(key)
    if (pending !== undefined) clock.clear(pending)
    this.#recategorizations.delete(key)

    const ids = { wabaId, templateId: template.id, name, language }
    const change = (): void => {
      this.#recategorizations.delete(key)
      // Only the template that was warned changes: not a replacement created
      // under the same name after a delete.
      const current = state.template(wabaId, name, language)
      if (!current || current.id !== template.id) return
      state.putTemplate({ ...current, category: options.to })
      dispatcher.dispatchToWaba(
        wabaId,
        buildTemplateCategoryPayload({
          ...ids,
          timeMs: clock.now(),
          change: { previous: current.category, next: options.to },
        }),
      )
    }

    if (options.notice === false) {
      change()
      return { success: true }
    }

    const updateAtMs = clock.now() + RECATEGORIZATION_NOTICE_MS
    dispatcher.dispatchToWaba(
      wabaId,
      buildTemplateCategoryPayload({
        ...ids,
        timeMs: clock.now(),
        notice: { current: template.category, correct: options.to, updateAtMs },
      }),
    )
    this.#recategorizations.set(key, clock.at(updateAtMs, change))
    return { success: true }
  }

  /** Cancel every pending unpause and recategorization. Part of `reset()`. */
  clear(): void {
    for (const timerId of [...this.#unpauses.values(), ...this.#recategorizations.values()]) {
      this.#context.clock.clear(timerId)
    }
    this.#unpauses.clear()
    this.#recategorizations.clear()
  }

  #cancelUnpause(key: string): void {
    const timerId = this.#unpauses.get(key)
    if (timerId === undefined) return
    this.#context.clock.clear(timerId)
    this.#unpauses.delete(key)
  }

  /**
   * Store a new status and announce it. Meta announces asynchronously, as a
   * webhook, never as a response to your call: integrations that only react to
   * their own calls never learn a template was approved or paused, and find
   * out when sends start failing.
   */
  #apply(
    template: Template,
    status: TemplateStatus,
    options: { pauses?: number; otherInfo?: keyof typeof OTHER_INFO } = {},
  ): void {
    const { state, clock, dispatcher } = this.#context
    state.putTemplate({ ...template, status, pauses: options.pauses ?? template.pauses })
    dispatcher.dispatchToWaba(
      template.wabaId,
      buildTemplateStatusPayload({
        wabaId: template.wabaId,
        templateId: template.id,
        name: template.name,
        language: template.language,
        category: template.category,
        event: status,
        reason: TRANSITION_REASONS[status],
        timeMs: clock.now(),
        ...(options.otherInfo
          ? { otherInfo: { title: options.otherInfo, description: OTHER_INFO[options.otherInfo] } }
          : {}),
        ...(status === 'DISABLED' ? { disableDateMs: clock.now() } : {}),
        ...(status === 'REJECTED' ? { rejectionInfo: REJECTION_INFO } : {}),
      }),
    )
  }

  /**
   * Resolve a template for sending and check it is usable, returning the
   * pricing category it bills under.
   *
   * Two distinct failures, because integrations treat them differently:
   *
   * - **132001** — no such template in that translation. Permanent; the fix is
   *   to submit and get it approved. Also what a PENDING or REJECTED one
   *   returns: it exists in your dashboard but not for sending.
   * - **132015** — it was approved and Meta paused it for quality. Recoverable
   *   without resubmitting, so it deserves a different alert.
   * - **132016** — paused too often and disabled for good. Only a new template
   *   gets the message out.
   */
  assertSendable(wabaId: string, spec: Record<string, unknown>): PricingCategory {
    const name = spec['name'] as string
    const language = (spec['language'] as { code: string }).code

    const template = this.#context.state.template(wabaId, name, language)
    if (!template || template.status === 'PENDING' || template.status === 'REJECTED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
        details: `template name (${name}) does not exist in ${language}`,
      })
    }

    // Disabled is not "paused, but worse": a paused template comes back on its
    // own, a disabled one never does. Alerting on them the same way sends
    // someone to wait for a template that will not return.
    if (template.status === 'DISABLED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_DISABLED, {
        details: `template name (${name}) in ${language} is DISABLED`,
      })
    }

    if (template.status === 'PAUSED') {
      throw new GraphError(ERROR_CODES.TEMPLATE_PAUSED, {
        details: `template name (${name}) in ${language} is ${template.status}`,
      })
    }

    return toPricingCategory(template.category)
  }
}
