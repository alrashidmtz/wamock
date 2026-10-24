import type { Template } from './templates.js'
import { templateKey } from './templates.js'
import type {
  App,
  Business,
  InboundRecord,
  MessagingTier,
  OutboundMessage,
  PhoneNumber,
  ReadReceipt,
  Waba,
} from './types.js'

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
  /** Cap on recorded outbound messages. See `recordOutbound`. */
  maxRecordedMessages?: number
}

/**
 * Far above any realistic test, low enough that a forgotten server does not
 * exhaust memory. Roughly a few MB of retained messages.
 */
const DEFAULT_MAX_RECORDED = 10_000

/** The seeded app's name, beside the seeded number's `verified_name`. */
const DEFAULT_APP_NAME = 'wamock Test App'

const DEFAULTS = {
  businessId: 'BUSINESS_DEFAULT',
  appId: 'APP_DEFAULT',
  wabaId: 'WABA_DEFAULT',
  phoneNumberId: 'PNID_DEFAULT',
  displayPhoneNumber: '15550001111',
} as const

export class MockState {
  readonly defaultBusinessId: string = DEFAULTS.businessId
  readonly defaultAppId: string
  readonly defaultWabaId: string
  readonly defaultPhoneNumberId: string

  readonly #seed: SeedOptions
  #businesses = new Map<string, Business>()
  #apps = new Map<string, App>()
  #wabas = new Map<string, Waba>()
  #phoneNumbers = new Map<string, PhoneNumber>()
  #templates = new Map<string, Template>()
  /** Ids other collaborators minted (media), in the one space Graph ids share. */
  #reservedIds = new Set<string>()
  #outbound: OutboundMessage[] = []
  #inbound = new Map<string, InboundRecord>()
  #readReceipts: ReadReceipt[] = []
  #droppedOutbound = 0
  readonly #maxRecorded: number
  #seq = 0

  constructor(seed: SeedOptions) {
    this.#seed = seed
    this.defaultAppId = seed.appId ?? DEFAULTS.appId
    this.defaultWabaId = seed.wabaId ?? DEFAULTS.wabaId
    this.defaultPhoneNumberId = seed.phoneNumberId ?? DEFAULTS.phoneNumberId
    this.#maxRecorded = seed.maxRecordedMessages ?? DEFAULT_MAX_RECORDED
    this.#applySeed()
  }

  // --- registration -------------------------------------------------------

  /**
   * Unlimited unless told otherwise: the single-tenant quickstart must never be
   * blocked by a cap it did not ask for.
   */
  registerBusiness(businessId: string, messagingTier: MessagingTier = 'TIER_UNLIMITED'): void {
    this.#assertFree(businessId, 'business')
    this.#businesses.set(businessId, { businessId, messagingTier })
  }

  registerApp(app: App): void {
    this.#assertFree(app.appId, 'app')
    this.#apps.set(app.appId, { ...app })
  }

