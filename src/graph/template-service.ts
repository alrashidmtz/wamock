import type { MockContext } from '../core/context.js'
import type { ConversationCategory } from '../core/conversations.js'
import { requireWaba } from '../core/guards.js'
import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_NAME_PATTERN,
  TEMPLATE_STATUSES,
} from '../core/templates.js'
import type { Template, TemplateCategory, TemplateStatus } from '../core/templates.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { buildTemplateStatusPayload } from '../webhooks/tech-payloads.js'

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
  PAUSED: 'PAIRWISE_QUALITY_SIGNAL',
  DISABLED: 'ABUSIVE_CONTENT',
}

const isTemplateCategory = (value: unknown): value is TemplateCategory =>
  typeof value === 'string' && (TEMPLATE_CATEGORIES as readonly string[]).includes(value)

/** Meta names conversation categories after template categories, lowercased. */
const toConversationCategory = (category: TemplateCategory): ConversationCategory =>
  category.toLowerCase() as ConversationCategory

export class TemplateService {
  readonly #context: MockContext

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
      components: Array.isArray(body['components']) ? body['components'] : [],
    }
    state.putTemplate(template)

    return { id: template.id, status: template.status, category: template.category }
  }

  /** `GET /{waba_id}/message_templates`. */
  list(wabaId: string): { data: Template[] } {
    requireWaba(this.#context, wabaId)
    return { data: this.#context.state.templatesForWaba(wabaId) }
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
    const { state, dispatcher } = this.#context

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

    state.putTemplate({ ...template, status: to })

    // Meta announces the outcome asynchronously — hours after submission, as a
    // webhook, never as a response to your API call. Integrations that only
    // react to their own calls never learn a template was approved or paused,
    // and find out when sends start failing.
    const anyNumber = state.phoneNumbers().find((phoneNumber) => phoneNumber.wabaId === wabaId)
    if (anyNumber) {
      dispatcher.dispatch(
        anyNumber.phoneNumberId,
        buildTemplateStatusPayload({
          wabaId,
          templateId: template.id,
          name,
          language,
          event: to,
          reason: TRANSITION_REASONS[to],
        }),
      )
    }

    return { success: true, status: to }
  }

  /**
   * Resolve a template for sending and check it is usable, returning the
   * conversation category it bills under.
   *
   * Two distinct failures, because integrations treat them differently:
   *
   * - **132001** — no such template in that translation. Permanent; the fix is
   *   to submit and get it approved. Also what a PENDING or REJECTED one
   *   returns: it exists in your dashboard but not for sending.
   * - **132015** — it was approved and Meta paused it for quality. Recoverable
   *   without resubmitting, so it deserves a different alert.
   */
  assertSendable(wabaId: string, spec: Record<string, unknown>): ConversationCategory {
    const name = spec['name'] as string
    const language = (spec['language'] as { code: string }).code

    const template = this.#context.state.template(wabaId, name, language)
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

    return toConversationCategory(template.category)
  }
}
