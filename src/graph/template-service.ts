import type { MockContext } from '../core/context.js'
import { isRecord, textOf } from '../core/values.js'
import type { PricingCategory } from '../core/pricing.js'
import { requireWaba } from '../core/guards.js'
import {
  PARAMETER_FORMATS,
  SUPPORTED_LANGUAGES,
  TEMPLATE_CATEGORIES,
  TEMPLATE_NAME_MAX,
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
import { pageOf } from './paging.js'
import type { PageOptions } from './paging.js'

/**
 * Message templates and their state machine (spec §5.3, §6.4).
 *
 * Everything here turns on one rule: **approval is per language**. A template
 * is identified by `wabaId` + `name` + `language`, and there is deliberately no
 * lookup that falls back to another language — that leniency is exactly what
 * hides the trap until production.
 */

/** Query of `GET /{waba_id}/message_templates`. */
export interface TemplateListOptions extends PageOptions {
  name?: string
  /** Where `paging.next` and `previous` point: the mock's address over HTTP. */
  baseUrl?: string
  version?: string
}

/** A numeric template id no other object holds, so no two records share one. */
function freshTemplateId(state: MockContext['state']): string {
  let id = String(state.nextSeq() + 1_000_000_000_000_000)
  while (state.isIdTaken(id)) id = String(state.nextSeq() + 1_000_000_000_000_000)
  return id
}

/** Templates per page when the call sets no `limit`. */
const TEMPLATE_PAGE_SIZE = 25

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
    if (name.length > TEMPLATE_NAME_MAX) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param name exceeds the ${TEMPLATE_NAME_MAX} character limit (got ${name.length})`,
      })
    }

    const language = body['language']
    if (typeof language !== 'string' || language === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param language is required' })
    }
    // Case-sensitive, like Meta's list: `es_mx` is the typo a lenient mock lets through.
    if (!SUPPORTED_LANGUAGES.has(language)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Param language (${language}) is not a supported template language code`,
      })
    }

    // Meta's own examples send the category in lowercase; it is stored, and
    // listed, in uppercase.
    const category = typeof body['category'] === 'string' ? body['category'].toUpperCase() : body['category']
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

    assertCopyCodeExamples(body['components'])

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
      id: freshTemplateId(state),
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
  /**
   * `GET /{waba_id}/message_templates`, paged like every Graph edge. Without
   * `limit`, 25 a page: integrators report it as Meta's default, and an
   * integration that never follows `paging.next` loses templates past it.
   * `name` keeps only that template's languages.
   */
  list(wabaId: string, options: TemplateListOptions = {}): { data: TemplateView[]; paging?: Record<string, unknown> } {
    requireWaba(this.#context, wabaId, 'get')
    const templates = this.#context.state
      .templatesForWaba(wabaId)
      .filter((template) => options.name === undefined || template.name === options.name)
    const byId = new Map(templates.map((template) => [template.id, template]))
    const link = (param: 'after' | 'before', cursor: string) => {
      const url = new URL(`${options.baseUrl ?? 'https://graph.facebook.com'}/${options.version ?? 'v26.0'}/${wabaId}/message_templates`)
      if (options.name !== undefined) url.searchParams.set('name', options.name)
      if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit))
      url.searchParams.set(param, cursor)
      return url.toString()
    }
    const page = pageOf([...byId.keys()], { ...options, defaultLimit: TEMPLATE_PAGE_SIZE }, link)
    if (!page) {
      // 131059 from v24.0, per Meta's changelog. Earlier versions are not
      // documented; wamock answers them with Graph's generic invalid parameter.
      const major = Number(/^v(\d+)/.exec(options.version ?? 'v26.0')?.[1])
      if (major >= 24) throw new GraphError(ERROR_CODES.INVALID_PAGINATION_CURSOR)
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param after or before is not a valid cursor' })
    }
    const data = page.ids.map((id) => toTemplateView(byId.get(id)!))
    return page.paging ? { data, paging: page.paging } : { data }
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

    // Each component must be an object before anything reads its fields: a
    // malformed send is the caller's 100, not a fault in the mock.
    const sent = spec['components']
    if (sent !== undefined && (!Array.isArray(sent) || !sent.every(isRecord))) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param template[components] must be an array of objects' })
    }
    assertParameters(template, sent)
    assertCouponCodes(sent)
    return toPricingCategory(template.category)
  }
}

/**
 * A copy code button copies at most 20 characters, both its example at
 * creation and the `coupon_code` sent ("Maximum 20 characters", Meta's coupon
 * template page; raised from 15 in December 2025).
 */
const COUPON_CODE_MAX = 20


