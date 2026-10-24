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

/** How a template's variables are written: `{{1}}` or `{{first_name}}`. */
export const PARAMETER_FORMATS = ['POSITIONAL', 'NAMED'] as const
export type ParameterFormat = (typeof PARAMETER_FORMATS)[number]

/**
 * Every language code Meta's "Supported Languages" page lists for templates
 * (111 codes, read 2026-10-24). Codes are case-sensitive: `es_mx` is not `es_MX`.
 */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([
  'af', 'sq', 'ar', 'ar_EG', 'ar_AE', 'ar_LB', 'ar_MA', 'ar_QA', 'az', 'be_BY', 'bn',
  'bn_IN', 'bg', 'ca', 'zh_CN', 'zh_HK', 'zh_TW', 'hr', 'cs', 'da', 'prs_AF', 'nl',
  'nl_BE', 'en', 'en_GB', 'en_US', 'en_AE', 'en_AU', 'en_CA', 'en_GH', 'en_IE', 'en_IN',
  'en_JM', 'en_MY', 'en_NZ', 'en_QA', 'en_SG', 'en_UG', 'en_ZA', 'et', 'fil', 'fi', 'fr',
  'fr_BE', 'fr_CA', 'fr_CH', 'fr_CI', 'fr_MA', 'ka', 'de', 'de_AT', 'de_CH', 'el', 'gu',
  'ha', 'he', 'hi', 'hu', 'id', 'ga', 'it', 'ja', 'kn', 'kk', 'rw_RW', 'ko', 'ky_KG', 'lo',
  'lv', 'lt', 'mk', 'ms', 'ml', 'mr', 'nb', 'ps_AF', 'fa', 'pl', 'pt_BR', 'pt_PT', 'pa',
  'ro', 'ru', 'sr', 'si_LK', 'sk', 'sl', 'es', 'es_AR', 'es_CL', 'es_CO', 'es_CR', 'es_DO',
  'es_EC', 'es_HN', 'es_MX', 'es_PA', 'es_PE', 'es_ES', 'es_UY', 'sw', 'sv', 'ta', 'te',
  'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zu',
])

/** Template names are limited to 512 characters. */
export const TEMPLATE_NAME_MAX = 512

/** Meta accepts lowercase alphanumerics and underscores only. */
export const TEMPLATE_NAME_PATTERN = /^[a-z0-9_]+$/

export interface Template {
  id: string
  wabaId: string
  name: string
  language: string
  category: TemplateCategory
  status: TemplateStatus
  parameterFormat: ParameterFormat
  components: unknown[]
  /**
   * Quality pauses so far. The first lasts 3 hours, the second 6, and the
   * third disables the template for good.
   */
  pauses: number
}

/** A template as `GET /{waba_id}/message_templates` lists it. */
export interface TemplateView {
  name: string
  parameter_format: ParameterFormat
  components: unknown[]
  language: string
  status: TemplateStatus
  category: TemplateCategory
  id: string
}

export const toTemplateView = (template: Template): TemplateView => ({
  name: template.name,
  parameter_format: template.parameterFormat,
  components: template.components,
  language: template.language,
  status: template.status,
  category: template.category,
  id: template.id,
})

export const templateKey = (wabaId: string, name: string, language: string): string =>
  `${wabaId}:${name}:${language}`
