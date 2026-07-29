import { WamockEngine } from './core/engine.js'
import type { ScenarioConfig } from './core/scenario.js'
import type { TemplateCategory, TemplateStatus } from './core/templates.js'
import type { OutboundMessage } from './core/types.js'
import { installGraphInterceptor } from './intercept.js'
import { createServer } from './server.js'
import type { InboundContent } from './webhooks/payloads.js'
import { inProcessTransport } from './webhooks/transport.js'
import type { WebhookDelivery } from './webhooks/transport.js'
import type { FastifyInstance } from 'fastify'

/**
 * Library mode (spec §8).
 *
 * The whole inbound → reply → status → expiry cycle, inside a test, with no
 * network and no waiting. Two things make that work:
 *
 * - **Webhooks go straight to a callback.** No listener, no port, no flake.
 * - **Time is virtual.** `advance(hours(25))` expires the service window
 *   instantly and fires everything that came due.
 *
 * A real HTTP server still runs on an ephemeral port, so the same test can also
 * point an app that only speaks URLs at `mock.baseUrl`.
 */

export interface CreateWamockOptions {
  /** Signs outgoing webhooks. The app under test verifies against this. */
  appSecret: string
  /** Called with every webhook. This is what replaces a listening server. */
  onWebhook?: (delivery: WebhookDelivery) => void | Promise<void>
  /** Also POST webhooks to this URL, for an app that cannot take a callback. */
  webhookUrl?: string
  /** Starting virtual time. Defaults to now; pin it for byte-identical runs. */
  start?: number
  /** Shorten the 24h window to make expiry tests cheap. */
  windowMs?: number
  /**
   * Redirect `graph.facebook.com` to this mock for the mock's lifetime, and
   * restore the global `fetch` on `close()`.
   *
   * Most Graph clients hardcode the hostname — we checked two production
   * integrations and neither had a base-URL setting — so this is usually what
   * you want when the code under test is not configurable.
   */
  interceptGraph?: boolean
  /**
   * How long any helper waits for in-flight deliveries before giving up.
   * Defaults to 5s.
   *
   * Every helper — `inbound`, `send`, `time.advance`, `close` — waits for the
   * webhooks it triggered, and that wait is on YOUR receiver. A receiver that
   * never resolves would otherwise freeze the first call, not just teardown.
   */
  settleTimeoutMs?: number
  phoneNumberId?: string
  wabaId?: string
  displayPhoneNumber?: string
}

/** Shorthand for the inbound the control API accepts. */
export interface InboundOptions {
  from: string
  name?: string
  text?: string
  buttonReply?: { id: string; title: string }
  listReply?: { id: string; title: string; description?: string }
  phoneNumberId?: string
}

export interface SendOptions {
  to: string
  text?: string
  template?: { name: string; language: string; components?: unknown[] }
  interactive?: Record<string, unknown>
  phoneNumberId?: string
}

export interface ExpectSentCriteria {
  type?: string
  to?: string
  text?: string
  name?: string
  language?: string
}

export interface Wamock {
  /** Point an app's Graph base URL here. */
  baseUrl: string
  phoneNumberId: string
  wabaId: string
  /** The engine, for anything the helpers do not cover. */
  engine: WamockEngine

  inbound(options: InboundOptions): Promise<{ messageId: string }>
  send(options: SendOptions): Promise<{ id: string }>

  time: {
    advance(ms: number): Promise<void>
    now(): number
  }

  /** Create a template already APPROVED — the common test setup, in one call. */
  approveTemplate(options: {
    name: string
    language: string
    category?: TemplateCategory
  }): Promise<void>
  transitionTemplate(options: {
    name: string
    language: string
    to: TemplateStatus
  }): Promise<void>

  messages(): OutboundMessage[]
  expectSent(criteria: ExpectSentCriteria): OutboundMessage
  scenario(config: Partial<ScenarioConfig>): void

  reset(): Promise<void>
  close(): Promise<void>
}

