import type { MockContext } from '../core/context.js'
import { requirePhoneNumber } from '../core/guards.js'
import { normalizeWaId } from '../core/phone.js'
import { isRecord } from '../core/values.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { fromCursor, pageOf } from './paging.js'
import type { PageOptions } from './paging.js'

/**
 * The Block Users API (`/{phone_number_id}/block_users`), from Meta's
 * "Block users" page: a business blocks customers who wrote in the last 24
 * hours, a blocked customer cannot reach it, and a message to one fails.
 */

/** "Each request can include a maximum of 1,000 users." */
const MAX_USERS_PER_REQUEST = 1000
/** "The blocklist has a 64,000 user limit." */
const BLOCKLIST_LIMIT = 64_000

/** A per-user error in Meta's shape: `message` is the title from its table. */
interface UserError {
  message: string
  code: number
  error_data: { details: string }
}

const REENGAGEMENT: UserError = {
  message: 'Re-engagement required',
  code: 131047,
  error_data: { details: 'User has not messaged in the last 24 hours' },
}
const SELF_BLOCK: UserError = {
  message: 'Self block',
  code: 131021,
  error_data: { details: 'Cannot block your own phone number.' },
}
const LIMIT_REACHED: UserError = {
  message: 'Blocklist limit reached',
  code: 139101,
  error_data: { details: 'The blocklist has reached its 64,000 user limit.' },
}

interface UserResult {
  input: string
  wa_id?: string
  errors?: UserError[]
}

export interface BlockListOptions extends PageOptions {
  baseUrl?: string
  version?: string
}

export class BlockService {
  readonly #context: MockContext
  /** Blocked customers per business number, in the order they were blocked. */
  #blocked = new Map<string, Set<string>>()
  /** Bumped on every change to a number's list, so a stale cursor is told apart. */
  #versions = new Map<string, number>()

  constructor(context: MockContext) {
    this.#context = context
  }

  isBlocked(phoneNumberId: string, waId: string): boolean {
    return this.#blocked.get(phoneNumberId)?.has(waId) === true
  }

  /** `POST /{phone_number_id}/block_users`. */
  block(phoneNumberId: string, body: Record<string, unknown>): Record<string, unknown> {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    const users = this.#users(body)
    const { clock, windows } = this.#context
    const blocked = this.#blocked.get(phoneNumberId) ?? new Set<string>()
    this.#blocked.set(phoneNumberId, blocked)

    const added: UserResult[] = []
    const failed: UserResult[] = []
    for (const input of users) {
      const waId = normalizeWaId(input)
      // An invalid number fails like a user who has not written, without a
      // wa_id: "This error also occurs if the number is an invalid WhatsApp
      // user", and the wa_id is "absent in failed_users when the number is
      // invalid".
      if (!waId) failed.push({ input, errors: [REENGAGEMENT] })
      else if (waId === phoneNumber.displayPhoneNumber) failed.push({ input, wa_id: waId, errors: [SELF_BLOCK] })
      else if (!windows.isOpen(phoneNumberId, waId, clock.now())) failed.push({ input, wa_id: waId, errors: [REENGAGEMENT] })
      else if (!blocked.has(waId) && blocked.size >= BLOCKLIST_LIMIT) failed.push({ input, wa_id: waId, errors: [LIMIT_REACHED] })
      else {
        if (!blocked.has(waId)) this.#bump(phoneNumberId)
        blocked.add(waId)
        added.push({ input, wa_id: waId })
      }
    }
    return this.#answer('added_users', added, failed, 'block')
  }

