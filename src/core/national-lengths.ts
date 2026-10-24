/**
 * How many digits a fixed-line or mobile national number has, per calling
 * code, to tell whether a number that starts with its calling code already
 * includes it.
 *
 * Generated from libphonenumber's PhoneNumberMetadata.xml at v9.0.41
 * (Apache License 2.0, https://github.com/google/libphonenumber): the
 * `national` possible lengths of each territory's `fixedLine` and `mobile`
 * descriptions, joined for territories that share a code. Toll-free, premium
 * and other types are left out: a WhatsApp business number is fixed or mobile,
 * and counting them made 72 of the 206 codes ambiguous instead of 34.
 */
export const NATIONAL_LENGTHS: Readonly<Record<string, readonly number[]>> = {
  '1': [10], '7': [10], '20': [8, 9, 10], '27': [5, 6, 7, 8, 9], '30': [10],
  '31': [9, 11], '32': [8, 9], '33': [9], '34': [9], '36': [8, 9],
  '39': [6, 7, 8, 9, 10, 11, 12], '40': [6, 9], '41': [9],
  '43': [4, 5, 6, 7, 8, 9, 10, 11, 12, 13], '44': [9, 10], '45': [8],
  '46': [7, 8, 9], '47': [8], '48': [7, 9],
  '49': [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], '51': [8, 9], '52': [10],
  '53': [6, 7, 8, 10], '54': [10, 11], '55': [10, 11], '56': [9], '57': [8, 10],
  '58': [10], '60': [8, 9, 10], '61': [9], '62': [7, 8, 9, 10, 11, 12],
  '63': [6, 8, 9, 10], '64': [8, 9, 10], '65': [8], '66': [8, 9], '81': [9, 10],
  '82': [5, 6, 8, 9, 10], '84': [9, 10], '86': [7, 8, 9, 10, 11], '90': [10],
  '91': [10], '92': [9, 10], '93': [9], '94': [9], '95': [6, 7, 8, 9, 10],
  '98': [6, 7, 10], '211': [9], '212': [9], '213': [8, 9], '216': [8],
  '218': [9], '220': [7, 9], '221': [9], '222': [8], '223': [8], '224': [8, 9],
  '225': [10], '226': [8], '227': [8], '228': [8], '229': [10], '230': [7, 8],
  '231': [7, 8, 9], '232': [8], '233': [9], '234': [10], '235': [8], '236': [8],
  '237': [9], '238': [7], '239': [7], '240': [9], '241': [7, 8], '242': [9],
  '243': [7, 8, 9, 10], '244': [9], '245': [9], '246': [7], '247': [5],
  '248': [7], '249': [9], '250': [8, 9], '251': [9], '252': [6, 7, 8, 9],
  '253': [8], '254': [7, 8, 9], '255': [9], '256': [9], '257': [8],
  '258': [8, 9], '260': [9], '261': [9], '262': [9], '263': [7, 9],
  '264': [8, 9], '265': [7, 9], '266': [8], '267': [7, 8], '268': [8],
  '269': [7], '290': [4, 5], '291': [7], '297': [7], '298': [6], '299': [6],
  '350': [8], '351': [9], '352': [4, 5, 6, 7, 8, 9, 10, 11],
  '353': [7, 8, 9, 10], '354': [7, 9], '355': [8, 9], '356': [8], '357': [8],
  '358': [5, 6, 7, 8, 9, 10], '359': [6, 7, 8, 9], '370': [8], '371': [8],
  '372': [7, 8], '373': [8], '374': [8], '375': [9], '376': [6, 9],
  '377': [8, 9], '378': [8, 10], '380': [9], '381': [7, 8, 9, 10, 11, 12],
  '382': [8], '383': [8, 9, 10, 11, 12], '385': [8, 9], '386': [8],
  '387': [8, 9], '389': [8], '420': [9], '421': [6, 7, 9], '423': [7, 9],
  '500': [5], '501': [7], '502': [8], '503': [8], '504': [8], '505': [8],
  '506': [8], '507': [7, 8], '508': [6, 9], '509': [8], '590': [9], '591': [8],
  '592': [7], '593': [8, 9], '594': [9], '595': [7, 8, 9], '596': [9],
  '597': [6, 7], '598': [8], '599': [7, 8], '670': [7, 8], '672': [6],
  '673': [7], '674': [7], '675': [7, 8], '676': [5, 7], '677': [5, 7],
  '678': [5, 7], '679': [7], '680': [7], '681': [6], '682': [5], '683': [4, 7],
  '685': [5, 6, 7, 10], '686': [5, 8], '687': [6], '688': [5, 6, 7], '689': [8],
  '690': [4, 5, 6, 7], '691': [7], '692': [7], '850': [8, 10], '852': [8],
  '853': [8], '855': [8, 9], '856': [8, 9, 10], '880': [6, 7, 8, 9, 10],
  '886': [8, 9], '960': [7], '961': [7, 8], '962': [8, 9], '963': [8, 9],
  '964': [8, 9, 10], '965': [8], '966': [9], '967': [7, 8, 9], '968': [8],
  '970': [8, 9], '971': [8, 9], '972': [8, 9, 11, 12], '973': [8], '974': [8],
  '975': [7, 8], '976': [8, 9, 10], '977': [8, 10], '992': [9], '993': [8],
  '994': [9], '995': [9], '996': [9], '998': [9],
}

/**
 * Whether `digits`, given with calling code `cc`, already include it. Meta
 * takes `phone_number` "with or without the country calling code" and its
 * example sends `cc: "1"` with `14195551518`: a number that starts with
 * its code is read as including it, unless its length fits a national number
 * and, without the code, it no longer would (a Brazilian `55…` of 11
 * digits). Where both readings fit (34 codes, Germany and China among them),
 * Meta's example decides.
 */
export function includesCallingCode(cc: string, digits: string): boolean {
  if (!digits.startsWith(cc)) return false
  // Own entries only: `constructor` or `__proto__` is no calling code.
  const lengths = Object.hasOwn(NATIONAL_LENGTHS, cc) ? NATIONAL_LENGTHS[cc] : undefined
  if (lengths === undefined) return true
  const fitsAsNational = lengths.includes(digits.length)
  const fitsAsFull = lengths.includes(digits.length - cc.length)
  return !(fitsAsNational && !fitsAsFull)
}
