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
  /** Graph's "invalid request or possible server error": what a fault inside wamock answers. */
  UNKNOWN: 1,
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
  /** The send's template parameters do not match the template's placeholders. */
  TEMPLATE_PARAMETER_MISMATCH: 132000,
  /** The media a message names is not a type that kind of message carries. */
  MEDIA_UPLOAD_ERROR: 131053,
  /** A template parameter's value is not in the form its type needs. */
  TEMPLATE_PARAMETER_FORMAT: 132012,
  /**
   * Meta's catch-all for invalid template send parameters (v23+). wamock's own
   * checks answer the more specific 132000 and 132012; the entry is here so a
   * scenario forcing 132018 gets Meta's wording.
   */
  TEMPLATE_VALIDATION: 132018,
  /** No template for that name + language pair. */
  TEMPLATE_NOT_FOUND: 132001,
  /** Some users in a block or unblock request could not be (un)blocked. */
  BLOCK_USERS_FAILED: 139100,
  /** A blocked-users page requested with a cursor from before the list changed. */
  BLOCKLIST_CHANGED: 139102,
  /** A message to a customer the business blocked: on the status, not the send. */
  BLOCKED_USER: 130403,
  /** Listing templates (v24+) with a `before`/`after` cursor that names no template. */
  INVALID_PAGINATION_CURSOR: 131059,
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
  /** `register` for a number whose ownership was not verified yet. */
  NOT_VERIFIED: 133006,
  /** `register` with a PIN other than the number's two-step verification PIN. */
  PIN_INCORRECT: 133005,
  /** More than 10 register/deregister calls for a number in 72 hours. */
  REGISTRATION_LIMIT: 133016,
  /** `request_code` for a number that is already verified. */
  ALREADY_VERIFIED: 136024,
  /** `smb_app_data` called a second time for the same sync type. */
  SYNC_LIMIT_EXCEEDED: 2593107,
  /** `smb_app_data` called 24 hours or more after onboarding. */
  SYNC_WINDOW_CLOSED: 2593108,
  /** Generic transient Meta-side failure. Retriable. */
  INTERNAL: 131000,
  /** The token lacks a permission the call needs (Graph's 200-299 range). */
  PERMISSION_DENIED: 200,
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
  /**
   * Whether `error_data` carries `messaging_product`. Meta's general error
   * syntax shows it; the Block Users examples show `details` alone. Defaults
   * to true.
   */
  productInErrorData?: boolean
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
  [ERROR_CODES.MEDIA_UPLOAD_ERROR]: {
    // Both sentences are Meta's error code reference, verbatim. The per-type
    // message pages say an unsupported format fails the request itself.
    message: 'Unable to upload the media used in the message.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'The media could not be uploaded for one or more reasons, such as an unsupported media type.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TEMPLATE_PARAMETER_FORMAT]: {
    // As for 132000: Graph's message as integrators report it, and the
    // details from Meta's error code reference, verbatim.
    message: 'Parameter format does not match format in the created template',
    type: 'OAuthException',
    httpStatus: 400,
    details:
      'The variable parameter values included in the request are not using the format specified in the template.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.INVALID_PAGINATION_CURSOR]: {
    // Meta's changelog (October 2025) documents the code and when it comes,
    // not its wording, and the error code reference does not list it. The
    // message restates the changelog; the code is what an integration
    // branches on.
    message: 'Invalid pagination cursor',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Retry the request without before or after cursors to get new ones.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.BLOCK_USERS_FAILED]: {
    // Meta's "Block users" page, verbatim. The status code is not shown; the
    // body carries an `error`, so it is answered as Graph errors are, 400.
    message: 'Failed to block/unblock users',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Failed to block some users, see the block_users response list for details',
    errorData: true,
    productInErrorData: false,
    retriable: false,
  },
  [ERROR_CODES.BLOCKLIST_CHANGED]: {
    // Meta's "Block users" page: the title and the description, verbatim.
    message: 'Blocklist concurrent update',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Occurs when the blocklist is updated while performing a pagination request and version_id does not match.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.BLOCKED_USER]: {
    // Meta's error code reference gives this sentence and no shorter title,
    // as for 131050.
    message: 'Unable to deliver the message. This business has blocked the end user on WhatsApp',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Unable to deliver the message. This business has blocked the end user on WhatsApp',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TEMPLATE_VALIDATION]: {
    // Meta's error code reference, verbatim.
    message: 'Template validation error',
    type: 'OAuthException',
    httpStatus: 400,
    details: "There's an issue with the parameters in your template.",
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.TEMPLATE_PARAMETER_MISMATCH]: {
    // The message is the one Graph returns in practice, as widely reported by
    // integrators; the details are Meta's error code reference, verbatim.
    message: 'Number of parameters does not match the expected number of params',
    type: 'OAuthException',
    httpStatus: 400,
    details:
      'The number of variable parameter values included in the request did not match the number of variable parameters defined in the template.',
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
  [ERROR_CODES.UNKNOWN]: {
    // Meta's error code reference describes code 1 as "Invalid request or
    // possible server error" without a message; this one is wamock's. It is
    // what a fault in the mock itself answers, so it never passes for a 100
    // the request earned.
    message: 'An unknown error occurred',
    type: 'OAuthException',
    httpStatus: 500,
    details: 'Invalid request or possible server error.',
    errorData: true,
    retriable: true,
  },
  [ERROR_CODES.PERMISSION_DENIED]: {
    // Meta's error code reference puts a missing permission at 200-299, and
    // its registration page names 200 for deregistering without
    // whatsapp_business_management; the API references answer it with 403.
    // "Permissions error" is Graph's title for 200 as integrators report it.
    message: 'Permissions error',
    type: 'OAuthException',
    httpStatus: 403,
    details: 'Permission is either not granted or has been removed.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.NOT_VERIFIED]: {
    // Meta's error code reference gives this sentence and no shorter title.
    message: 'Phone number needs to be verified before registering.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Phone number needs to be verified before registering.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.PIN_INCORRECT]: {
    // Meta's error code reference gives this sentence and no shorter title.
    message: 'Two-step verification PIN incorrect.',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Two-step verification PIN incorrect.',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.REGISTRATION_LIMIT]: {
    // Meta's error code reference, verbatim.
    message:
      'Registration or Deregistration failed because there were too many attempts for this phone number in a short period of time',
    type: 'OAuthException',
    httpStatus: 400,
    details:
      'Registration or Deregistration failed because there were too many attempts for this phone number in a short period of time',
    errorData: true,
    retriable: false,
  },
  [ERROR_CODES.ALREADY_VERIFIED]: {
    // Meta's phone number page documents the code and its HTTP 400, not the
    // wording; this message is wamock's.
    message: 'Phone number is already verified',
    type: 'OAuthException',
    httpStatus: 400,
    details: 'Check code_verification_status before requesting a code.',
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
    error_data?: { messaging_product?: string; details: string }
    fbtrace_id: string
  }
}

