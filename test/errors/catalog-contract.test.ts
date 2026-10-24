import { describe, expect, it } from 'vitest'

import { ERROR_CODES, GraphError, isRetriable, unsupportedRequest } from '../../src/errors/graph-error.js'

/**
 * The error catalogue as a pinned contract.
 *
 * Mutation testing exposed why this file has to exist. `graph-error.ts` had
 * 100% line coverage and a 48.8% mutation score: every message, every `type`,
 * every `errorData` flag could be changed and the whole suite still passed.
 * The old tests asserted on codes, and the codes were never what was fragile.
 *
 * For wamock the **wording is the contract**. Integrations regex `(#131047)`
 * out of logs, branch on `"already exists"`, and read `error_data.details`.
 * A mock free to reword its errors is a mock that stops reproducing the thing
 * people came for — silently, because nothing would fail.
 *
 * Changing an expected value here is not a test to fix. It is a deliberate
 * change to what wamock claims Meta returns, and it should be as hard as that
 * sounds.
 */

interface CatalogEntry {
  code: number
  httpStatus: number
  retriable: boolean
  message: string
  type: string
  subcode: number | undefined
  details: string | undefined
}

const CATALOG: Record<string, CatalogEntry> = {
  INVALID_PARAMETER: {
    code: 100,
    httpStatus: 400,
    retriable: false,
    message: '(#100) Invalid parameter',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Invalid parameter',
  },
  TOKEN_INVALID: {
    code: 0,
    httpStatus: 401,
    retriable: false,
    // Token errors carry no `(#code)` prefix, unlike every messaging error:
    // a log parser keyed on `(#190)` never sees an expired token.
    message: 'Invalid OAuth access token - Cannot parse access token',
    type: 'OAuthException',
    subcode: undefined,
    // OAuth errors carry no error_data — a receiver reading details blindly
    // crashes on exactly these, which is worth reproducing.
    details: undefined,
  },
  TOKEN_EXPIRED: {
    code: 190,
    httpStatus: 401,
    retriable: false,
    message: 'Error validating access token: Session has expired.',
    type: 'OAuthException',
    subcode: 463,
    details: undefined,
  },
  RATE_LIMIT: {
    code: 130429,
    httpStatus: 429,
    retriable: true,
    message: '(#130429) Rate limit hit',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'Message failed to send because there were too many messages sent from this phone number in a short period of time.',
  },
  UNDELIVERABLE: {
    code: 131026,
    httpStatus: 400,
    retriable: false,
    message: '(#131026) Message undeliverable',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'Message could not be delivered to the recipient. The recipient may not have WhatsApp, or the number may be invalid.',
  },
  REENGAGEMENT: {
    code: 131047,
    httpStatus: 400,
    retriable: false,
    message: '(#131047) Re-engagement message',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
  },
  SPAM_RATE_LIMIT: {
    code: 131048,
    httpStatus: 400,
    retriable: true,
    message: '(#131048) Spam rate limit hit',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'Message failed to send because there are restrictions on how many messages can be sent from this phone number. This may be because too many previous messages were blocked or flagged as spam.',
  },
  TEMPLATE_NOT_FOUND: {
    code: 132001,
    httpStatus: 400,
    retriable: false,
    message: '(#132001) Template name does not exist in the translation',
    type: 'OAuthException',
    subcode: undefined,
    details: 'The template does not exist for the given name and language.',
  },
  MEDIA_UPLOAD_ERROR: {
    code: 131053,
    httpStatus: 400,
    retriable: false,
    message: '(#131053) Unable to upload the media used in the message.',
    type: 'OAuthException',
    subcode: undefined,
    details: 'The media could not be uploaded for one or more reasons, such as an unsupported media type.',
  },
  TEMPLATE_PARAMETER_FORMAT: {
    code: 132012,
    httpStatus: 400,
    retriable: false,
    message: '(#132012) Parameter format does not match format in the created template',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'The variable parameter values included in the request are not using the format specified in the template.',
  },
  INVALID_PAGINATION_CURSOR: {
    code: 131059,
    httpStatus: 400,
    retriable: false,
    message: '(#131059) Invalid pagination cursor',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Retry the request without before or after cursors to get new ones.',
  },
  TEMPLATE_VALIDATION: {
    code: 132018,
    httpStatus: 400,
    retriable: false,
    message: '(#132018) Template validation error',
    type: 'OAuthException',
    subcode: undefined,
    details: "There's an issue with the parameters in your template.",
  },
  TEMPLATE_PARAMETER_MISMATCH: {
    code: 132000,
    httpStatus: 400,
    retriable: false,
    message: '(#132000) Number of parameters does not match the expected number of params',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'The number of variable parameter values included in the request did not match the number of variable parameters defined in the template.',
  },
  TEMPLATE_PAUSED: {
    code: 132015,
    httpStatus: 400,
    retriable: false,
    message: '(#132015) Template is paused due to low quality',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Message failed to send because the template used has been paused for quality reasons.',
  },
  PARAMETER_VALUE_INVALID: {
    code: 131009,
    httpStatus: 400,
    retriable: false,
    message: '(#131009) Parameter value is not valid',
    type: 'OAuthException',
    subcode: undefined,
    details: 'One or more parameter values are invalid.',
  },
  BSUID_NOT_SUPPORTED: {
    code: 131062,
    httpStatus: 400,
    retriable: false,
    message: '(#131062) Business-scoped User ID (BSUID) recipients are not supported for this message.',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Business-scoped User ID (BSUID) recipients are not supported for this message.',
  },
  NOT_REGISTERED: {
    code: 133010,
    httpStatus: 400,
    retriable: false,
    message: '(#133010) Phone number not registered on the WhatsApp Business Platform.',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Register the phone number before trying again.',
  },
  SYNC_LIMIT_EXCEEDED: {
    code: 2593107,
    httpStatus: 400,
    retriable: false,
    message:
      '(#2593107) You have exceeded the maximum number of times to call the synchronization api for this phone number.',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'You have exceeded the maximum number of times to call the synchronization api for this phone number.',
  },
  SYNC_WINDOW_CLOSED: {
    code: 2593108,
    httpStatus: 400,
    retriable: false,
    message: '(#2593108) Synchronization request can only be made within 24 hours of onboarding',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Synchronization request can only be made within 24 hours of onboarding',
  },
  TEMPLATE_DISABLED: {
    code: 132016,
    httpStatus: 400,
    retriable: false,
    message:
      '(#132016) Template has been paused too many times due to low quality and is now permanently disabled.',
    type: 'OAuthException',
    subcode: undefined,
    details:
      'Message failed to send because the template used has been permanently disabled. Create a new template with different content.',
  },
  INTERNAL: {
    code: 131000,
    httpStatus: 500,
    retriable: true,
    message: '(#131000) Something went wrong',
    type: 'OAuthException',
    subcode: undefined,
    details: 'An internal error occurred on the WhatsApp side. Retry with backoff.',
  },
}

