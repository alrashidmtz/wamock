import { describe, expect, it } from 'vitest'

import { ERROR_CODES, GraphError, isRetriable } from '../../src/errors/graph-error.js'

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
    message: '(#0) Invalid OAuth access token - Cannot parse access token',
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
    message: '(#190) Error validating access token: Session has expired.',
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
  TEMPLATE_PAUSED: {
    code: 132015,
    httpStatus: 400,
    retriable: false,
    message: '(#132015) Template is paused due to low quality',
    type: 'OAuthException',
    subcode: undefined,
    details: 'Message failed to send because the template used has been paused for quality reasons.',
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