  /**
   * Graph ids are one space, whoever chooses them: a test, an option, or the
   * mock. An id another kind of object already holds is refused before
   * anything changes; re-registering the same object updates it.
   */
  #assertFree(id: string, kind: 'business' | 'app' | 'waba' | 'phone' | 'media' | 'template', templateKey?: string): void {
    const holders: Array<[string, boolean]> = [
      ['business', this.#businesses.has(id)],
      ['app', this.#apps.has(id)],
      ['waba', this.#wabas.has(id)],
      ['phone', this.#phoneNumbers.has(id)],
      ['media', this.#reservedIds.has(id)],
    ]
    const other = holders.find(([holder, held]) => held && holder !== kind)?.[0]
    const template = [...this.#templates.entries()].find(([key, t]) => t.id === id && !(kind === 'template' && key === templateKey))
    if (other !== undefined || template !== undefined) {
      throw new Error(`Cannot register ${kind} ${id}: a ${other ?? 'template'} already has that id`)
    }
  }

  /** Without a `businessId` the WABA joins the default portfolio, and shares its limit. */
  registerWaba(
    waba: Omit<Waba, 'subscribedApps' | 'businessId'> & {
      subscribedApps?: Set<string>
      businessId?: string
    },
  ): void {
    this.#assertFree(waba.wabaId, 'waba')
    const businessId = waba.businessId ?? this.defaultBusinessId
    if (!this.#apps.has(waba.appId)) {
      throw new Error(`Cannot register WABA ${waba.wabaId}: unknown app ${waba.appId}`)
    }
    if (!this.#businesses.has(businessId)) {
      throw new Error(`Cannot register WABA ${waba.wabaId}: unknown business ${businessId}`)
    }
    this.#wabas.set(waba.wabaId, {
      wabaId: waba.wabaId,
      appId: waba.appId,
      businessId,
      subscribedApps: new Set(waba.subscribedApps ?? []),
    })
  }

  /**
   * Subscribe an app to a WABA's webhooks (`POST /{waba_id}/subscribed_apps`).
   * Subscribing again replaces the callback override, or clears it.
   */
  subscribeApp(wabaId: string, appId: string, callbackOverride?: { url: string; verifyToken: string }): void {
    const waba = this.#wabas.get(wabaId)
    if (!waba) throw new Error(`Cannot subscribe to unknown WABA ${wabaId}`)
    waba.subscribedApps.add(appId)
    if (callbackOverride) waba.callbackOverride = callbackOverride
    else delete waba.callbackOverride
  }

  /** A number's own callback override, or none to remove it. */
  setPhoneCallbackOverride(phoneNumberId: string, callbackOverride: { url: string; verifyToken: string } | undefined): void {
    const phoneNumber = this.#phoneNumbers.get(phoneNumberId)
    if (!phoneNumber) throw new Error(`Cannot configure unknown phone number ${phoneNumberId}`)
    if (callbackOverride) phoneNumber.callbackOverride = callbackOverride
    else delete phoneNumber.callbackOverride
  }

  /** `DELETE /{waba_id}/subscribed_apps`: deliveries stop at once. */
  unsubscribeApp(wabaId: string, appId: string): void {
    const waba = this.#wabas.get(wabaId)
    if (!waba) throw new Error(`Cannot unsubscribe from unknown WABA ${wabaId}`)
    waba.subscribedApps.delete(appId)
    delete waba.callbackOverride
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
    this.#assertFree(phoneNumber.phoneNumberId, 'phone')
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

  /** The business portfolio that owns this number, through its WABA. */
  businessIdOf(phoneNumberId: string): string | undefined {
    return this.#wabas.get(this.#phoneNumbers.get(phoneNumberId)?.wabaId ?? '')?.businessId
  }

  /** Authentication-international eligibility and primary location, as Meta sets them. */
  updateBusiness(businessId: string, change: Partial<Pick<Business, 'authInternational' | 'primaryLocation'>>): void {
    const business = this.#businesses.get(businessId)
    if (!business) throw new Error(`Cannot update unknown business ${businessId}`)
    this.#businesses.set(businessId, { ...business, ...change })
  }

  /**
   * Whether any object already answers to this id. Graph ids are one space:
   * a number minted with a WABA's id would let that WABA's token reach it.
   */
  isIdTaken(id: string): boolean {
    return (
      this.#phoneNumbers.has(id) ||
      this.#wabas.has(id) ||
      this.#businesses.has(id) ||
      this.#apps.has(id) ||
      this.#reservedIds.has(id) ||
      [...this.#templates.values()].some((template) => template.id === id)
    )
  }

  /** Claim an id held outside this state (media), so nothing else is minted with it. */
  reserveId(id: string): void {
    this.#assertFree(id, 'media')
    this.#reservedIds.add(id)
  }

  business(businessId: string): Business | undefined {
    return this.#businesses.get(businessId)
  }

  businesses(): Business[] {
    return [...this.#businesses.values()]
  }

  setMessagingTier(businessId: string, messagingTier: MessagingTier): void {
    const existing = this.#businesses.get(businessId)
    if (existing) this.#businesses.set(businessId, { ...existing, messagingTier })
  }

  /** Every hosted WABA. Carries no secrets — safe to expose for inspection. */
  wabas(): Waba[] {
    return [...this.#wabas.values()]
  }

  /** Replace a phone number's mutable attributes (quality). */
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
    return this.appSecretForWaba(this.#phoneNumbers.get(phoneNumberId)?.wabaId ?? '')
  }

  /** The secret of the app that owns this WABA, which signs its webhooks. */
  appSecretForWaba(wabaId: string): string | undefined {
    return this.#apps.get(this.#wabas.get(wabaId)?.appId ?? '')?.appSecret
  }

  // --- templates ----------------------------------------------------------

  putTemplate(template: Template): void {
    const key = templateKey(template.wabaId, template.name, template.language)
    this.#assertFree(template.id, 'template', key)
    this.#templates.set(key, { ...template })
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
    // Oldest-first eviction. A mock left running for a demo or a long CI job
    // would otherwise grow until the process dies; the cap is far above any
    // real test and the drop count is reported so truncation is never silent.
    if (this.#outbound.length > this.#maxRecorded) {
      this.#outbound.shift()
      this.#droppedOutbound++
    }
  }

  /**
   * Remember a customer's message by id, for mark-as-read. Capped like the
   * outbound log, oldest first, so a long-running server cannot grow forever.
   */
  recordInbound(message: InboundRecord): void {
    this.#inbound.set(message.id, { ...message })
    if (this.#inbound.size > this.#maxRecorded) {
      const oldest = this.#inbound.keys().next().value
      if (oldest !== undefined) this.#inbound.delete(oldest)
    }
  }

  inbound(messageId: string): InboundRecord | undefined {
    return this.#inbound.get(messageId)
  }

  recordReadReceipt(receipt: ReadReceipt): void {
    this.#readReceipts.push({ ...receipt })
    if (this.#readReceipts.length > this.#maxRecorded) this.#readReceipts.shift()
  }

  /** Copy, so inspection can never corrupt history. */
  readReceipts(): ReadReceipt[] {
    return this.#readReceipts.map((receipt) => ({ ...receipt }))
  }

  /** Copy, so inspection can never corrupt history. */
  outbound(): OutboundMessage[] {
    return [...this.#outbound]
  }

  /** How many recorded messages were evicted by the cap. Surfaced in `/__mock/state`. */
  droppedOutbound(): number {
    return this.#droppedOutbound
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
    this.#businesses = new Map()
    this.#apps = new Map()
    this.#wabas = new Map()
    this.#phoneNumbers = new Map()
    this.#templates = new Map()
    this.#reservedIds = new Set()
    this.#outbound = []
    this.#inbound = new Map()
    this.#readReceipts = []
    this.#droppedOutbound = 0
    this.#seq = 0
    this.#applySeed()
  }

  #applySeed(): void {
    this.registerBusiness(this.defaultBusinessId)
    this.registerApp({ appId: this.defaultAppId, appSecret: this.#seed.appSecret, name: DEFAULT_APP_NAME })
    // The seeded WABA arrives already subscribed: the single-tenant case must
    // not have to know that subscriptions exist. Unsubscribed WABAs are opt-in
    // via the embedded-signup control endpoint.
    this.registerWaba({
      wabaId: this.defaultWabaId,
      appId: this.defaultAppId,
      businessId: this.defaultBusinessId,
      subscribedApps: new Set([this.defaultAppId]),
    })
    this.registerPhoneNumber({
      phoneNumberId: this.defaultPhoneNumberId,
      wabaId: this.defaultWabaId,
      displayPhoneNumber: this.#seed.displayPhoneNumber ?? DEFAULTS.displayPhoneNumber,
    })
  }
}