  /**
   * `DELETE /{phone_number_id}/block_users`. Meta's example shows an unblock
   * failing with 131047 too; wamock refuses only an invalid number, since a
   * blocked customer cannot write, and requiring a recent message would make
   * every block permanent. An inference: the page does not say.
   */
  unblock(phoneNumberId: string, body: Record<string, unknown>): Record<string, unknown> {
    requirePhoneNumber(this.#context, phoneNumberId, 'delete')
    const users = this.#users(body)
    const blocked = this.#blocked.get(phoneNumberId)
    const removed: UserResult[] = []
    const failed: UserResult[] = []
    for (const input of users) {
      const waId = normalizeWaId(input)
      if (!waId) {
        failed.push({ input, errors: [REENGAGEMENT] })
        continue
      }
      if (blocked?.delete(waId) === true) this.#bump(phoneNumberId)
      removed.push({ input, wa_id: waId })
    }
    return this.#answer('removed_users', removed, failed, 'unblock')
  }

  /**
   * `GET /{phone_number_id}/block_users`, paged by cursor like every Graph
   * edge. A cursor carries the list's version: one taken before the list
   * changed answers Meta's 139102, "Blocklist concurrent update".
   */
  list(phoneNumberId: string, options: BlockListOptions = {}): { data: unknown[]; paging?: Record<string, unknown> } {
    requirePhoneNumber(this.#context, phoneNumberId, 'get')
    const version = this.#versions.get(phoneNumberId) ?? 0
    const ordered = [...(this.#blocked.get(phoneNumberId) ?? [])].map((waId) => `${version}|${waId}`)
    const link = (param: 'after' | 'before', cursor: string) => {
      const url = new URL(`${options.baseUrl ?? 'https://graph.facebook.com'}/${options.version ?? 'v26.0'}/${phoneNumberId}/block_users`)
      if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit))
      url.searchParams.set(param, cursor)
      return url.toString()
    }
    // Meta documents no default page size here; without `limit`, one page.
    const page = pageOf(ordered, { ...options, defaultLimit: ordered.length }, link)
    if (!page) {
      const cursor = options.after ?? options.before ?? ''
      // Ours from an earlier version: `<version>|<wa_id>`, digits both sides.
      const stale = /^\d+\|\d+$/.test(fromCursor(cursor)) && !fromCursor(cursor).startsWith(`${version}|`)
      if (stale) throw new GraphError(ERROR_CODES.BLOCKLIST_CHANGED)
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param after or before is not a valid cursor' })
    }
    const data = page.ids.map((id) => ({ messaging_product: 'whatsapp', wa_id: id.slice(id.indexOf('|') + 1) }))
    return page.paging ? { data, paging: page.paging } : { data }
  }

  clear(): void {
    this.#blocked = new Map()
    this.#versions = new Map()
  }

  #bump(phoneNumberId: string): void {
    this.#versions.set(phoneNumberId, (this.#versions.get(phoneNumberId) ?? 0) + 1)
  }

  #users(body: Record<string, unknown>): string[] {
    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: "Param messaging_product must be 'whatsapp'" })
    }
    const list = body['block_users']
    if (!Array.isArray(list) || list.length === 0) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param block_users must be a non-empty array of {user}' })
    }
    // 130429 is Meta's answer to "too many numbers in the request".
    if (list.length > MAX_USERS_PER_REQUEST) {
      throw new GraphError(ERROR_CODES.RATE_LIMIT, {
        details: `A block_users request takes at most ${MAX_USERS_PER_REQUEST} users (got ${list.length})`,
      })
    }
    return list.map((entry, index) => {
      if (!isRecord(entry) || typeof entry['user'] !== 'string' || entry['user'] === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `Param block_users[${index}][user] is required` })
      }
      return entry['user']
    })
  }

  /**
   * Meta's answer: the users it acted on, the ones it could not with their
   * errors, and, when any failed, a top-level 139100 beside them. Thrown as
   * a 400 carrying the lists, since the body holds an `error` (an inference:
   * the page shows the body, not its status).
   */
  #answer(
    key: 'added_users' | 'removed_users',
    done: UserResult[],
    failed: UserResult[],
    verb: 'block' | 'unblock',
  ): Record<string, unknown> {
    const blockUsers = { [key]: done, ...(failed.length > 0 ? { failed_users: failed } : {}) }
    if (failed.length > 0) {
      throw new GraphError(ERROR_CODES.BLOCK_USERS_FAILED, {
        details: `Failed to ${verb} some users, see the block_users response list for details`,
        extra: { messaging_product: 'whatsapp', block_users: blockUsers },
      })
    }
    return { messaging_product: 'whatsapp', block_users: blockUsers }
  }
}