export interface GraphErrorOptions {
  /** Overrides `error_data.details` — use it to name the offending field or template. */
  details?: string
  /** Overrides the catalogue message. Rarely needed. */
  message?: string
  /** Overrides the shape for a Graph-level error that is not in the WhatsApp catalogue. */
  shape?: Partial<Pick<CatalogEntry, 'type' | 'subcode' | 'errorData' | 'codePrefix' | 'httpStatus'>>
  /**
   * Fields Meta returns beside `error`, as the Block Users API does with the
   * users it did and did not block.
   */
  extra?: Record<string, unknown>
}

/**
 * Graph's answer for an object the caller cannot see, whether it is absent,
 * someone else's, or the wrong kind for the call: code 100, subcode 33,
 * `GraphMethodException`, no `(#100)` prefix and no `error_data`. Integrations
 * branch on the subcode, and the verb in the message follows the HTTP method.
 */
export function unsupportedRequest(method: 'get' | 'post' | 'delete', objectId: string): GraphError {
  return new GraphError(ERROR_CODES.INVALID_PARAMETER, {
    message: `Unsupported ${method} request. Object with ID '${objectId}' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api`,
    shape: { type: 'GraphMethodException', subcode: 33, errorData: false, codePrefix: false },
  })
}

/** A Graph API failure, carrying everything needed to render Meta's exact response. */
export class GraphError extends Error {
  readonly code: number
  readonly httpStatus: number
  readonly #entry: CatalogEntry
  readonly #details: string | undefined
  readonly #extra: Record<string, unknown> | undefined

  constructor(code: number, options: GraphErrorOptions = {}) {
    const entry = { ...entryFor(code), ...options.shape }
    const message = options.message ?? entry.message
    super(renderMessage(code, entry, message))
    this.name = 'GraphError'
    this.code = code
    this.httpStatus = entry.httpStatus
    this.#entry = { ...entry, message }
    this.#details = options.details ?? entry.details
    this.#extra = options.extra
  }

  toBody(fbtraceId: string): GraphErrorBody {
    return {
      ...this.#extra,
      error: {
        message: renderMessage(this.code, this.#entry, this.#entry.message),
        type: this.#entry.type,
        code: this.code,
        ...(this.#entry.subcode !== undefined ? { error_subcode: this.#entry.subcode } : {}),
        ...(this.#entry.errorData
          ? {
              error_data: {
                ...(this.#entry.productInErrorData === false ? {} : { messaging_product: 'whatsapp' }),
                details: this.#details ?? this.#entry.message,
              },
            }
          : {}),
        fbtrace_id: fbtraceId,
      },
    }
  }
}
