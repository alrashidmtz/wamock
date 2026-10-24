/**
 * Phone number handling, and the asymmetry wamock reproduces on purpose.
 *
 * Meta writes the SAME business number two ways depending on where you meet it:
 *   - in every webhook, `metadata.display_phone_number` → digits only, like
 *     `wa_id`: `15550001111`
 *   - in the Graph API, `display_phone_number`          → `+` and grouped:
 *     `+1 555-000-1111`
 *
 * An integration that stores the number from the Graph lookup at connect time
 * and matches it against webhooks later has two keys for one number. That
 * breaks routing and dedupe, and only shows up against real traffic.
 *
 * Until 0.5.0 wamock put a `+` on the webhook side. That came from a
 * hand-written fixture, not captured traffic: Meta's examples and 107 public
 * captures against 6 say digits only.
 */

/** E.164 allows at most 15 digits; anything longer is not a real number. */
const MAX_DIGITS = 15
/** Shortest plausible national+country number. Below this Meta rejects the send. */
const MIN_DIGITS = 7

/**
 * Reduce anything a caller might send in `to` to Meta's `wa_id` form: digits
 * only, no `+`, no punctuation. Returns `null` when the input could not be a
 * phone number — the caller maps that to a Graph error rather than guessing.
 */
export function normalizeWaId(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null
  return digits
}

/**
 * Every country calling code in ITU's E.164 plan, from the `datasets/country-codes`
 * dataset (ITU/ISO derived), plus four codes it lacks: 247 Ascension, 290 Saint
 * Helena, 381 Serbia and 383 Kosovo (`XK`, the code ISO reserves for it).
 * Non-geographic codes such as Inmarsat's 870 are left out: they have no
 * country to put in a BSUID. Where several territories share a code (`1`, `7`,
 * `44`, `358`…) the main one stands for all of them. E.164 codes are
 * prefix-free by design (no code starts another), so the first match is the
 * only match and order does not matter; a test holds the table to that.
 */
