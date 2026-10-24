import { DEFAULT_SETTLE_TIMEOUT_MS, WamockEngine } from './core/engine.js'
import type { ScenarioConfig } from './core/scenario.js'
import type { TemplateCategory, TemplateStatus } from './core/templates.js'
import type { OutboundMessage, ReadReceipt } from './core/types.js'
import { installGraphInterceptor } from './intercept.js'
import { createServer } from './server.js'
import type { InboundContent, MessageStatus } from './webhooks/payloads.js'
import { httpTransport, inProcessTransport } from './webhooks/transport.js'
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
  /**
   * Run Meta's verification handshake against `webhookUrl` with this token
   * before delivering, and deliver nothing until it passes, as Meta does.
   * Without it the URL is trusted as already verified.
   */
  verifyToken?: string
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

/** Media a customer sends, as the inbound helper takes it. */
export interface InboundMedia {
  caption?: string
  filename?: string
  mime_type?: string
  /** An audio message recorded as a voice note. */
  voice?: boolean
  /** A sticker that moves. */
  animated?: boolean
  bytes?: Buffer
}

/** Shorthand for the inbound the control API accepts. */
export interface InboundOptions {
  from: string
  name?: string
  text?: string
  buttonReply?: { id: string; title: string }
  listReply?: { id: string; title: string; description?: string }
  /**
   * The user's username. It sticks to the user, and hides their phone number
   * from webhooks unless your number was in contact with it in the last 30
   * days. `null` removes it.
   */
  username?: string | null
  /** Media the customer sends. `bytes` is the file; without it a placeholder is stored. */
  image?: InboundMedia
  video?: InboundMedia
  document?: InboundMedia
  audio?: InboundMedia
  sticker?: InboundMedia
  location?: { latitude: number; longitude: number; name?: string; address?: string; url?: string }
  contacts?: Array<Record<string, unknown>>
  /** Leave `emoji` out for a removed reaction, as Meta's webhook does. */
  reaction?: { message_id: string; emoji?: string }
  /** A message type Meta does not support, delivered with error 131051. */
  unsupported?: { type: string }
  /** A tap on a template's quick-reply button. */
  button?: { payload: string; text: string }
  /**
   * A Coexistence customer edits a message they sent within 15 minutes: a
   * text gets `text`, an image, video or document a new `caption`.
   */
  edit?: { message_id: string; text?: string; caption?: string }
  /** A Coexistence customer deletes a message they sent, within two days. */
  revoke?: { message_id: string }
  /** The wamid the customer replies to: delivered as `context: {from, id}`. */
  contextId?: string
  /**
   * The Click-to-WhatsApp ad the user came from, as Meta's `referral` object.
   * Replying inside the service window opens a 7-day free entry point window.
   */
  referral?: Record<string, unknown>
  phoneNumberId?: string
}

/**
 * Address a send by phone number (`to`), by business-scoped user ID
 * (`recipient`), or both, in which case `to` wins, as at Meta.
 */
