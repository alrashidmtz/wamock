import type { MockContext } from '../core/context.js'
import { requirePhoneNumber } from '../core/guards.js'
import { userIdentity } from '../core/identity.js'
import { makeWamid } from '../core/ids.js'
import { normalizeWaId } from '../core/phone.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import {
  buildAccountUpdatePayload,
  buildHistoryDeclinedPayload,
  buildHistoryPayload,
  buildMessageEchoPayload,
  buildStateSyncPayload,
} from '../webhooks/coexistence-payloads.js'
import type { AppContact, HistoryThread } from '../webhooks/coexistence-payloads.js'
import type { UserIdentity } from '../webhooks/payloads.js'

/**
 * Coexistence: a number onboarded from the WhatsApp Business app keeps working
 * in the app while Cloud API uses it too.
 *
 * The rules wamock reproduces, each from Meta's onboarding guide:
 *
 * - Contacts and chat history sync once each, and only within 24 hours of
 *   onboarding (2593107, 2593108). History arrives in phases by age, or as
 *   2593109 when the business declined to share it.
 * - What the business sends from the app reaches the integration only as
 *   `smb_message_echoes`, and opens, extends and costs nothing.
 * - Cloud API throughput is fixed at 20 messages per second.
 * - About 14 days without the primary device being used disconnects the
 *   number (`PARTNER_REMOVED`, `PRIMARY_INACTIVITY`). A device change offboards
 *   it until it reconnects (`ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`).
 *
 * Not emulated: media in history, group chats, companion devices, and the
 * register/deregister routes, which wamock does not have for any number.
 */

/** How long after onboarding contacts and history may still be requested. */
const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000
/** Primary-device inactivity after which Meta disconnects the number. */
const PRIMARY_INACTIVITY_MS = 14 * 24 * 60 * 60 * 1000
/** History older than this is never synced. */
const HISTORY_MS = 180 * 24 * 60 * 60 * 1000
/** Cloud API messages per second on a coexistence number. */
const THROUGHPUT_PER_SECOND = 20
/** How long automatic reonboarding takes after a device change, in wamock. */
const RECONNECT_MS = 5 * 60 * 1000

const DAY = 24 * 60 * 60 * 1000
/** Day boundaries of history phases 0, 1 and 2, counted back from onboarding. */
const PHASE_ENDS = [DAY, 90 * DAY, HISTORY_MS] as const

export type SyncType = 'smb_app_state_sync' | 'history'

/** What the Business app already holds when the number is onboarded. */
export interface CoexistenceSeed {
  /** Whether the business agreed to share its chat history. Default true. */
  shareHistory?: boolean
  contacts?: AppContact[]
  /** Chat history; `ago_ms` counts back from onboarding. */
  history?: Array<{
    phone: string
    messages: Array<{ direction: 'in' | 'out'; text: string; ago_ms: number }>
  }>
}

interface CoexistenceNumber {
  onboardedAt: number
  shareHistory: boolean
  contacts: AppContact[]
  history: NonNullable<CoexistenceSeed['history']>
  synced: Set<SyncType>
  /** Cloud API sends in the last second, for the 20 mps cap. */
  recentSends: number[]
  /** Why sending is not possible right now, if it is not. */
  blocked: 'offboarded' | 'removed' | undefined
  inactivityTimer: number | undefined
  reconnectTimer: number | undefined
}

export class CoexistenceService {
  readonly #context: MockContext
  readonly #numbers = new Map<string, CoexistenceNumber>()

  constructor(context: MockContext) {
    this.#context = context
  }