function assertCopyCodeExamples(components: unknown): void {
  if (!Array.isArray(components)) return
  for (const component of components) {
    if (!isRecord(component) || !Array.isArray(component['buttons'])) continue
    for (const button of component['buttons'] as unknown[]) {
      if (!isRecord(button) || button['type'] !== 'COPY_CODE') continue
      const example = button['example']
      if (typeof example !== 'string' || example === '' || example.length > COUPON_CODE_MAX) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: `Param COPY_CODE example must be a code of 1 to ${COUPON_CODE_MAX} characters`,
        })
      }
    }
  }
}

function assertCouponCodes(components: unknown): void {
  if (!Array.isArray(components)) return
  for (const component of components) {
    if (!isRecord(component) || component['sub_type'] !== 'copy_code' || !Array.isArray(component['parameters'])) continue
    for (const parameter of component['parameters'] as unknown[]) {
      if (!isRecord(parameter) || parameter['type'] !== 'coupon_code') continue
      const code = parameter['coupon_code']
      if (typeof code !== 'string' || code === '' || code.length > COUPON_CODE_MAX) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: `Param coupon_code must be a code of 1 to ${COUPON_CODE_MAX} characters`,
        })
      }
    }
  }
}

/**
 * A text-component parameter must carry a value in its type's form: `text`
 * as a string, `currency` and `date_time` as objects. Anything else — an empty
 * object, a number for text, `null` — is 132012, rather than being counted as
 * a parameter and sent.
 */
function assertParameterFormat(templateName: string, kind: string, parameter: unknown): void {
  const value = (field: string) => (parameter as Record<string, unknown>)[field]
  const ok =
    typeof parameter === 'object' &&
    parameter !== null &&
    ((value('type') === 'text' && typeof value('text') === 'string') ||
      (value('type') === 'currency' && typeof value('currency') === 'object' && value('currency') !== null) ||
      (value('type') === 'date_time' && typeof value('date_time') === 'object' && value('date_time') !== null))
  if (!ok) {
    throw new GraphError(ERROR_CODES.TEMPLATE_PARAMETER_FORMAT, {
      details: `template name (${templateName}): a ${kind} parameter needs a type and its value (text, currency or date_time)`,
    })
  }
}

/**
 * The distinct `{{1}}` / `{{first_name}}` placeholders in a template string,
 * written as Meta documents them: no spaces inside the brackets. `{{ 1 }}`
 * appears nowhere in Meta's docs, so wamock reads it as text rather than let
 * a test pass on a syntax production may not take.
 */
const placeholdersOf = (text: unknown): Set<string> =>
  new Set(typeof text === 'string' ? [...text.matchAll(/\{\{([a-z0-9_]+)\}\}/g)].map((m) => m[1]!) : [])

/**
 * A send must supply exactly the parameters the template defines, per
 * component: as many as there are distinct positional placeholders, or the
 * same set of names for a named template. Anything else is 132000 at send
 * time, which a mock that never looked at `components` let through until the
 * first real send.
 *
 * Checked for the text header and the body, the components that carry text
 * placeholders. Media headers and buttons are not checked.
 */
function assertParameters(template: Template, sent: unknown): void {
  // A template seeded without components (`mock.approveTemplate` with none)
  // has no known text to check against; Meta never holds one like that.
  if (template.components.length === 0) return
  const sentComponents = Array.isArray(sent) ? (sent as Array<Record<string, unknown>>) : []
  for (const kind of ['header', 'body'] as const) {
    const defined = template.components.find(
      (c): c is Record<string, unknown> =>
        typeof c === 'object' && c !== null && textOf((c as Record<string, unknown>)['type']).toLowerCase() === kind,
    )
    // A media header (IMAGE, VIDEO, DOCUMENT…) takes its media as a parameter
    // and has no text placeholders to count; only a TEXT header is checked.
    if (kind === 'header' && defined && defined['format'] !== undefined && textOf(defined['format']).toUpperCase() !== 'TEXT') {
      continue
    }
    const expected = defined ? placeholdersOf(defined['text']) : new Set<string>()
    const supplied = sentComponents.find((c) => textOf(c['type']).toLowerCase() === kind)
    const parameters = Array.isArray(supplied?.['parameters']) ? (supplied['parameters'] as Array<Record<string, unknown>>) : []

    // Named: the exact set of names, each once. Comparing counts and checking
    // membership alone let a repeated name hide a missing one.
    for (const parameter of parameters) assertParameterFormat(template.name, kind, parameter)
    const names = parameters.map((p) => p['parameter_name'])
    const matches =
      template.parameterFormat === 'NAMED'
        ? parameters.length === expected.size &&
          new Set(names).size === names.length &&
          names.every((name) => typeof name === 'string' && expected.has(name))
        : parameters.length === expected.size
    if (!matches) {
      throw new GraphError(ERROR_CODES.TEMPLATE_PARAMETER_MISMATCH, {
        details: `template name (${template.name}) expects ${expected.size} ${kind} parameter(s) and got ${parameters.length}`,
      })
    }
  }
}
