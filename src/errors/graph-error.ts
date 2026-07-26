/**
 * Meta's error catalogue (spec §7), reproduced code-for-code.
 *
 * The point is not just the number. Integrations branch on the code to decide
 * whether to retry, fall back to a template, or alert a human — so the mock has
 * to get the *whole* triple right: the code, the HTTP status it arrives with,
 * and the retry semantics. A mock that returns 131047 as a 500 teaches the
 * integration to retry forever against a permanent failure.
 */

/** Named codes so call sites read as intent, not magic numbers. */
export const ERROR_CODES = {
  /** Malformed / invalid parameter. Also what Meta returns when interactive limits are exceeded. */
  INVALID_PARAMETER: 100,
  /** Token missing or unusable. */
  TOKEN_INVALID: 0,
  /** Token expired mid-flight — the expensive silent failure of spec §9.2. */
  TOKEN_EXPIRED: 190,
  /** Throughput rate limit. Retriable. */
  RATE_LIMIT: 130429,
  /** Recipient cannot receive (invalid number, not on WhatsApp). */
  UNDELIVERABLE: 131026,
  /** Free-form message outside the 24h service window. Permanent — needs a template. */
  REENGAGEMENT: 131047,
  /** Blocked by spam / quality rating. Retriable with backoff. */
  SPAM_RATE_LIMIT: 131048,
  /** No template for that name + language pair. */
  TEMPLATE_NOT_FOUND: 132001,
  /** Template paused by Meta for quality. Permanent until it transitions back. */
  TEMPLATE_PAUSED: 132015,
  /** Generic transient Meta-side failure. Retriable. */
  INTERNAL: 131000,
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

interface CatalogEntry {
  message: string
  type: string
  httpStatus: number
  subcode?: number
  /** Default `error_data.details`, overridable per call site. */
  details?: string
  /**
   * Whether Meta attaches `error_data` at all. Messaging errors do; OAuth
   * errors do not — and a receiver that blindly reads `error_data.details`
   * crashes on the OAuth ones, which is a bug worth reproducing.
   */
  errorData: boolean
  retriable: boolean
}

const CATALOG: Record<number, CatalogEntry> = {
  [ERROR_CODES.INVALID_PARAMETER]: {
    message: 'Invalid parameter',
    type: 'OAuthException',
    httpStatus: 400,
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TOKEN_INVALID]: {
    message: 'Invalid OAuth access token - Cannot parse access token',
    type: 'OAuthException',
    httpStatus: 401,
    errorData: false,
    retriable: false,
  },
  [ERROR_CODES.TOKEN_EXPIRED]: {
    message: 'Error validating access token: Session has expired.',
    type: 'OAuthException',
    httpStatus: 401,
    subcode: 463,
    errorData: false,
    retriable: false,
  },
  [ERROR_CODES.RATE_LIMIT]: {
    message: 'Rate limit hit',
    type: 'OAuthException',
    httpStatus: 429,
    details: 'Message failed to send because there were too many messages sent from this phone number in a short period of time.',
    errorData: true,
    retriable: true,
  },
  [ERROR_CODES.UNDELIVERABLE]: {
    message: 'Message undeliverable',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Message could not be delivered to the recipient. The recipient may not have WhatsApp, or the number may be invalid.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.REENGAGEMENT]: {
    message: 'Re-engagement message',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.SPAM_RATE_LIMIT]: {
    message: 'Spam rate limit hit',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Message failed to send because there are restrictions on how many messages can be sent from this phone number. This may be because too many previous messages were blocked or flagged as spam.',
    errorData: true,
    retriable: true,
  },
  [ERROR_CODES.TEMPLATE_NOT_FOUND]: {
    message: 'Template name does not exist in the translation',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'The template does not exist for the given name and language.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TEMPLATE_PAUSED]: {
    message: 'Template is paused due to low quality',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Message failed to send because the template used has been paused for quality reasons.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.INTERNAL]: {
    message: 'Something went wrong',
    type: 'OAuthException',
    httpStatus: 500,
    details: 'An internal error occurred on the WhatsApp side. Retry with backoff.',
    errorData: true,
    retriable: true,
  },
}

const UNKNOWN: CatalogEntry = {
  message: 'An unknown error occurred',
  type: 'OAuthException',
  httpStatus: 400,
  errorData: true,
  retriable: false,
}

const entryFor = (code: number): CatalogEntry => CATALOG[code] ?? UNKNOWN

/** Whether spec §7 classifies this code as worth retrying. */
export function isRetriable(code: number): boolean {
  return entryFor(code).retriable
}

/** The body shape Meta returns on a failed Graph call. */
export interface GraphErrorBody {
  error: {
    message: string
    type: string
    code: number
    error_subcode?: number
    error_data?: { messaging_product: string; details: string }
    fbtrace_id: string
  }
}

export interface GraphErrorOptions {
  /** Overrides `error_data.details` — use it to name the offending field or template. */
  details?: string
  /** Overrides the catalogue message. Rarely needed. */
  message?: string
}

/** A Graph API failure, carrying everything needed to render Meta's exact response. */
export class GraphError extends Error {
  readonly code: number
  readonly httpStatus: number
  readonly #entry: CatalogEntry
  readonly #details: string | undefined

  constructor(code: number, options: GraphErrorOptions = {}) {
    const entry = entryFor(code)
    const message = options.message ?? entry.message
    super(`(#${code}) ${message}`)
    this.name = 'GraphError'
    this.code = code
    this.httpStatus = entry.httpStatus
    this.#entry = { ...entry, message }
    this.#details = options.details ?? entry.details
  }

  toBody(fbtraceId: string): GraphErrorBody {
    return {
      error: {
        message: `(#${this.code}) ${this.#entry.message}`,
        type: this.#entry.type,
        code: this.code,
        ...(this.#entry.subcode !== undefined ? { error_subcode: this.#entry.subcode } : {}),
        ...(this.#entry.errorData
          ? {
              error_data: {
                messaging_product: 'whatsapp',
                details: this.#details ?? this.#entry.message,
              },
            }
          : {}),
        fbtrace_id: fbtraceId,
      },
    }
  }
}