  /** Called by Embedded Signup for a Business app number. */
  onboard(phoneNumberId: string, seed: CoexistenceSeed = {}): void {
    const { clock } = this.#context
    requirePhoneNumber(this.#context, phoneNumberId)
    const entry: CoexistenceNumber = {
      onboardedAt: clock.now(),
      shareHistory: seed.shareHistory ?? true,
      contacts: (seed.contacts ?? []).map((contact) => ({ ...contact, phone: this.#waId(contact.phone) })),
      history: seed.history ?? [],
      synced: new Set(),
      recentSends: [],
      blocked: undefined,
      inactivityTimer: undefined,
      reconnectTimer: undefined,
    }
    this.#numbers.set(phoneNumberId, entry)
    this.#armInactivity(phoneNumberId, entry)
  }

  /** Whether `?fields=is_on_biz_app` is true: onboarded and not disconnected. */
  isOnBizApp(phoneNumberId: string): boolean {
    const entry = this.#numbers.get(phoneNumberId)
    return entry !== undefined && entry.blocked !== 'removed'
  }

  /**
   * Gate a Cloud API send. A disconnected or offboarded number fails with
   * 133010 (not registered on the platform); the 21st message inside a second
   * fails with 130429. Ordinary numbers pass untouched.
   */
  assertCanSend(phoneNumberId: string): void {
    const entry = this.#numbers.get(phoneNumberId)
    if (!entry) return
    if (entry.blocked) {
      throw new GraphError(ERROR_CODES.NOT_REGISTERED, {
        details:
          entry.blocked === 'removed'
            ? 'The business disconnected this number from Cloud API (PARTNER_REMOVED).'
            : 'The number is offboarded while it reconnects after a device change.',
      })
    }
    const now = this.#context.clock.now()
    entry.recentSends = entry.recentSends.filter((at) => now - at < 1000)
    if (entry.recentSends.length >= THROUGHPUT_PER_SECOND) {
      throw new GraphError(ERROR_CODES.RATE_LIMIT, {
        details: `Numbers shared with the WhatsApp Business app have a fixed throughput of ${THROUGHPUT_PER_SECOND} messages per second.`,
      })
    }
  }

  /** Count an accepted Cloud API send against the 20 mps cap. */
  recordSend(phoneNumberId: string): void {
    this.#numbers.get(phoneNumberId)?.recentSends.push(this.#context.clock.now())
  }

  /** `POST /{phone_number_id}/smb_app_data`. */
  sync(phoneNumberId: string, body: Record<string, unknown>): { messaging_product: 'whatsapp'; request_id: string } {
    const { clock, state } = this.#context
    const entry = this.#requireCoexistence(phoneNumberId)

    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: "Param messaging_product must be 'whatsapp'" })
    }
    const syncType = body['sync_type']
    if (syncType !== 'smb_app_state_sync' && syncType !== 'history') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: 'Param sync_type must be one of {smb_app_state_sync, history}',
      })
    }
    // Meta documents both refusals but not which wins when both apply; a
    // repeat is refused first, since it is wrong whenever it happens.
    if (entry.synced.has(syncType)) throw new GraphError(ERROR_CODES.SYNC_LIMIT_EXCEEDED)
    if (clock.now() - entry.onboardedAt >= SYNC_WINDOW_MS) throw new GraphError(ERROR_CODES.SYNC_WINDOW_CLOSED)
    entry.synced.add(syncType)

    if (syncType === 'smb_app_state_sync') this.#syncContacts(phoneNumberId, entry)
    else this.#syncHistory(phoneNumberId, entry)

    return { messaging_product: 'whatsapp', request_id: `REQ_${state.nextSeq()}` }
  }

  /** Control API: the business sends a message from the Business app. */
  appSend(options: { phoneNumberId: string; to: string; text: string }): { success: true } {
    const { clock, state, dispatcher } = this.#context
    const entry = this.#requireCoexistence(options.phoneNumberId)
    const phoneNumber = requirePhoneNumber(this.#context, options.phoneNumberId)
    const waId = this.#waId(options.to)

    // Using the app is primary-device activity: the 14-day clock restarts.
    this.#armInactivity(options.phoneNumberId, entry)
    dispatcher.dispatch(
      options.phoneNumberId,
      buildMessageEchoPayload({
        ...this.#numberContext(options.phoneNumberId),
        user: this.#user(options.phoneNumberId, waId),
        messageId: makeWamid(phoneNumber.phoneNumberId, state.nextSeq()),
        timestampMs: clock.now(),
        text: options.text,
      }),
    )
    return { success: true }
  }

  /** Control API: the business adds, edits or removes a contact in the app. */
  appContact(options: {
    phoneNumberId: string
    phone: string
    full_name?: string
    first_name?: string
    action?: 'add' | 'remove'
  }): { success: true } {
    const { clock, dispatcher } = this.#context
    const entry = this.#requireCoexistence(options.phoneNumberId)
    const contact: AppContact = {
      phone: this.#waId(options.phone),
      ...(options.full_name !== undefined ? { full_name: options.full_name } : {}),
      ...(options.first_name !== undefined ? { first_name: options.first_name } : {}),
    }
    const action = options.action ?? 'add'
    // Editing contacts is using the app: the 14-day clock restarts.
    this.#armInactivity(options.phoneNumberId, entry)
    entry.contacts = entry.contacts.filter((existing) => existing.phone !== contact.phone)
    if (action === 'add') entry.contacts.push(contact)

    dispatcher.dispatch(
      options.phoneNumberId,
      buildStateSyncPayload({
        ...this.#numberContext(options.phoneNumberId),
        contacts: [contact],
        action,
        timestampMs: clock.now(),
      }),
    )
    return { success: true }
  }

  /**
   * Control API: the business changes device or re-registers. The number is
   * offboarded, and unless told otherwise reconnects on its own a few minutes
   * later, as Meta's automatic reonboarding does.
   */
  appOffboard(options: { phoneNumberId: string; reconnect?: boolean }): { success: true } {
    const { clock } = this.#context
    const entry = this.#requireCoexistence(options.phoneNumberId)
    const phoneNumber = requirePhoneNumber(this.#context, options.phoneNumberId)

    entry.blocked = 'offboarded'
    // A later offboard replaces any reconnection still pending: only the
    // latest device change decides whether the number comes back.
    if (entry.reconnectTimer !== undefined) clock.clear(entry.reconnectTimer)
    entry.reconnectTimer = undefined
    this.#announce(phoneNumber.wabaId, 'ACCOUNT_OFFBOARDED')
    if (options.reconnect !== false) {
      entry.reconnectTimer = clock.at(clock.now() + RECONNECT_MS, () => {
        entry.reconnectTimer = undefined
        if (entry.blocked !== 'offboarded') return
        entry.blocked = undefined
        this.#armInactivity(options.phoneNumberId, entry)
        this.#announce(phoneNumber.wabaId, 'ACCOUNT_RECONNECTED')
      })
    }
    return { success: true }
  }

  /** Cancel every timer and forget every number. Part of `reset()`. */
  clear(): void {
    for (const entry of this.#numbers.values()) {
      if (entry.inactivityTimer !== undefined) this.#context.clock.clear(entry.inactivityTimer)
      if (entry.reconnectTimer !== undefined) this.#context.clock.clear(entry.reconnectTimer)
    }
    this.#numbers.clear()
  }

  // --- internals ----------------------------------------------------------

  #requireCoexistence(phoneNumberId: string): CoexistenceNumber {
    requirePhoneNumber(this.#context, phoneNumberId)
    const entry = this.#numbers.get(phoneNumberId)
    if (!entry) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Phone number ${phoneNumberId} is not shared with the WhatsApp Business app`,
      })
    }
    return entry
  }

  #armInactivity(phoneNumberId: string, entry: CoexistenceNumber): void {
    const { clock, dispatcher } = this.#context
    if (entry.inactivityTimer !== undefined) clock.clear(entry.inactivityTimer)
    entry.inactivityTimer = clock.at(clock.now() + PRIMARY_INACTIVITY_MS, () => {
      entry.inactivityTimer = undefined
      entry.blocked = 'removed'
      const phoneNumber = this.#context.state.phoneNumber(phoneNumberId)
      if (!phoneNumber) return
      dispatcher.dispatchToWaba(
        phoneNumber.wabaId,
        buildAccountUpdatePayload({
          wabaId: phoneNumber.wabaId,
          timeMs: clock.now(),
          event: 'PARTNER_REMOVED',
          ...this.#owner(phoneNumberId),
          disconnection: { reason: 'PRIMARY_INACTIVITY', initiatedBy: 'SYSTEM' },
        }),
      )
    })
  }

  #announce(wabaId: string, event: 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED'): void {
    const { clock, dispatcher } = this.#context
    dispatcher.dispatchToWaba(wabaId, buildAccountUpdatePayload({ wabaId, timeMs: clock.now(), event }))
  }

  #syncContacts(phoneNumberId: string, entry: CoexistenceNumber): void {
    const { clock, dispatcher } = this.#context
    if (entry.contacts.length === 0) return
    dispatcher.dispatch(
      phoneNumberId,
      buildStateSyncPayload({
        ...this.#numberContext(phoneNumberId),
        contacts: entry.contacts,
        action: 'add',
        timestampMs: clock.now(),
      }),
    )
  }

  /**
   * History in phases by age: phase 0 is the first day before onboarding,
   * phase 1 days 1 to 90, phase 2 days 90 to 180. One chunk per phase here,
   * an empty phase sends nothing, and `progress` reaches 100 on the last.
   * Importing history opens no service window: those customers wrote before
   * the number was on Cloud API.
   */
  #syncHistory(phoneNumberId: string, entry: CoexistenceNumber): void {
    const { dispatcher, state } = this.#context
    if (!entry.shareHistory) {
      dispatcher.dispatch(phoneNumberId, buildHistoryDeclinedPayload(this.#numberContext(phoneNumberId)))
      return
    }

    const phases: HistoryThread[][] = [[], [], []]
    let total = 0
    for (const thread of entry.history) {
      const waId = this.#waId(thread.phone)
      const byPhase: HistoryThread['messages'][] = [[], [], []]
      for (const message of thread.messages) {
        const phase = PHASE_ENDS.findIndex((end) => message.ago_ms < end)
        if (phase === -1) continue
        byPhase[phase]!.push({
          direction: message.direction,
          text: message.text,
          atMs: entry.onboardedAt - message.ago_ms,
          id: makeWamid(phoneNumberId, state.nextSeq()),
        })
        total++
      }
      byPhase.forEach((messages, phase) => {
        if (messages.length > 0) phases[phase]!.push({ user: this.#user(phoneNumberId, waId), messages })
      })
    }

    let sent = 0
    phases.forEach((threads, phase) => {
      if (threads.length === 0) return
      sent += threads.reduce((count, thread) => count + thread.messages.length, 0)
      dispatcher.dispatch(
        phoneNumberId,
        buildHistoryPayload({
          ...this.#numberContext(phoneNumberId),
          phase: phase as 0 | 1 | 2,
          chunkOrder: 1,
          progress: Math.round((100 * sent) / total),
          threads,
        }),
      )
    })
  }

  #waId(phone: string): string {
    const waId = normalizeWaId(phone)
    if (!waId) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `'${phone}' is not a valid phone number` })
    }
    return waId
  }

  #user(phoneNumberId: string, waId: string): UserIdentity {
    return userIdentity(this.#context, phoneNumberId, waId)
  }

  #numberContext(phoneNumberId: string) {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId)
    return { wabaId: phoneNumber.wabaId, phoneNumberId, displayPhoneNumber: phoneNumber.displayPhoneNumber }
  }

  #owner(phoneNumberId: string): { ownerBusinessId?: string } {
    const businessId = this.#context.state.businessIdOf(phoneNumberId)
    return businessId !== undefined ? { ownerBusinessId: businessId } : {}
  }
}
