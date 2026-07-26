import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { WamockEngine } from '../core/engine.js'
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
  .passthrough()

const AdvanceSchema = z.object({ ms: z.number().int() })

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

export function registerControlRoutes(app: FastifyInstance, engine: WamockEngine): void {
  app.post('/__mock/inbound', async (request, reply) => {
    const parsed = InboundSchema.safeParse(request.body)
    if (!parsed.success) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
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
    }),
  )

  app.post('/__mock/reset', async (_request, reply) => {
    engine.reset()
    return reply.send({ success: true })
  })
}
