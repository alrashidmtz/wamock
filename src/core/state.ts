import type { Template } from './templates.js'
import { templateKey } from './templates.js'
import type { App, OutboundMessage, PhoneNumber, Waba } from './types.js'

/**
 * All mock state, in memory, tenant-aware from day one.
 *
 * The app → WABA → phone number graph exists even in the single-tenant happy
 * path, because webhook signing depends on it: each webhook is signed with the
 * secret of the app that owns the delivering number (spec §5.2). Bolting that
 * on later would mean rewriting the signing path and every test that assumed a
 * single global secret. Seeding one of each keeps the simple case free.
 */

export interface SeedOptions {
  /** Secret of the seeded platform app. Signs webhooks for the seeded number. */
  appSecret: string
  appId?: string
  wabaId?: string
  phoneNumberId?: string
  /** Digits only. */
  displayPhoneNumber?: string
}

const DEFAULTS = {
  appId: 'APP_DEFAULT',
  wabaId: 'WABA_DEFAULT',
  phoneNumberId: 'PNID_DEFAULT',
  displayPhoneNumber: '15550001111',
} as const

export class MockState {
  readonly defaultAppId: string
  readonly defaultWabaId: string
  readonly defaultPhoneNumberId: string

  readonly #seed: SeedOptions
  #apps = new Map<string, App>()
  #wabas = new Map<string, Waba>()
  #phoneNumbers = new Map<string, PhoneNumber>()
  #templates = new Map<string, Template>()
  #outbound: OutboundMessage[] = []
  #seq = 0

  constructor(seed: SeedOptions) {
    this.#seed = seed
    this.defaultAppId = seed.appId ?? DEFAULTS.appId
    this.defaultWabaId = seed.wabaId ?? DEFAULTS.wabaId
    this.defaultPhoneNumberId = seed.phoneNumberId ?? DEFAULTS.phoneNumberId
    this.#applySeed()
  }

  // --- registration -------------------------------------------------------

  registerApp(app: App): void {
    this.#apps.set(app.appId, { ...app })
  }

