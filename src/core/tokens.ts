import { randomBytes } from 'node:crypto'

/**
 * Access token lifecycle (spec §9.2).
 *
 * The expensive failure this reproduces: someone pastes a Graph API Explorer
 * token into a connect form. Everything works. Roughly two hours later every
 * send returns 401 OAuthException 190, and the product says nothing — messages
 * just stop arriving. Nobody notices for days.
 *
 * Two details make it hard to catch without a mock:
 *
 * - `expires_at: 0` means **never expires** (a System User token), not
 *   "expired in 1970". Code that compares it numerically against the clock
 *   rejects the only tokens that are actually safe.
 * - A token can be valid for sending and still lack
 *   `whatsapp_business_management`, so the connect looks healthy and template
 *   submission fails later, somewhere else.
 */

const HOUR_MS = 60 * 60 * 1000

export type TokenKind =
  /** System User token. Never expires; the only kind safe in production. */
  | 'permanent'
  /** Graph API Explorer token, ~1-2h. The silent killer. */
  | 'short'
  /** Long-lived user token, 60 days. */
  | 'long'

export const DEFAULT_SCOPES = ['whatsapp_business_messaging', 'whatsapp_business_management']

export interface IssueOptions {
  appId: string
  kind: TokenKind
  scopes?: string[]
  wabaId?: string
}

interface TokenRecord {
  token: string
  appId: string
  kind: TokenKind
  scopes: string[]
  /** Epoch ms, or 0 for a token that never expires. */
  expiresAtMs: number
  revoked: boolean
  wabaId?: string
}

/** The `data` object Meta returns from `GET /debug_token`. */
export interface DebugTokenData {
  app_id: string
  type: string
  application: string
  is_valid: boolean
  /** Unix SECONDS, or 0 for "never expires". */
  expires_at: number
  scopes: string[]
}

const LIFETIME_MS: Record<TokenKind, number> = {
  permanent: 0,
  short: 2 * HOUR_MS,
  long: 60 * 24 * HOUR_MS,
}

export class TokenStore {
  #tokens = new Map<string, TokenRecord>()

  issue(options: IssueOptions, nowMs: number): string {
    const lifetime = LIFETIME_MS[options.kind]
    const token = `${options.kind.toUpperCase()}_${randomBytes(12).toString('hex')}`

    this.#tokens.set(token, {
      token,
      appId: options.appId,
      kind: options.kind,
      scopes: options.scopes ?? [...DEFAULT_SCOPES],
      expiresAtMs: lifetime === 0 ? 0 : nowMs + lifetime,
      revoked: false,
      ...(options.wabaId !== undefined ? { wabaId: options.wabaId } : {}),
    })
    return token
  }

  /** Unknown tokens are invalid, never an exception — callers get a 401, not a 500. */
  isValid(token: string, nowMs: number): boolean {
    const record = this.#tokens.get(token)
    if (!record || record.revoked) return false
    // 0 means never expires. Comparing it to the clock would reject exactly
    // the tokens that are safe.
    if (record.expiresAtMs === 0) return true
    return nowMs < record.expiresAtMs
  }

  hasScope(token: string, scope: string): boolean {
    return this.#tokens.get(token)?.scopes.includes(scope) ?? false
  }

  /** Simulate a token pulled in Business Manager mid-operation. */
  revoke(token: string): void {
    const record = this.#tokens.get(token)
    if (record) record.revoked = true
  }

  record(token: string): { appId: string; wabaId?: string } | undefined {
    const found = this.#tokens.get(token)
    if (!found) return undefined
    return { appId: found.appId, ...(found.wabaId !== undefined ? { wabaId: found.wabaId } : {}) }
  }

  debug(token: string, nowMs: number): DebugTokenData {
    const record = this.#tokens.get(token)
    if (!record) {
      return {
        app_id: '',
        type: 'USER',
        application: 'unknown',
        is_valid: false,
        expires_at: 0,
        scopes: [],
      }
    }

    return {
      app_id: record.appId,
      type: 'USER',
      application: record.appId,
      is_valid: this.isValid(token, nowMs),
      expires_at: record.expiresAtMs === 0 ? 0 : Math.floor(record.expiresAtMs / 1000),
      scopes: [...record.scopes],
    }
  }

  clear(): void {
    this.#tokens = new Map()
  }
}
