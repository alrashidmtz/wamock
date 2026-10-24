import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { WamockEngine } from '../core/engine.js'
import { TEMPLATE_CATEGORIES, TEMPLATE_STATUSES } from '../core/templates.js'
import { CONNECTION_STATUSES, MESSAGING_TIERS } from '../core/types.js'
import type { Business, PhoneNumber } from '../core/types.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { LAST_INSTANT_MS } from '../core/clock.js'
import { MESSAGE_STATUSES } from '../webhooks/payloads.js'
import type { InboundContent } from '../webhooks/payloads.js'

/**
 * The control API (`/__mock/*`) — everything Meta does not give you.
 *
 * Spec §6: this surface is as much the product as the emulation is. Being able
 * to say "the customer replied", "24 hours passed", "Meta paused that template"
 * is the reason to reach for a mock instead of reading documentation.
 */

/**
 * An integer, checked the way zod 3 checked it. zod 4's `.int()` also refuses
 * anything past Number.MAX_SAFE_INTEGER and stops every check after it, so a
 * negative fraction lost its second complaint. A refinement keeps both 0.3.1
 * behaviours; `describeIssue` recognises it by its params.
 */
const integer = () => z.number().refine(Number.isInteger, { params: { wamock: 'integer' } })

const InboundMediaSchema = z
  .object({
    caption: z.string().optional(),
    filename: z.string().optional(),
    mime_type: z.string().optional(),
    voice: z.boolean().optional(),
    animated: z.boolean().optional(),
    data: z.string().optional(),
  })
  .strict()

const InboundSchema = z
  .object({
    from: z.string(),
    phone_number_id: z.string().optional(),
    name: z.string().optional(),
    username: z.string().nullable().optional(),
    // A Click-to-WhatsApp ad, with the fields Meta documents for `referral`.
    referral: z
      .object({
        source_url: z.string().optional(),
        source_id: z.string().optional(),
        source_type: z.string().optional(),
        body: z.string().optional(),
        headline: z.string().optional(),
        media_type: z.string().optional(),
        image_url: z.string().optional(),
        video_url: z.string().optional(),
        thumbnail_url: z.string().optional(),
        ctwa_clid: z.string().optional(),
        welcome_message: z.object({ text: z.string() }).strict().optional(),
      })
      .strict()
      .optional(),
    type: z.string().optional(),
    text: z.string().optional(),
    // Media a customer sends. `data` is the file as base64; without it wamock
    // stores a placeholder, and the media is downloadable either way.
    image: InboundMediaSchema.optional(),
    video: InboundMediaSchema.optional(),
    document: InboundMediaSchema.optional(),
    audio: InboundMediaSchema.optional(),
    sticker: InboundMediaSchema.optional(),
    location: z
      .object({
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional(),
        address: z.string().optional(),
        url: z.string().optional(),
      })
      .strict()
      .optional(),
    contacts: z.array(z.record(z.string(), z.unknown())).optional(),
    // Without `emoji`: the customer removed their reaction, which Meta reports
    // as a reaction webhook with no `emoji` field.
    reaction: z.object({ message_id: z.string(), emoji: z.string().optional() }).strict().optional(),
    // A tap on a template's quick-reply button.
    button: z.object({ payload: z.string(), text: z.string() }).strict().optional(),
    unsupported: z.object({ type: z.string() }).strict().optional(),
    // A Coexistence customer editing (a text, or a media caption) or revoking
    // a message they sent, by its wamid.
    edit: z
      .object({ message_id: z.string(), text: z.string().optional(), caption: z.string().optional() })
      .strict()
      .optional(),
    revoke: z.object({ message_id: z.string() }).strict().optional(),
    // The wamid the customer replies to: delivered as `context: {from, id}`.
    context_id: z.string().optional(),
    button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    list_reply: z
      .object({ id: z.string(), title: z.string(), description: z.string().optional() })
      .optional(),
  })
  // `.strict()`, like every other control schema: an ignored typo leaves the
  // caller believing they configured something they did not. It also keeps
  // unexpected keys from ever reaching the payload builder.
  .strict()

// `.strict()` like the rest: a rejected call must name the key you got
// wrong, not silently ignore it and complain only about what is missing.
const AdvanceSchema = z.object({ ms: integer() }).strict()