export type SendOptions = {
  text?: string
  template?: { name: string; language: string; components?: unknown[] }
  interactive?: Record<string, unknown>
  phoneNumberId?: string
} & ({ to: string; recipient?: string } | { to?: undefined; recipient: string })

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
  /**
   * A user changes their phone number. Their BSUID changes with it, and your
   * number receives a `system` message saying so.
   */
  changeUserNumber(options: { from: string; to: string; phoneNumberId?: string }): Promise<void>
  /**
   * A user stops or resumes marketing messages. A marketing template sent to
   * them after a stop is accepted, then fails on its status with 131050.
   */
  setUserPreference(options: {
    from: string
    value: 'stop' | 'resume'
    phoneNumberId?: string
  }): Promise<void>
  /**
   * Move a sent message to a status Meta does not reach on its own in a
   * test: `read`, `played` (a voice message only), or `failed` with `error`.
   */
  status(options: { id: string; status: MessageStatus; error?: number }): Promise<void>

  time: {
    advance(ms: number): Promise<void>
    now(): number
  }

  /**
   * Create a template already APPROVED — the common test setup, in one call.
   * `components` is the template as you would submit it to Meta. A send must
   * then supply exactly the parameters its `{{…}}` placeholders call for, or it
   * fails with 132000, as at Meta; without components it takes none.
   */
  approveTemplate(options: {
    name: string
    language: string
    category?: TemplateCategory
    components?: unknown[]
  }): Promise<void>
  transitionTemplate(options: {
    name: string
    language: string
    to: TemplateStatus
  }): Promise<void>

  /**
   * Play Meta's automated recategorization: a `template_category_update`
   * notice now and the change 24 virtual hours later, or at once with
   * `notice: false`. The template stays APPROVED; only its billing changes.
   */
  recategorizeTemplate(options: {
    name: string
    language: string
    to: TemplateCategory
    notice?: boolean
  }): Promise<void>

  /**
   * The WhatsApp Business app side of a coexistence number (one onboarded with
   * `engine.createSignup({ coexistence: true })`). What happens here reaches
   * your app only as webhooks.
   */
  businessApp: {
    /** The business replies from the app: `smb_message_echoes`, no window, no bill. */
    send(options: { phoneNumberId: string; to: string; text: string }): Promise<void>
    /** The business adds, edits or removes a contact: `smb_app_state_sync`. */
    contact(options: {
      phoneNumberId: string
      phone: string
      full_name?: string
      first_name?: string
      action?: 'add' | 'remove'
    }): Promise<void>
    /** The business changes device: offboarded, then reconnected unless `reconnect: false`. */
    offboard(options: { phoneNumberId: string; reconnect?: boolean }): Promise<void>
  }

  messages(): OutboundMessage[]
  /**
   * Every successful mark-as-read call, with whether it asked for a typing
   * indicator. Kept apart from `messages()`: reading a message sends nothing.
   */
  readReceipts(): ReadReceipt[]
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

  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS

  // The same budget for both doors: an app pointed at `baseUrl` must not get a
  // different answer than one calling the helpers.
  const app = createServer(engine, { settleTimeoutMs })
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

  /**
   * Advance by zero and settle. Every helper does this so callers never have
   * to think about the gap between "the timer fired" and "the webhook was
   * handed over" — the classic source of a passing-then-failing assertion.
   *
   * It lives on the engine so the HTTP control API can do exactly the same
   * thing; two implementations would be two behaviours (#4).
   */
  const flush = (): Promise<void> => engine.flush(settleTimeoutMs)

  return {
    baseUrl,
    phoneNumberId: engine.state.defaultPhoneNumberId,
    wabaId: engine.state.defaultWabaId,
    engine,

    async inbound(inboundOptions) {
      const result = engine.simulateInbound({
        from: inboundOptions.from,
        ...(inboundOptions.name !== undefined ? { contactName: inboundOptions.name } : {}),
        ...(inboundOptions.username !== undefined ? { username: inboundOptions.username } : {}),
        ...(inboundOptions.contextId !== undefined ? { contextId: inboundOptions.contextId } : {}),
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

    async changeUserNumber(options) {
      engine.changeUserNumber(options)
      await flush()
    },

    async status({ id, status, error }) {
      engine.forceStatus(id, status, error)
      await flush()
    },

    async setUserPreference(options) {
      engine.setUserPreference(options)
      await flush()
    },

    time: {
      async advance(ms) {
        await engine.advanceAndSettle(ms, settleTimeoutMs)
      },
      now: () => engine.clock.now(),
    },

    async approveTemplate({ name, language, category = 'UTILITY', components = [] }) {
      engine.createTemplate(engine.state.defaultWabaId, {
        name,
        language,
        category,
        components,
      })
      engine.transitionTemplate(engine.state.defaultWabaId, name, language, 'APPROVED')
      await flush()
    },

    async transitionTemplate({ name, language, to }) {
      engine.transitionTemplate(engine.state.defaultWabaId, name, language, to)
      await flush()
    },

    async recategorizeTemplate({ name, language, to, notice }) {
      engine.recategorizeTemplate(engine.state.defaultWabaId, name, language, {
        to,
        ...(notice !== undefined ? { notice } : {}),
      })
      await flush()
    },

    businessApp: {
      async send(options) {
        engine.businessAppSend(options)
        await flush()
      },
      async contact(options) {
        engine.businessAppContact(options)
        await flush()
      },
      async offboard(options) {
        engine.businessAppOffboard(options)
        await flush()
      },
    },

    messages: () => engine.state.outbound(),
    readReceipts: () => engine.state.readReceipts(),

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
      await engine.settleWithin(settleTimeoutMs)
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
      await engine.settleWithin(settleTimeoutMs)

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
  const { onWebhook, webhookUrl, verifyToken } = options
  // The server's transport, so both doors deliver alike: same bytes, same
  // headers, only a 200 counts, and a verify token gates on the handshake.
  const http = webhookUrl
    ? httpTransport(webhookUrl, verifyToken !== undefined ? { verifyToken } : {})
    : undefined
  // `attempt` goes through to HTTP, which checks it right before its POST:
  // `onWebhook` may have awaited while the WABA unsubscribed or reset ran.
  const transport = inProcessTransport(async (delivery, attempt) => {
    if (attempt?.rerouted !== true) await onWebhook?.(delivery)
    await http?.(delivery, attempt)
  })
  return http
    ? Object.assign(transport, { verifyCallback: http.verifyCallback, reset: http.reset, callbackUrl: http.callbackUrl })
    : transport
}

function addressOf(app: FastifyInstance): string {
  const address = app.server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('wamock could not determine its own listening address')
  }
  return `http://127.0.0.1:${address.port}`
}

function toInboundContent(options: InboundOptions): InboundContent {
  const content = messageContent(options)
  return options.referral !== undefined ? { ...content, referral: options.referral } : content
}

function messageContent(options: InboundOptions): InboundContent {
  for (const type of ['image', 'video', 'document', 'audio', 'sticker'] as const) {
    const media = options[type]
    if (media) return { type, [type]: { ...media } }
  }
  if (options.location) return { type: 'location', location: options.location }
  if (options.contacts) return { type: 'contacts', contacts: options.contacts }
  if (options.reaction) return { type: 'reaction', reaction: options.reaction }
  if (options.unsupported) return { type: 'unsupported', unsupported: options.unsupported }
  if (options.button) return { type: 'button', button: options.button }
  if (options.edit) return { type: 'edit', edit: { ...options.edit } }
  if (options.revoke) return { type: 'revoke', revoke: { ...options.revoke } }
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
  const address = {
    ...(options.to !== undefined ? { to: options.to } : {}),
    ...(options.recipient !== undefined ? { recipient: options.recipient } : {}),
  }
  if (options.template) {
    return {
      messaging_product: 'whatsapp',
      ...address,
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
      ...address,
      type: 'interactive',
      interactive: options.interactive,
    }
  }
  return {
    messaging_product: 'whatsapp',
    ...address,
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
export type { SignBodyInput, VerifySignatureInput } from './webhooks/signature.js'
export { verifyWebhookUrl } from './webhooks/handshake.js'
export { DeliveryCancelled } from './webhooks/transport.js'
export type { DeliveryAttempt, WebhookDelivery, WebhookTransport } from './webhooks/transport.js'
export type { OutboundMessage, ReadReceipt } from './core/types.js'
export type { MessageStatus } from './webhooks/payloads.js'
