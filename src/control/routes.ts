import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { WamockEngine } from '../core/engine.js'
import { TEMPLATE_STATUSES } from '../core/templates.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import type { InboundContent } from '../webhooks/payloads.js'

/**
 * The control API (`/__mock/*`) — everything Meta does not give you.
 *
 * Spec §6: this surface is as much the product as the emulation is. Being able
 * to say "the customer replied", "24 hours passed", "Meta paused that template"
 * is the reason to reach for a mock instead of reading documentation.
 */

const InboundSchema = z
  .object({
    from: z.string(),
    phone_number_id: z.string().optional(),
    name: z.string().optional(),
    type: z.string().optional(),
    text: z.string().optional(),
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
const AdvanceSchema = z.object({ ms: z.number().int() }).strict()

const TransitionSchema = z.object({ to: z.enum(TEMPLATE_STATUSES) }).strict()

const SignupSchema = z.object({ subscribed: z.boolean().optional() }).strict()

const TokenSchema = z
  .object({
    kind: z.enum(['permanent', 'short', 'long']).optional(),
    scopes: z.array(z.string()).optional(),
  })
  .strict()

const QualitySchema = z
  .object({
    phone_number_id: z.string().optional(),
    quality_rating: z.enum(['RED', 'YELLOW', 'GREEN']),
  })
  .strict()

export const MESSAGING_TIERS = [
  'TIER_1',
  'TIER_2',
  'TIER_250',
  'TIER_1K',
  'TIER_10K',
  'TIER_100K',
  'TIER_UNLIMITED',
] as const

const TierSchema = z
  .object({ phone_number_id: z.string().optional(), tier: z.enum(MESSAGING_TIERS) })
  .strict()

const StatusSchema = z
  .object({
    id: z.string(),
    status: z.enum(['sent', 'delivered', 'read', 'failed']),
    error: z.number().int().optional(),
  })
  .strict()

/**
 * `.strict()` on purpose: silently ignoring a mistyped knob is worse than
 * rejecting it, because the scenario then looks configured and does nothing.
 */
const ScenarioSchema = z
  .object({
    seed: z.number().int().optional(),
    latencyMs: z
      .union([z.number().nonnegative(), z.object({ min: z.number(), max: z.number() }).strict()])
      .optional(),
    sendFailureRate: z.number().optional(),
    webhookFailureRate: z.number().optional(),
    duplicateWebhooks: z.boolean().optional(),
    outOfOrderStatuses: z.boolean().optional(),
    nextError: z
      .object({ code: z.number().int(), times: z.number().int().positive().optional() })
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
    details: 'Provide `text`, `button_reply` or `list_reply` to describe the inbound message',
  })
}

/**
 * Render a validation failure so it names what to fix. Root-level issues (an
 * unrecognized key) carry no path, so prefixing them with ": " reads as a
 * missing field name — the caller has enough to work out already.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join('; ')
}

export function registerControlRoutes(app: FastifyInstance, engine: WamockEngine): void {
  app.post('/__mock/inbound', async (request, reply) => {
    const parsed = InboundSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error),
      })
    }

    const result = engine.simulateInbound({
      from: parsed.data.from,
      ...(parsed.data.phone_number_id !== undefined
        ? { phoneNumberId: parsed.data.phone_number_id }
        : {}),
      ...(parsed.data.name !== undefined ? { contactName: parsed.data.name } : {}),
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

  /** Drive a message to a status Meta would not produce on its own (spec §6.2). */
  app.post('/__mock/statuses', async (request, reply) => {
    const parsed = StatusSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error),
      })
    }
    return reply.send(engine.forceStatus(parsed.data.id, parsed.data.status, parsed.data.error))
  })

  /** Global behaviour knobs: latency, failure rates, duplication, ordering (spec §6.5). */
  app.post('/__mock/scenario', async (request, reply) => {
    const parsed = ScenarioSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: describeIssues(parsed.error),
      })
    }
    // Drop keys the caller omitted: under exactOptionalPropertyTypes an
    // explicit `undefined` is not the same as an absent key, and passing one
    // through would clobber the current value with nothing.
    const update = Object.fromEntries(
      Object.entries(parsed.data).filter(([, value]) => value !== undefined),
    )
    // Range violations surface from the controller as RangeError; the server's
    // error handler turns them into a Meta-shaped 100.
    engine.scenario.configure(update)
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
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Invalid signup options' })
    }
    return reply.send(
      engine.createSignup(
        parsed.data.subscribed !== undefined ? { subscribed: parsed.data.subscribed } : {},
      ),
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

  app.post('/__mock/quality', async (request, reply) => {
    const parsed = QualitySchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'quality_rating must be one of {RED, YELLOW, GREEN}',
      })
    }
    return reply.send(
      engine.setQuality(
        parsed.data.phone_number_id ?? engine.state.defaultPhoneNumberId,
        parsed.data.quality_rating,
      ),
    )
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

  app.get('/__mock/state', async (_request, reply) =>
    reply.send({
      now: engine.clock.now(),
      // Deliberately no app secrets: this endpoint is meant to be curl-ed and
      // pasted into bug reports.
      phoneNumbers: engine.state.phoneNumbers(),
      wabas: engine.state.wabas(),
      outboundCount: engine.state.outbound().length,
      webhooksDelivered: engine.deliverer.log().length,
      // Reported so a truncated history never looks like a complete one.
      droppedOutbound: engine.state.droppedOutbound(),
      droppedWebhookLog: engine.deliverer.droppedLogEntries(),
    }),
  )

  app.post('/__mock/reset', async (_request, reply) => {
    engine.reset()
    return reply.send({ success: true })
  })
}