export async function createWamock(options: CreateWamockOptions): Promise<Wamock> {
  const engine = new WamockEngine({
    appSecret: options.appSecret,
    // Frozen by default: a library-mode test that depends on wall time is a
    // test that fails on a slow CI runner.
    mode: 'frozen',
    ...(options.start !== undefined ? { start: options.start } : {}),
    ...(options.windowMs !== undefined ? { windowMs: options.windowMs } : {}),
    ...(options.phoneNumberId !== undefined ? { phoneNumberId: options.phoneNumberId } : {}),
    ...(options.wabaId !== undefined ? { wabaId: options.wabaId } : {}),
    ...(options.displayPhoneNumber !== undefined
      ? { displayPhoneNumber: options.displayPhoneNumber }
      : {}),
  })

  engine.deliverer.setTransport(buildTransport(options))

  const app = createServer(engine)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const baseUrl = addressOf(app)

  // Tying the interceptor to the mock's lifetime removes the footgun of a
  // forgotten restore(), which leaves the global fetch patched for every test
  // that follows.
  let intercepted = 0
  const restoreInterceptor = options.interceptGraph
    ? installGraphInterceptor({
        baseUrl,
        onIntercept: () => {
          intercepted += 1
        },
      })
    : undefined

  let closed = false

  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS

  /**
   * Advance by zero and settle. Every helper does this so callers never have
   * to think about the gap between "the timer fired" and "the webhook was
   * handed over" — the classic source of a passing-then-failing assertion.
   *
   * Bounded, because settling waits on the caller's own receiver. A hang there
   * leaves nothing to read; a late delivery is at least diagnosable.
   */
  let flushing = false
  const flush = async (): Promise<void> => {
    // A nested flush defers to the one already running. Handlers reply by
    // calling send(), which flushes again from inside the drain it is part of;
    // with duplicate deliveries, two handlers each wait for the drain the
    // other is holding. The outer flush sees their work anyway, so waiting
    // here only burned the settle timeout.
    if (flushing) return
    flushing = true
    try {
      engine.clock.advance(0)
      await settleWithin(engine, settleTimeoutMs)
    } finally {
      flushing = false
    }
  }

  return {
    baseUrl,
    phoneNumberId: engine.state.defaultPhoneNumberId,
    wabaId: engine.state.defaultWabaId,
    engine,

    async inbound(inboundOptions) {
      const result = engine.simulateInbound({
        from: inboundOptions.from,
        ...(inboundOptions.name !== undefined ? { contactName: inboundOptions.name } : {}),
        ...(inboundOptions.phoneNumberId !== undefined
          ? { phoneNumberId: inboundOptions.phoneNumberId }
          : {}),
        message: toInboundContent(inboundOptions),
      })
      await flush()
      return result
    },

    async send(sendOptions) {
      const response = engine.sendMessage(
        sendOptions.phoneNumberId ?? engine.state.defaultPhoneNumberId,
        toSendBody(sendOptions),
      )
      await flush()
      return { id: response.messages[0]!.id }
    },

    time: {
      async advance(ms) {
        engine.clock.advance(ms)
        await settleWithin(engine, settleTimeoutMs)
      },
      now: () => engine.clock.now(),
    },

    async approveTemplate({ name, language, category = 'UTILITY' }) {
      engine.createTemplate(engine.state.defaultWabaId, {
        name,
        language,
        category,
        components: [],
      })
      engine.transitionTemplate(engine.state.defaultWabaId, name, language, 'APPROVED')
      await flush()
    },

    async transitionTemplate({ name, language, to }) {
      engine.transitionTemplate(engine.state.defaultWabaId, name, language, to)
      await flush()
    },

    messages: () => engine.state.outbound(),

    expectSent(criteria) {
      const sent = engine.state.outbound()
      const match = sent.find((message) => matches(message, criteria))
      if (!match) {
        // Listing the actual traffic turns a bare assertion failure into a
        // diagnosis. This is the single most useful thing a mock can print.
        throw new Error(
          `expectSent found no message matching ${JSON.stringify(criteria)}.\n` +
            (sent.length === 0
              ? 'Nothing was sent.'
              : `Sent so far:\n${sent.map((m) => `  - ${describe(m)}`).join('\n')}`),
        )
      }
      return match
    },

    scenario(config) {
      engine.scenario.configure(config)
    },

    async reset() {
      engine.reset()
      // Bounded like every other wait: reset() between tests must not be the
      // place a stuck receiver freezes the run.
      await settleWithin(engine, settleTimeoutMs)
    },

    async close() {
      if (closed) return
      closed = true

      // Order matters. Cancel first so nothing new fires, THEN await what is
      // already in flight — the other way round lets a delivery start during
      // the wait and outlive the close. Without this, `afterEach(close)` does
      // not isolate: one test's webhooks land inside the next one, and the
      // flakiness looks like it belongs to the code under test.
      //
      // Bounded, because that wait is on USER code. An onWebhook that never
      // resolves — a lock, a pending request, a forgotten await — would
      // otherwise hang close() forever, and a hang leaves nothing to read. A
      // late delivery is recoverable; a wedged test run is not.
      engine.deliverer.clear()
      await settleWithin(engine, settleTimeoutMs)

      restoreInterceptor?.()

      // Interception that never fired almost always means the client under test
      // is holding a `fetch` it captured BEFORE the patch — the shape
      // `constructor(transport = globalThis.fetch)` produces, which is common
      // precisely because it keeps the transport injectable. Nothing here can
      // un-capture that reference, so the requests went to the real Meta: with a
      // valid token in the environment, that is real messages to real numbers.
      //
      // Silence is the dangerous outcome, so say it out loud. Only when
      // interception was explicitly asked for, which makes zero traffic
      // surprising rather than normal.
      if (options.interceptGraph === true && intercepted === 0) {
        console.warn(
          'wamock: interceptGraph was enabled but no Graph request was intercepted. ' +
            'If your client captured globalThis.fetch before createWamock() ran, it still ' +
            'holds the real one and its requests went to Meta. Construct the client after ' +
            'createWamock(), or point it at mock.baseUrl. ' +
            'If this test simply made no Graph calls, this warning is harmless — ' +
            'drop interceptGraph for that test to silence it.',
        )
      }

      engine.clock.stop()
      await app.close()
    },
  }
}