describe('every catalogued error renders exactly this body', () => {
  it.each(Object.entries(CATALOG))('%s', (_name, entry) => {
    const error = new GraphError(entry.code)
    const body = error.toBody('AtEsTfBtRaCe')

    expect(error.httpStatus).toBe(entry.httpStatus)
    expect(isRetriable(entry.code)).toBe(entry.retriable)

    expect(body.error.code).toBe(entry.code)
    expect(body.error.message).toBe(entry.message)
    expect(body.error.type).toBe(entry.type)
    expect(body.error.fbtrace_id).toBe('AtEsTfBtRaCe')
    expect(body.error.error_subcode).toBe(entry.subcode)

    if (entry.details === undefined) {
      expect(body.error.error_data).toBeUndefined()
    } else {
      expect(body.error.error_data).toEqual({
        messaging_product: 'whatsapp',
        details: entry.details,
      })
    }
  })
})

describe('the catalogue and the exported codes stay in step', () => {
  it('covers every exported code, so a new one cannot arrive unpinned', () => {
    // Without this, adding an error code and forgetting to pin it would leave
    // its wording free to drift — the exact hole mutation testing found.
    expect(Object.values(ERROR_CODES).sort()).toEqual(
      Object.values(CATALOG)
        .map((entry) => entry.code)
        .sort(),
    )
  })

  it('names each code the same way the catalogue does', () => {
    for (const [name, entry] of Object.entries(CATALOG)) {
      expect(ERROR_CODES[name as keyof typeof ERROR_CODES], name).toBe(entry.code)
    }
  })
})

describe('overrides do not leak into the pinned contract', () => {
  it('replaces only the details when asked', () => {
    const body = new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
      details: 'template name (order_update) does not exist in en_US',
    }).toBody('t')

    expect(body.error.error_data?.details).toBe(
      'template name (order_update) does not exist in en_US',
    )
    // The message keeps its catalogue wording.
    expect(body.error.message).toBe(CATALOG['TEMPLATE_NOT_FOUND']!.message)
  })

  it('replaces only the message when asked', () => {
    const body = new GraphError(ERROR_CODES.INVALID_PARAMETER, {
      message: 'Unsupported post request',
    }).toBody('t')

    expect(body.error.message).toBe('(#100) Unsupported post request')
    expect(body.error.type).toBe('OAuthException')
  })

  it('renders Graph’s unsupported-request error: subcode 33, no prefix, no error_data', () => {
    const body = unsupportedRequest('get', '123').toBody('t')
    expect(body).toEqual({
      error: {
        message:
          "Unsupported get request. Object with ID '123' does not exist, cannot be loaded due to missing permissions, or does not support this operation. Please read the Graph API documentation at https://developers.facebook.com/docs/graph-api",
        type: 'GraphMethodException',
        code: 100,
        error_subcode: 33,
        fbtrace_id: 't',
      },
    })
  })

  it('keeps the code prefix on the Error message itself, for logs', () => {
    expect(new GraphError(ERROR_CODES.REENGAGEMENT).message).toBe('(#131047) Re-engagement message')
    expect(new GraphError(ERROR_CODES.REENGAGEMENT).name).toBe('GraphError')
  })
})

describe('an uncatalogued code', () => {
  it('still renders a complete, parseable envelope', () => {
    const body = new GraphError(999999).toBody('t')

    expect(body.error).toMatchObject({
      code: 999999,
      message: '(#999999) An unknown error occurred',
      type: 'OAuthException',
      fbtrace_id: 't',
    })
    expect(body.error.error_data).toEqual({
      messaging_product: 'whatsapp',
      details: 'An unknown error occurred',
    })
  })

  it('is treated as permanent — retrying an unknown failure is a guess', () => {
    expect(isRetriable(999999)).toBe(false)
  })

  it('maps to 400, the safest default for an unrecognised Graph error', () => {
    expect(new GraphError(999999).httpStatus).toBe(400)
  })
})
