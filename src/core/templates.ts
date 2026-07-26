/**
 * Message templates.
 *
 * The behaviour that matters — and that naive mocks skip — is that **approval
 * is per language**. `order_update` in `es_MX` being APPROVED tells you nothing
 * about `order_update` in `en_US`. A team that approves one language, tests
 * against a mock keyed only by name, and then ships a multi-language flow finds
 * out from a 132001 in production.
 *
 * So the store is keyed by `wabaId:name:language`, and every lookup on the send
 * path requires an exact match on all three.
 */

export const TEMPLATE_STATUSES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
] as const
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number]

export const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number]

/** Meta accepts lowercase alphanumerics and underscores only. */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/

export interface Template {
  id: string
  wabaId: string
  name: string
  language: string
  category: TemplateCategory
  status: TemplateStatus
  components: unknown[]
}

export const templateKey = (wabaId: string, name: string, language: string): string =>
  `${wabaId}:${name}:${language}`
