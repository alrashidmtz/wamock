import { createHash } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { requirePhoneNumber, requireWaba } from '../core/guards.js'
import { freshId } from '../core/ids.js'
import { includesCallingCode } from '../core/national-lengths.js'
import { normalizeWaId } from '../core/phone.js'
import type { PhoneNumber } from '../core/types.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'

/**
 * Putting a business number on Cloud API, in Meta's four steps ("Registering
 * business phone numbers"): create it on a WABA, request a code, verify it,
 * register it. Embedded Signup does the first three when the customer adds a
 * number; registering is always the partner's, and a number that is not
 * registered cannot send (133010).
 */

/** "Limited to 10 requests per business number in a 72-hour moving window." */
const REGISTRATION_LIMIT = 10
const REGISTRATION_WINDOW_MS = 72 * 60 * 60 * 1000

export class RegistrationService {
  readonly #context: MockContext
  /** The code the last `request_code` "sent" to each number. */
  #codes = new Map<string, string>()
  /** When each register/deregister call was made, per number, for the 72h limit. */
  #attempts = new Map<string, number[]>()
  /** Until when a number that hit the limit stays locked. */
  #lockedUntil = new Map<string, number>()

  constructor(context: MockContext) {
    this.#context = context
  }

  /** `POST /{waba_id}/phone_numbers`: a new, unverified number on the WABA. */
  create(wabaId: string, body: Record<string, unknown>): { id: string } {
    const { state } = this.#context
    requireWaba(this.#context, wabaId, 'post')
    const cc = body['cc']
    const number = body['phone_number']
    const verifiedName = body['verified_name']
    for (const [name, value] of [['cc', cc], ['phone_number', number], ['verified_name', verifiedName]] as const) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `Param ${name} is required` })
      }
    }
    const code = (cc as string).trim()
    const digits = (number as string).replace(/[\s()+-]/g, '')
    const invalid = () =>
      new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param cc and phone_number must form a valid phone number' })
    // The format first: only digits reach the length table.
    if (!/^\d{1,3}$/.test(code) || !/^\d+$/.test(digits)) throw invalid()
    // "The phone number, with or without the country calling code": which
    // one, the national number lengths decide (see includesCallingCode).
    const full = includesCallingCode(code, digits) ? digits : `${code}${digits}`
    if (normalizeWaId(full) === null) throw invalid()
    const id = freshId(`PNID_${state.nextSeq()}`, (taken) => state.isIdTaken(taken))
    state.registerPhoneNumber({
      phoneNumberId: id,
      wabaId,
      displayPhoneNumber: full,
      verifiedName: verifiedName as string,
      verification: 'UNVERIFIED',
      registered: false,
    })
    return { id }
  }

  /**
   * `POST /{phone_number_id}/request_code`. The code is derived from the
   * counter so runs repeat; a test reads it with `verificationCode()`, where
   * a person would read the SMS.
   */
  requestCode(phoneNumberId: string, query: Record<string, unknown>): { success: true } {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    if (query['code_method'] !== 'SMS' && query['code_method'] !== 'VOICE') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param code_method must be one of {SMS, VOICE}' })
    }
    if (typeof query['language'] !== 'string' || query['language'] === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param language is required' })
    }
    // Meta: "If the phone number has already been verified, calling the
    // request_code endpoint returns HTTP 400 with error code 136024."
    if (isVerified(phoneNumber)) throw new GraphError(ERROR_CODES.ALREADY_VERIFIED)
    const digest = createHash('sha256').update(`verify:${phoneNumberId}:${this.#context.state.nextSeq()}`).digest()
    this.#codes.set(phoneNumberId, String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0'))
    return { success: true }
  }

  /** The code the last `request_code` sent, as the SMS would read it. */
  verificationCode(phoneNumberId: string): string | undefined {
    return this.#codes.get(phoneNumberId)
  }

  /**
   * `POST /{phone_number_id}/verify_code`. Meta's error code reference has no
   * entry for a wrong code; wamock answers Graph's generic invalid parameter.
   */
  verifyCode(phoneNumberId: string, query: Record<string, unknown>): { success: true } {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    const sent = this.#codes.get(phoneNumberId)
    const code = query['code']
    if (typeof code !== 'string' || code === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param code is required' })
    }
    if (sent === undefined || code !== sent) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: sent === undefined ? 'No verification code was requested for this number' : 'Param code is not the code that was sent',
      })
    }
    this.#codes.delete(phoneNumberId)
    this.#update(phoneNumber, { verification: 'VERIFIED' })
    return { success: true }
  }

  /**
   * `POST /{phone_number_id}/register`. The pin becomes the number's
   * two-step verification PIN the first time, and must match it after.
   */
  register(phoneNumberId: string, body: Record<string, unknown>): { success: true } {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    if (body['messaging_product'] !== 'whatsapp') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: "Param messaging_product must be 'whatsapp'" })
    }
    const pin = body['pin']
    if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param pin must be a 6-digit number' })
    }
    this.#countAttempt(phoneNumberId)
    if (!isVerified(phoneNumber)) throw new GraphError(ERROR_CODES.NOT_VERIFIED)
    if (phoneNumber.pin !== undefined && phoneNumber.pin !== pin) throw new GraphError(ERROR_CODES.PIN_INCORRECT)
    this.#update(phoneNumber, { registered: true, pin })
    return { success: true }
  }

  /** `POST /{phone_number_id}/deregister`: off Cloud API until registered again. */
  deregister(phoneNumberId: string): { success: true } {
    const phoneNumber = requirePhoneNumber(this.#context, phoneNumberId, 'post')
    this.#countAttempt(phoneNumberId)
    this.#update(phoneNumber, { registered: false })
    return { success: true }
  }

  clear(): void {
    this.#codes = new Map()
    this.#attempts = new Map()
    this.#lockedUntil = new Map()
  }

  /**
   * 133016 once 10 register/deregister calls fall in the last 72 hours, and
   * then, Meta says, "the API prevents the number from being registered for
   * the next 72 hours": the lock runs from the refusal, not from the first call.
   */
  #countAttempt(phoneNumberId: string): void {
    const now = this.#context.clock.now()
    if (now < (this.#lockedUntil.get(phoneNumberId) ?? 0)) throw new GraphError(ERROR_CODES.REGISTRATION_LIMIT)
    const recent = (this.#attempts.get(phoneNumberId) ?? []).filter((at) => now - at < REGISTRATION_WINDOW_MS)
    if (recent.length >= REGISTRATION_LIMIT) {
      this.#attempts.set(phoneNumberId, [])
      this.#lockedUntil.set(phoneNumberId, now + REGISTRATION_WINDOW_MS)
      throw new GraphError(ERROR_CODES.REGISTRATION_LIMIT)
    }
    this.#attempts.set(phoneNumberId, [...recent, now])
  }

  #update(phoneNumber: PhoneNumber, change: Partial<PhoneNumber>): void {
    this.#context.state.registerPhoneNumber({ ...phoneNumber, ...change })
  }
}

/** A number is verified unless it was created unverified and not verified since. */
export const isVerified = (phoneNumber: PhoneNumber): boolean => phoneNumber.verification !== 'UNVERIFIED'

/** A number can send unless it was created or deregistered and not registered since. */
export const isRegistered = (phoneNumber: PhoneNumber): boolean => phoneNumber.registered !== false