// --- internals ------------------------------------------------------------

function buildTransport(options: CreateWamockOptions) {
  const { onWebhook, webhookUrl } = options
  return inProcessTransport(async (delivery) => {
    await onWebhook?.(delivery)
    if (!webhookUrl) return
    // Same bytes, same signature — never re-serialize on the way out.
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': delivery.signature,
      },
      body: delivery.body,
    })
    if (!response.ok) throw new Error(`webhook receiver returned HTTP ${response.status}`)
  })
}

/**
 * Long enough that any reasonable receiver finishes, short enough that a stuck
 * one does not look like a frozen test suite.
 */
const DEFAULT_SETTLE_TIMEOUT_MS = 5_000

/**
 * Await in-flight deliveries, but never longer than `timeoutMs`.
 *
 * The timer is unref'd so this can never be the reason a process stays alive —
 * a teardown helper that holds the event loop open would be its own bug.
 */
async function settleWithin(engine: WamockEngine, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
    timer.unref?.()
  })

  try {
    await Promise.race([engine.settle(), expiry])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function addressOf(app: FastifyInstance): string {
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('wamock could not determine its own listening address')
  }
  return `http://127.0.0.1:${address.port}`
}

function toInboundContent(options: InboundOptions): InboundContent {
  if (options.buttonReply) {
    return {
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: options.buttonReply },
    }
  }
  if (options.listReply) {
    return {
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: options.listReply },
    }
  }
  return { type: 'text', text: { body: options.text ?? '' } }
}

function toSendBody(options: SendOptions): Record<string, unknown> {
  if (options.template) {
    return {
      messaging_product: 'whatsapp',
      to: options.to,
      type: 'template',
      template: {
        name: options.template.name,
        language: { code: options.template.language },
        components: options.template.components ?? [],
      },
    }
  }
  if (options.interactive) {
    return {
      messaging_product: 'whatsapp',
      to: options.to,
      type: 'interactive',
      interactive: options.interactive,
    }
  }
  return {
    messaging_product: 'whatsapp',
    to: options.to,
    type: 'text',
    text: { body: options.text ?? '' },
  }
}

function matches(message: OutboundMessage, criteria: ExpectSentCriteria): boolean {
  if (criteria.type !== undefined && message.type !== criteria.type) return false
  if (criteria.to !== undefined && message.to !== criteria.to.replace(/\D/g, '')) return false

  if (criteria.text !== undefined) {
    const body = (message.payload['text'] as { body?: string } | undefined)?.body
    if (body !== criteria.text) return false
  }

  const template = message.payload['template'] as
    | { name?: string; language?: { code?: string } }
    | undefined
  if (criteria.name !== undefined && template?.name !== criteria.name) return false
  if (criteria.language !== undefined && template?.language?.code !== criteria.language) return false

  return true
}

function describe(message: OutboundMessage): string {
  const template = message.payload['template'] as
    | { name?: string; language?: { code?: string } }
    | undefined
  const detail =
    message.type === 'template'
      ? `${template?.name} (${template?.language?.code})`
      : JSON.stringify((message.payload['text'] as { body?: string } | undefined)?.body ?? message.payload)
  return `${message.type} to ${message.to}: ${detail}`
}

export { WamockEngine } from './core/engine.js'
export { createServer } from './server.js'
export { GraphError, ERROR_CODES, isRetriable } from './errors/graph-error.js'
export { signBody, verifySignature } from './webhooks/signature.js'
export { verifyWebhookUrl } from './webhooks/handshake.js'
export type { WebhookDelivery, WebhookTransport } from './webhooks/transport.js'
export type { OutboundMessage } from './core/types.js'
