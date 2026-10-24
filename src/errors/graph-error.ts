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
  /** Template paused too many times and disabled for good. Needs a new template. */
  TEMPLATE_DISABLED: 132016,
  /** A parameter is present but its value is not usable, e.g. an unknown message id to mark read. */
  PARAMETER_VALUE_INVALID: 131009,
  /** A BSUID recipient for a message that needs the phone number (authentication templates). */
  BSUID_NOT_SUPPORTED: 131062,
  /** The number is not (or no longer) on Cloud API, e.g. a disconnected coexistence number. */
  NOT_REGISTERED: 133010,
  /** `smb_app_data` called a second time for the same sync type. */
  SYNC_LIMIT_EXCEEDED: 2593107,
  /** `smb_app_data` called 24 hours or more after onboarding. */
  SYNC_WINDOW_CLOSED: 2593108,
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
   * Whether the message starts with `(#code)`. Messaging errors do; token
   * errors read `Error validating access token: …` with no prefix, so a parser
   * keyed on `(#190)` misses every expired token. Defaults to true.
   */
  codePrefix?: boolean
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
    codePrefix: false,
    errorData: false,
    retriable: false,
  },
  [ERROR_CODES.TOKEN_EXPIRED]: {
    message: 'Error validating access token: Session has expired.',
    type: 'OAuthException',
    httpStatus: 401,
    codePrefix: false,
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
  [ERROR_CODES.PARAMETER_VALUE_INVALID]: {
    // Wording from Meta's error code reference and its mark-as-read page.
    message: 'Parameter value is not valid',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'One or more parameter values are invalid.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.BSUID_NOT_SUPPORTED]: {
    // Meta documents only this sentence, as the details. With no shorter
    // title published, it serves as the message too.
    message: 'Business-scoped User ID (BSUID) recipients are not supported for this message.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Business-scoped User ID (BSUID) recipients are not supported for this message.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.NOT_REGISTERED]: {
    // Meta's error code reference gives this sentence and no shorter title.
    message: 'Phone number not registered on the WhatsApp Business Platform.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Register the phone number before trying again.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.SYNC_LIMIT_EXCEEDED]: {
    // Meta documents only the details text for the synchronization errors;
    // it serves as the message too.
    message:
      'You have exceeded the maximum number of times to call the synchronization api for this phone number.',
    type: 'OAuthException',
    httpStatus: 400,
    details:
      'You have exceeded the maximum number of times to call the synchronization api for this phone number.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.SYNC_WINDOW_CLOSED]: {
    message: 'Synchronization request can only be made within 24 hours of onboarding',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Synchronization request can only be made within 24 hours of onboarding',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TEMPLATE_DISABLED]: {
    // Meta's error code reference gives this sentence and no shorter title.
    message:
      'Template has been paused too many times due to low quality and is now permanently disabled.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Message failed to send because the template used has been permanently disabled. Create a new template with different content.',
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

const renderMessage = (code: number, entry: CatalogEntry, message: string): string =>
  entry.codePrefix === false ? message : `(#${code}) ${message}`

/** The catalogue's `error_data.details` for a code, if it has one. */
export function defaultDetails(code: number): string | undefined {
  return CATALOG[code]?.details
}

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
    super(renderMessage(code, entry, message))
    this.name = 'GraphError'
    this.code = code
    this.httpStatus = entry.httpStatus
    this.#entry = { ...entry, message }
    this.#details = options.details ?? entry.details
  }

  toBody(fbtraceId: string): GraphErrorBody {
    return {
      error: {
        message: renderMessage(this.code, this.#entry, this.#entry.message),
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