export const COUNTRY_BY_CALLING_CODE: Array<[string, string]> = [
  ['1', 'US'], ['7', 'RU'], ['20', 'EG'], ['27', 'ZA'], ['30', 'GR'], ['31', 'NL'],
  ['32', 'BE'], ['33', 'FR'], ['34', 'ES'], ['36', 'HU'], ['39', 'IT'], ['40', 'RO'],
  ['41', 'CH'], ['43', 'AT'], ['44', 'GB'], ['45', 'DK'], ['46', 'SE'], ['47', 'NO'],
  ['48', 'PL'], ['49', 'DE'], ['51', 'PE'], ['52', 'MX'], ['53', 'CU'], ['54', 'AR'],
  ['55', 'BR'], ['56', 'CL'], ['57', 'CO'], ['58', 'VE'], ['60', 'MY'], ['61', 'AU'],
  ['62', 'ID'], ['63', 'PH'], ['64', 'NZ'], ['65', 'SG'], ['66', 'TH'], ['81', 'JP'],
  ['82', 'KR'], ['84', 'VN'], ['86', 'CN'], ['90', 'TR'], ['91', 'IN'], ['92', 'PK'],
  ['93', 'AF'], ['94', 'LK'], ['95', 'MM'], ['98', 'IR'], ['211', 'SS'], ['212', 'MA'],
  ['213', 'DZ'], ['216', 'TN'], ['218', 'LY'], ['220', 'GM'], ['221', 'SN'], ['222', 'MR'],
  ['223', 'ML'], ['224', 'GN'], ['225', 'CI'], ['226', 'BF'], ['227', 'NE'], ['228', 'TG'],
  ['229', 'BJ'], ['230', 'MU'], ['231', 'LR'], ['232', 'SL'], ['233', 'GH'], ['234', 'NG'],
  ['235', 'TD'], ['236', 'CF'], ['237', 'CM'], ['238', 'CV'], ['239', 'ST'], ['240', 'GQ'],
  ['241', 'GA'], ['242', 'CG'], ['243', 'CD'], ['244', 'AO'], ['245', 'GW'], ['246', 'IO'], ['247', 'AC'],
  ['248', 'SC'], ['249', 'SD'], ['250', 'RW'], ['251', 'ET'], ['252', 'SO'], ['253', 'DJ'],
  ['254', 'KE'], ['255', 'TZ'], ['256', 'UG'], ['257', 'BI'], ['258', 'MZ'], ['260', 'ZM'],
  ['261', 'MG'], ['262', 'RE'], ['263', 'ZW'], ['264', 'NA'], ['265', 'MW'], ['266', 'LS'],
  ['267', 'BW'], ['268', 'SZ'], ['269', 'KM'], ['290', 'SH'], ['291', 'ER'], ['297', 'AW'], ['298', 'FO'],
  ['299', 'GL'], ['350', 'GI'], ['351', 'PT'], ['352', 'LU'], ['353', 'IE'], ['354', 'IS'],
  ['355', 'AL'], ['356', 'MT'], ['357', 'CY'], ['358', 'FI'], ['359', 'BG'], ['370', 'LT'],
  ['371', 'LV'], ['372', 'EE'], ['373', 'MD'], ['374', 'AM'], ['375', 'BY'], ['376', 'AD'],
  ['377', 'MC'], ['378', 'SM'], ['380', 'UA'], ['381', 'RS'], ['382', 'ME'], ['383', 'XK'], ['385', 'HR'], ['386', 'SI'],
  ['387', 'BA'], ['389', 'MK'], ['420', 'CZ'], ['421', 'SK'], ['423', 'LI'], ['500', 'FK'],
  ['501', 'BZ'], ['502', 'GT'], ['503', 'SV'], ['504', 'HN'], ['505', 'NI'], ['506', 'CR'],
  ['507', 'PA'], ['508', 'PM'], ['509', 'HT'], ['590', 'GP'], ['591', 'BO'], ['592', 'GY'],
  ['593', 'EC'], ['594', 'GF'], ['595', 'PY'], ['596', 'MQ'], ['597', 'SR'], ['598', 'UY'],
  ['599', 'CW'], ['670', 'TL'], ['672', 'NF'], ['673', 'BN'], ['674', 'NR'], ['675', 'PG'],
  ['676', 'TO'], ['677', 'SB'], ['678', 'VU'], ['679', 'FJ'], ['680', 'PW'], ['681', 'WF'],
  ['682', 'CK'], ['683', 'NU'], ['685', 'WS'], ['686', 'KI'], ['687', 'NC'], ['688', 'TV'],
  ['689', 'PF'], ['690', 'TK'], ['691', 'FM'], ['692', 'MH'], ['850', 'KP'], ['852', 'HK'],
  ['853', 'MO'], ['855', 'KH'], ['856', 'LA'], ['880', 'BD'], ['886', 'TW'],
  ['960', 'MV'], ['961', 'LB'], ['962', 'JO'], ['963', 'SY'], ['964', 'IQ'], ['965', 'KW'],
  ['966', 'SA'], ['967', 'YE'], ['968', 'OM'], ['970', 'PS'], ['971', 'AE'], ['972', 'IL'],
  ['973', 'BH'], ['974', 'QA'], ['975', 'BT'], ['976', 'MN'], ['977', 'NP'], ['992', 'TJ'],
  ['993', 'TM'], ['994', 'AZ'], ['995', 'GE'], ['996', 'KG'], ['998', 'UZ'],
]

/** The ISO country of a number, from its calling code; `ZZ` when unknown. */
export const countryOf = (waId: string): string =>
  COUNTRY_BY_CALLING_CODE.find(([code]) => waId.startsWith(code))?.[1] ?? 'ZZ'

/** The calling code a number starts with, if the table knows it. */
export const callingCodeOf = (waId: string): string | undefined =>
  COUNTRY_BY_CALLING_CODE.find(([code]) => waId.startsWith(code))?.[0]

/** The business number as `metadata.display_phone_number` carries it: digits only. */
export function toWebhookDisplayNumber(number: string): string {
  return number.replace(/\D/g, '')
}

/**
 * The business number as the Graph API returns `display_phone_number`: a `+`,
 * the calling code, then the national number.
 *
 * North American numbers are grouped exactly as in Meta's examples
 * (`+1 631-555-5555`). Elsewhere Meta groups the national digits by each
 * country's own convention (`+52 55 0000 0000`), which would take a phone
 * number library to reproduce; wamock writes the national part ungrouped. Code
 * that compares this field to anything should strip it to digits first.
 */
export function toGraphDisplayNumber(number: string): string {
  const digits = number.replace(/\D/g, '')
  const code = callingCodeOf(digits)
  if (code === undefined) return `+${digits}`
  const national = digits.slice(code.length)
  if (code === '1' && national.length === 10) {
    return `+1 ${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`
  }
  return `+${code} ${national}`
}