  registerWaba(waba: Omit<Waba, 'subscribedApps'> & { subscribedApps?: Set<string> }): void {
    if (!this.#apps.has(waba.appId)) {
      throw new Error(`Cannot register WABA ${waba.wabaId}: unknown app ${waba.appId}`)
    }
    this.#wabas.set(waba.wabaId, {
      wabaId: waba.wabaId,
      appId: waba.appId,
      subscribedApps: new Set(waba.subscribedApps ?? []),
    })
  }

  /** Subscribe an app to a WABA's webhooks (`POST /{waba_id}/subscribed_apps`). */
  subscribeApp(wabaId: string, appId: string): void {
    const waba = this.#wabas.get(wabaId)
    if (!waba) throw new Error(`Cannot subscribe to unknown WABA ${wabaId}`)
    waba.subscribedApps.add(appId)
  }

  /**
   * Whether this WABA's owning app is subscribed. When false the mock delivers
   * nothing for its numbers — reproducing Meta's silence rather than inventing
   * an error that does not exist.
   */
  isSubscribed(wabaId: string): boolean {
    const waba = this.#wabas.get(wabaId)
    return waba !== undefined && waba.subscribedApps.has(waba.appId)
  }

  registerPhoneNumber(phoneNumber: PhoneNumber): void {
    if (!this.#wabas.has(phoneNumber.wabaId)) {
      throw new Error(
        `Cannot register phone number ${phoneNumber.phoneNumberId}: unknown WABA ${phoneNumber.wabaId}`,
      )
    }
    this.#phoneNumbers.set(phoneNumber.phoneNumberId, { ...phoneNumber })
  }

  // --- lookups ------------------------------------------------------------

  app(appId: string): App | undefined {
    return this.#apps.get(appId)
  }

  waba(wabaId: string): Waba | undefined {
    return this.#wabas.get(wabaId)
  }

  phoneNumber(phoneNumberId: string): PhoneNumber | undefined {
    return this.#phoneNumbers.get(phoneNumberId)
  }

  /** Every hosted number. Carries no secrets — safe to expose for inspection. */
  phoneNumbers(): PhoneNumber[] {
    return [...this.#phoneNumbers.values()]
  }

  /** Every hosted WABA. Carries no secrets — safe to expose for inspection. */
  wabas(): Waba[] {
    return [...this.#wabas.values()]
  }

  /** Replace a phone number's mutable attributes (quality, tier). */
  updatePhoneNumber(phoneNumberId: string, patch: Partial<PhoneNumber>): void {
    const existing = this.#phoneNumbers.get(phoneNumberId)
    if (!existing) return
    this.#phoneNumbers.set(phoneNumberId, { ...existing, ...patch })
  }

  /**
   * Walk number → WABA → app to find the secret this number's webhooks are
   * signed with. `undefined` means the mock does not host that number, which
   * callers surface as a Graph error rather than silently signing with a
   * fallback secret.
   */
  appSecretForPhoneNumber(phoneNumberId: string): string | undefined {
    const waba = this.#wabas.get(this.#phoneNumbers.get(phoneNumberId)?.wabaId ?? '')
    return this.#apps.get(waba?.appId ?? '')?.appSecret
  }

  // --- templates ----------------------------------------------------------

  putTemplate(template: Template): void {
    this.#templates.set(templateKey(template.wabaId, template.name, template.language), {
      ...template,
    })
  }

  /**
   * Exact match on all three parts. There is deliberately no "find by name"
   * fallback: falling back to another language is precisely the leniency that
   * hides the per-language approval trap.
   */
  template(wabaId: string, name: string, language: string): Template | undefined {
    return this.#templates.get(templateKey(wabaId, name, language))
  }

  templatesForWaba(wabaId: string): Template[] {
    return [...this.#templates.values()].filter((t) => t.wabaId === wabaId)
  }

  /** Meta deletes by name, taking every language with it. Returns how many went. */
  deleteTemplatesByName(wabaId: string, name: string): number {
    let removed = 0
    for (const [key, template] of this.#templates) {
      if (template.wabaId === wabaId && template.name === name) {
        this.#templates.delete(key)
        removed++
      }
    }
    return removed
  }

  // --- traffic ------------------------------------------------------------

  recordOutbound(message: OutboundMessage): void {
    this.#outbound.push(message)
  }

  /** Copy, so inspection can never corrupt history. */
  outbound(): OutboundMessage[] {
    return [...this.#outbound]
  }

  // --- determinism --------------------------------------------------------

  /** Monotonic counter behind every generated id. Starts at 1 after a reset. */
  nextSeq(): number {
    return ++this.#seq
  }

  /**
   * Back to the seed — not back to "whatever was registered". Tenants added
   * during a test are dropped, so the next test starts from the same graph and
   * the same id sequence.
   */
  reset(): void {
    this.#apps = new Map()
    this.#wabas = new Map()
    this.#phoneNumbers = new Map()
    this.#templates = new Map()
    this.#outbound = []
    this.#seq = 0
    this.#applySeed()
  }

  #applySeed(): void {
    this.registerApp({ appId: this.defaultAppId, appSecret: this.#seed.appSecret })
    // The seeded WABA arrives already subscribed: the single-tenant case must
    // not have to know that subscriptions exist. Unsubscribed WABAs are opt-in
    // via the embedded-signup control endpoint.
    this.registerWaba({
      wabaId: this.defaultWabaId,
      appId: this.defaultAppId,
      subscribedApps: new Set([this.defaultAppId]),
    })
    this.registerPhoneNumber({
      phoneNumberId: this.defaultPhoneNumberId,
      wabaId: this.defaultWabaId,
      displayPhoneNumber: this.#seed.displayPhoneNumber ?? DEFAULTS.displayPhoneNumber,
    })
  }
}
