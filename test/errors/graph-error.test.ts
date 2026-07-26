import { describe, expect, it } from 'vitest'

import { ERROR_CODES, GraphError, isRetriable } from '../../src/errors/graph-error.js'

describe('GraphError — Meta-shaped error bodies', () => {
  it('renders the envelope Meta actually sends', () => {
    const body = new GraphError(ERROR_CODES.REENGAGEMENT).toBody('AtEsT01')

    expect(body).toMatchObject({
      error: {
        code: 131047,
        type: 'OAuthException',
        fbtrace_id: 'AtEsT01',
        error_data: { messaging_product: 'whatsapp' },
      },
    })
    expect(body.error.message).toContain('131047')
  })

  it('prefixes the message with the code in parentheses, like Meta', () => {
    // Integrations regex this out of logs; the format is part of the contract.
    expect(new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND).toBody('t').error.message).toMatch(
      /^\(#132001\)/,
    )
  })

  it('carries caller-supplied details into error_data.details', () => {
    const body = new GraphError(ERROR_CODES.TEMPLATE_NOT_FOUND, {
      details: 'template name (order_update) does not exist in en_US',
    }).toBody('t')

    expect(body.error.error_data?.details).toBe(
      'template name (order_update) does not exist in en_US',
    )
  })

  it('omits error_data on token errors — Meta does not attach it there', () => {
    const body = new GraphError(ERROR_CODES.TOKEN_EXPIRED).toBody('t')
    expect(body.error.error_data).toBeUndefined()
    expect(body.error.error_subcode).toBe(463)
  })
})

describe('GraphError — HTTP status mapping', () => {
  it.each([
    [ERROR_CODES.INVALID_PARAMETER, 400],
    [ERROR_CODES.REENGAGEMENT, 400],
    [ERROR_CODES.TEMPLATE_PAUSED, 400],
    [ERROR_CODES.UNDELIVERABLE, 400],
    [ERROR_CODES.SPAM_RATE_LIMIT, 400],
    [ERROR_CODES.TOKEN_EXPIRED, 401],
    [ERROR_CODES.TOKEN_INVALID, 401],
    [ERROR_CODES.RATE_LIMIT, 429],
    [ERROR_CODES.INTERNAL, 500],
  ])('code %i maps to HTTP %i', (code, status) => {
    expect(new GraphError(code).httpStatus).toBe(status)
  })
})

describe('isRetriable — spec §7 retry semantics', () => {
  it('marks the throughput rate limit as retriable', () => {
    expect(isRetriable(ERROR_CODES.RATE_LIMIT)).toBe(true)
  })

  it('marks the spam/quality limit as retriable', () => {
    expect(isRetriable(ERROR_CODES.SPAM_RATE_LIMIT)).toBe(true)
  })

  it('marks a transient Meta-side failure as retriable', () => {
    expect(isRetriable(ERROR_CODES.INTERNAL)).toBe(true)
  })

  it('marks the 24h window error as permanent — retrying can only fail again', () => {
    expect(isRetriable(ERROR_CODES.REENGAGEMENT)).toBe(false)
  })

  it('marks an expired token as permanent — it needs re-auth, not backoff', () => {
    expect(isRetriable(ERROR_CODES.TOKEN_EXPIRED)).toBe(false)
  })
})

describe('GraphError — unknown codes', () => {
  it('still renders a valid envelope for a code outside the catalog', () => {
    const body = new GraphError(999999).toBody('t')
    expect(body.error.code).toBe(999999)
    expect(typeof body.error.message).toBe('string')
  })
})