const TransitionSchema = z.object({ to: z.enum(TEMPLATE_STATUSES) }).strict()

const RecategorizeSchema = z
  .object({ to: z.enum(TEMPLATE_CATEGORIES), notice: z.boolean().optional() })
  .strict()

const AppContactSchema = z
  .object({ phone: z.string(), full_name: z.string().optional(), first_name: z.string().optional() })
  .strict()

const SignupSchema = z
  .object({
    subscribed: z.boolean().optional(),
    business_id: z.string().min(1).optional(),
    // How the customer finished: with a verified number, an unverified one, or
    // none; and whether the test skips registering it.
    phone: z.enum(['verified', 'unverified', 'none']).optional(),
    registered: z.boolean().optional(),
    // A number already on the WhatsApp Business app, with what the app holds.
    coexistence: z.boolean().optional(),
    share_history: z.boolean().optional(),
    contacts: z.array(AppContactSchema).optional(),
    history: z
      .array(
        z
          .object({
            phone: z.string(),
            messages: z.array(
              z
                .object({ direction: z.enum(['in', 'out']), text: z.string(), ago_ms: z.number().nonnegative() })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()

const AppSendSchema = z
  .object({ phone_number_id: z.string(), to: z.string(), text: z.string() })
  .strict()

const AppContactChangeSchema = z
  .object({
    phone_number_id: z.string(),
    phone: z.string(),
    full_name: z.string().optional(),
    first_name: z.string().optional(),
    action: z.enum(['add', 'remove']).optional(),
  })
  .strict()

const AppOffboardSchema = z
  .object({ phone_number_id: z.string(), reconnect: z.boolean().optional() })
  .strict()

const TokenSchema = z
  .object({
    kind: z.enum(['permanent', 'short', 'long']).optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict()

const PreferenceSchema = z
  .object({ from: z.string(), value: z.enum(['stop', 'resume']), phone_number_id: z.string().optional() })
  .strict()

const NumberChangeSchema = z
  .object({ from: z.string(), to: z.string(), phone_number_id: z.string().optional() })
  .strict()

const QualitySchema = z
  .object({
    phone_number_id: z.string().optional(),
    quality_rating: z.enum(['RED', 'YELLOW', 'GREEN', 'UNKNOWN']),
  })
  .strict()

// Meta changing a number's status.
const PhoneStatusSchema = z.object({ phone_number_id: z.string().min(1).optional(), status: z.enum(CONNECTION_STATUSES) }).strict()

// Meta upgrading a number to higher throughput.
const ThroughputUpgradeSchema = z.object({ phone_number_id: z.string().min(1).optional() }).strict()

// Meta deeming a portfolio eligible for authentication-international rates.
// Times are unix seconds, as Meta's webhooks and fields carry them.
const AuthInternationalSchema = z
  .object({
    business_id: z.string().min(1).optional(),
    start_time: integer().optional(),
    exception_countries: z
      .array(z.object({ country_code: z.string().regex(/^[A-Z]{2}$/), start_time: integer() }).strict())
      .optional(),
    primary_business_location: z.string().regex(/^[A-Z]{2}$/).optional(),
  })
  .strict()

const TierSchema = z
  .object({ phone_number_id: z.string().optional(), tier: z.enum(MESSAGING_TIERS) })
  .strict()

const StatusSchema = z
  .object({
    id: z.string(),
    status: z.enum(MESSAGE_STATUSES),
    error: integer().optional(),
  })
  .strict()

/**
 * `.strict()` on purpose: silently ignoring a mistyped knob is worse than
 * rejecting it, because the scenario then looks configured and does nothing.
 */
const ScenarioSchema = z
  .object({
    seed: integer().optional(),
    latencyMs: z
      .union([z.number().nonnegative(), z.object({ min: z.number(), max: z.number() }).strict()])
      .optional(),
    sendFailureRate: z.number().optional(),
    webhookFailureRate: z.number().optional(),
    duplicateWebhooks: z.boolean().optional(),
    outOfOrderStatuses: z.boolean().optional(),
    nextError: z
      .object({ code: integer(), times: integer().positive().optional() })
      .strict()
      .optional(),
  })
  .strict()

/**
 * Turn the control API's friendly shorthand (`{from, text}`) into the message
 * body Meta would deliver. Keeping the shorthand is deliberate: the quickstart
 * in the README has to fit in one curl.
 */
function toInboundContent(input: z.infer<typeof InboundSchema>): InboundContent {
  const content = messageContent(input)
  return input.referral !== undefined ? { ...content, referral: input.referral } : content
}

function messageContent(input: z.infer<typeof InboundSchema>): InboundContent {
  for (const type of ['image', 'video', 'document', 'audio', 'sticker'] as const) {
    const media = input[type]
    if (media) {
      const { data, ...fields } = media
      return { type, [type]: { ...fields, ...(data !== undefined ? { bytes: Buffer.from(data, 'base64') } : {}) } }
    }
  }
  if (input.location) return { type: 'location', location: input.location }
  if (input.contacts) return { type: 'contacts', contacts: input.contacts }
  if (input.reaction) return { type: 'reaction', reaction: input.reaction }
  if (input.button) return { type: 'button', button: input.button }
  if (input.unsupported) return { type: 'unsupported', unsupported: input.unsupported }
  if (input.edit) return { type: 'edit', edit: input.edit }
  if (input.revoke) return { type: 'revoke', revoke: input.revoke }
  if (input.button_reply) {
    return {
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: input.button_reply },
    }
  }
  if (input.list_reply) {
    return {
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: input.list_reply },
    }
  }
  if (typeof input.text === 'string') {
    return { type: 'text', text: { body: input.text } }
  }
  throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
    details:
      'Provide one of `text`, `image`, `video`, `document`, `audio`, `sticker`, `location`, `contacts`, `reaction`, `button`, `button_reply`, `list_reply`, `unsupported`, `edit` or `revoke`',
  })
}

/**
 * Render a validation failure so it names what to fix. Root-level issues (an
 * unrecognized key) carry no path, so prefixing them with ": " reads as a
 * missing field name — the caller has enough to work out already.
 *
 * The wording is wamock's, built from each issue's kind and the value that was
 * sent, never the validation library's own message. It used to be zod's text
 * passed through, so moving from zod 3 to zod 4 rewrote nearly every message
 * ("Required" became "Invalid input: expected string, received undefined")
 * with the whole suite still green: a dependency was deciding what this API
 * says. `test/control-validation-wording.test.ts` pins every shape these
 * schemas can fail with, worded exactly as 0.3.1 shipped them.
 */
function describeIssues(error: z.ZodError, input: unknown): string {
  return error.issues
    .map((issue) => {
      const text = describeIssue(issue, valueAt(input, issue.path))
      return issue.path.length > 0 ? `${issue.path.map(String).join('.')}: ${text}` : text
    })
    .join('; ')
}

function describeIssue(issue: z.core.$ZodIssue, received: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      if (received === undefined) return 'Required'
      // A JSON number that is still refused is one that overflowed to
      // ±Infinity. zod would say "expected number, received number".
      if (issue.expected === 'number' && typeof received === 'number') {
        return `Expected finite number, received ${String(received)}`
      }
      return `Expected ${issue.expected}, received ${kindOf(received)}`
    case 'custom':
      if (issue.params?.['wamock'] === 'integer') return 'Expected integer, received float'
      return issue.message
    case 'invalid_value': {
      const options = issue.values.map((option) => `'${String(option)}'`).join(' | ')
      if (received === undefined) return 'Required'
      if (typeof received === 'string') {
        return `Invalid enum value. Expected ${options}, received '${received}'`
      }
      return `Expected ${options}, received ${kindOf(received)}`
    }
    case 'too_small':
      if (issue.origin === 'string') {
        return `String must contain at least ${String(issue.minimum)} character(s)`
      }
      return `Number must be greater than${issue.inclusive === true ? ' or equal to' : ''} ${String(issue.minimum)}`
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${issue.keys.map((key) => `'${key}'`).join(', ')}`
    case 'invalid_union':
      return 'Invalid input'
    default:
      // No schema here produces any other kind today. One added later still
      // gets the library's message, which beats saying nothing.
      return issue.message
  }
}

/** The value an issue's path points at, or undefined if any step is missing. */
function valueAt(input: unknown, path: readonly PropertyKey[]): unknown {
  let current = input
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}

/** `typeof`, except that null and arrays get their own names. */
function kindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** A WABA as `/__mock/state` reports it: `subscribedApps` flattened to an array. */
interface WabaView {
  wabaId: string
  appId: string
  businessId: string
  subscribedApps: string[]
}

/** A number as `/__mock/state` reports it: never its override's verify token or its PIN. */
type PhoneNumberView = Omit<PhoneNumber, 'callbackOverride' | 'pin'>

export interface StateSnapshot {
  now: number
  businesses: Business[]
  phoneNumbers: PhoneNumberView[]
  wabas: WabaView[]
  outboundCount: number
  webhooksDelivered: number
  droppedOutbound: number
  droppedWebhookLog: number
}

/**
 * The body of `GET /__mock/state`, built here rather than inline in the route
 * so there is exactly one place where an internal shape can leak into JSON.
 *
 * That mattered once already: `Waba.subscribedApps` is a `Set`, and
 * `JSON.stringify(new Set(['a']))` is `{}` — so every WABA read as
 * unsubscribed, in the reports this endpoint exists to serve. The declared
 * return type keeps the next `Set`, `Map` or `Date` from getting this far, and
 * a round-trip test in test/server.test.ts backs it at runtime.
 */
export function buildStateSnapshot(engine: WamockEngine): StateSnapshot {
  return {
    now: engine.clock.now(),
    // Deliberately no app secrets: this endpoint is meant to be curl-ed and
    // pasted into bug reports.
    businesses: engine.state.businesses(),
    phoneNumbers: engine.state.phoneNumbers().map(({ callbackOverride: _override, pin: _pin, ...view }) => view),
    wabas: engine.state.wabas().map((waba) => ({
      wabaId: waba.wabaId,
      appId: waba.appId,
      businessId: waba.businessId,
      subscribedApps: [...waba.subscribedApps],
    })),
    outboundCount: engine.state.outbound().length,
    webhooksDelivered: engine.deliverer.log().length,
    // Reported so a truncated history never looks like a complete one.
    droppedOutbound: engine.state.droppedOutbound(),
    droppedWebhookLog: engine.deliverer.droppedLogEntries(),
  }
}

export function registerControlRoutes(app: FastifyInstance, engine: WamockEngine): void {
  app.post('/__mock/inbound', async (request, reply) => {
    const parsed = InboundSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body),
      })
    }

    const result = engine.simulateInbound({
      from: parsed.data.from,
      ...(parsed.data.phone_number_id !== undefined
        ? { phoneNumberId: parsed.data.phone_number_id }
        : {}),
      ...(parsed.data.name !== undefined ? { contactName: parsed.data.name } : {}),
      ...(parsed.data.username !== undefined ? { username: parsed.data.username } : {}),
      ...(parsed.data.context_id !== undefined ? { contextId: parsed.data.context_id } : {}),
      message: toInboundContent(parsed.data),
    })

    return reply.send({ success: true, message_id: result.messageId })
  })

  app.post('/__mock/time/advance', async (request, reply) => {
    const parsed = AdvanceSchema.safeParse(request.body)
    if (!parsed.success || parsed.data.ms < 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param ms must be a non-negative integer number of milliseconds',
      })
    }
    if (engine.clock.now() + parsed.data.ms > LAST_INSTANT_MS) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param ms would move the clock past the last instant a date can hold',
      })
    }
    engine.clock.advance(parsed.data.ms)
    return reply.send({ now: engine.clock.now() })
  })

  /**
   * Play Meta's reviewer: approve, reject or pause a template on demand.
   * Scoped to a single language, because that is how Meta scopes it — and
   * pretending otherwise would hide the trap this mock exists to expose.
   */
  app.post<{ Params: { name: string; language: string }; Querystring: { waba_id?: string } }>(
    '/__mock/templates/:name/:language/transition',
    async (request, reply) => {
      const parsed = TransitionSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: `Param to must be one of {${TEMPLATE_STATUSES.join(', ')}}`,
        })
      }
      const wabaId = request.query.waba_id ?? engine.state.defaultWabaId
      return reply.send(
        engine.transitionTemplate(
          wabaId,
          request.params.name,
          request.params.language,
          parsed.data.to,
        ),
      )
    },
  )

  /**
   * Play Meta's automated recategorization: a notice now and the change in 24
   * hours, or the change at once with `notice: false`.
   */
  app.post<{ Params: { name: string; language: string }; Querystring: { waba_id?: string } }>(
    '/__mock/templates/:name/:language/recategorize',
    async (request, reply) => {
      const parsed = RecategorizeSchema.safeParse(request.body)
      if (!parsed.success) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: describeIssues(parsed.error, request.body),
        })
      }
      return reply.send(
        engine.recategorizeTemplate(
          request.query.waba_id ?? engine.state.defaultWabaId,
          request.params.name,
          request.params.language,
          {
            to: parsed.data.to,
            ...(parsed.data.notice !== undefined ? { notice: parsed.data.notice } : {}),
          },
        ),
      )
    },
  )

  /** Drive a message to a status Meta would not produce on its own (spec §6.2). */
  app.post('/__mock/statuses', async (request, reply) => {
    const parsed = StatusSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body),
      })
    }
    return reply.send(engine.forceStatus(parsed.data.id, parsed.data.status, parsed.data.error))
  })

  /** Global behaviour knobs: latency, failure rates, duplication, ordering (spec §6.5). */
  app.post('/__mock/scenario', async (request, reply) => {
    const parsed = ScenarioSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body),
      })
    }
    // Drop keys the caller omitted: under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and passing one
    // through would clobber the current value with nothing.
    const update = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    )
    // The controller reports a value out of range as a RangeError: the
    // caller's mistake, so a 100, not the 500 a fault in the mock gets.
    try {
      engine.scenario.configure(update)
    } catch (error) {
      if (error instanceof RangeError) throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: error.message })
      throw error
    }
    return reply.send({ success: true, scenario: engine.scenario.config })
  })

  // --- tech provider controls (spec §9) ------------------------------------

  /**
   * Mint an Embedded Signup code plus the fields the real signup event carries
   * beside it. `subscribed: false` creates the tenant WITHOUT subscribing your
   * app — the state where inbound messages vanish with no error at all.
   */
  app.post('/__mock/embedded-signup', async (request, reply) => {
    const parsed = SignupSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body ?? {}),
      })
    }
    const { data } = parsed
    return reply.send(
      engine.createSignup({
        ...(data.subscribed !== undefined ? { subscribed: data.subscribed } : {}),
        ...(data.business_id !== undefined ? { businessId: data.business_id } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.registered !== undefined ? { registered: data.registered } : {}),
        ...(data.coexistence !== undefined ? { coexistence: data.coexistence } : {}),
        ...(data.share_history !== undefined ? { shareHistory: data.share_history } : {}),
        ...(data.contacts !== undefined
          ? {
              contacts: data.contacts.map((contact) => ({
                phone: contact.phone,
                ...(contact.full_name !== undefined ? { full_name: contact.full_name } : {}),
                ...(contact.first_name !== undefined ? { first_name: contact.first_name } : {}),
              })),
            }
          : {}),
        ...(data.history !== undefined ? { history: data.history } : {}),
      }),
    )
  })

  /** The business sends a message from the WhatsApp Business app: an echo, nothing billed. */
  app.post('/__mock/app/send', async (request, reply) => {
    const parsed = AppSendSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body) })
    }
    return reply.send(
      engine.businessAppSend({ phoneNumberId: parsed.data.phone_number_id, to: parsed.data.to, text: parsed.data.text }),
    )
  })

  /** The business adds, edits or removes a contact in the app: `smb_app_state_sync`. */
  app.post('/__mock/app/contacts', async (request, reply) => {
    const parsed = AppContactChangeSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body) })
    }
    const { data } = parsed
    return reply.send(
      engine.businessAppContact({
        phoneNumberId: data.phone_number_id,
        phone: data.phone,
        ...(data.full_name !== undefined ? { full_name: data.full_name } : {}),
        ...(data.first_name !== undefined ? { first_name: data.first_name } : {}),
        ...(data.action !== undefined ? { action: data.action } : {}),
      }),
    )
  })

  /** The business changes device: offboarded, then reconnected unless `reconnect: false`. */
  app.post('/__mock/app/offboard', async (request, reply) => {
    const parsed = AppOffboardSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body) })
    }
    return reply.send(
      engine.businessAppOffboard({
        phoneNumberId: parsed.data.phone_number_id,
        ...(parsed.data.reconnect !== undefined ? { reconnect: parsed.data.reconnect } : {}),
      }),
    )
  })

  /** Mint a token of a chosen kind, to exercise expiry and missing scopes. */
  app.post('/__mock/tokens', async (request, reply) => {
    const parsed = TokenSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'kind must be one of {permanent, short, long}',
      })
    }
    return reply.send(
      engine.issueToken({
        ...(parsed.data.kind !== undefined ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.scopes !== undefined ? { scopes: parsed.data.scopes } : {}),
      }),
    )
  })

  /** A user stops or resumes marketing messages, announced as `user_preferences`. */
  app.post('/__mock/users/preferences', async (request, reply) => {
    const parsed = PreferenceSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body),
      })
    }
    return reply.send(
      engine.setUserPreference({
        from: parsed.data.from,
        value: parsed.data.value,
        ...(parsed.data.phone_number_id !== undefined
          ? { phoneNumberId: parsed.data.phone_number_id }
          : {}),
      }),
    )
  })

  /** A user changes their phone number: a new BSUID, announced as a system message. */
  app.post('/__mock/users/change-number', async (request, reply) => {
    const parsed = NumberChangeSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error, request.body),
      })
    }
    return reply.send(
      engine.changeUserNumber({
        from: parsed.data.from,
        to: parsed.data.to,
        ...(parsed.data.phone_number_id !== undefined
          ? { phoneNumberId: parsed.data.phone_number_id }
          : {}),
      }),
    )
  })

  app.post('/__mock/quality', async (request, reply) => {
    const parsed = QualitySchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'quality_rating must be one of {RED, YELLOW, GREEN, UNKNOWN}',
      })
    }
    return reply.send(
      engine.setQuality(
        parsed.data.phone_number_id ?? engine.state.defaultPhoneNumberId,
        parsed.data.quality_rating,
      ),
    )
  })

  app.post('/__mock/phone-status', async (request, reply) => {
    const parsed = PhoneStatusSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body ?? {}) })
    }
    return reply.send(engine.setPhoneStatus(parsed.data.phone_number_id ?? engine.state.defaultPhoneNumberId, parsed.data.status))
  })

  app.post('/__mock/tier', async (request, reply) => {
    const parsed = TierSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `tier must be one of {${MESSAGING_TIERS.join(', ')}}`,
      })
    }
    return reply.send(
      engine.setTier(
        parsed.data.phone_number_id ?? engine.state.defaultPhoneNumberId,
        parsed.data.tier,
      ),
    )
  })

  app.get('/__mock/messages', async (_request, reply) =>
    reply.send({ messages: engine.state.outbound() }),
  )

  app.get('/__mock/state', async (_request, reply) => reply.send(buildStateSnapshot(engine)))

  app.post('/__mock/throughput-upgrade', async (request, reply) => {
    const parsed = ThroughputUpgradeSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body ?? {}) })
    }
    return reply.send(engine.upgradeThroughput(parsed.data.phone_number_id ?? engine.state.defaultPhoneNumberId))
  })

  app.post('/__mock/auth-international', async (request, reply) => {
    const parsed = AuthInternationalSchema.safeParse(request.body ?? {})
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: describeIssues(parsed.error, request.body ?? {}) })
    }
    const { data } = parsed
    return reply.send(
      engine.setAuthInternational(data.business_id ?? engine.state.defaultBusinessId, {
        ...(data.start_time !== undefined ? { startTime: data.start_time * 1000 } : {}),
        ...(data.exception_countries !== undefined
          ? { exceptions: data.exception_countries.map((e) => ({ country: e.country_code, startTime: e.start_time * 1000 })) }
          : {}),
        ...(data.primary_business_location !== undefined ? { primaryLocation: data.primary_business_location } : {}),
      }),
    )
  })

  // The code `request_code` last "sent" to a number, as its SMS would read.
  app.get<{ Querystring: { phone_number_id?: string } }>('/__mock/verification-code', async (request, reply) => {
    const phoneNumberId = request.query.phone_number_id
    const code = phoneNumberId === undefined ? undefined : engine.verificationCode(phoneNumberId)
    if (code === undefined) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: phoneNumberId === undefined ? 'phone_number_id is required' : `No verification code was requested for ${phoneNumberId}`,
      })
    }
    return reply.send({ code })
  })

  app.post('/__mock/reset', async (_request, reply) => {
    engine.reset()
    return reply.send({ success: true })
  })
}
