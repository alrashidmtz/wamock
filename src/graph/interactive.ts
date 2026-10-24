import { isRecord, isWebUrl } from '../core/values.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'

/**
 * Interactive message validation, with Meta's real caps.
 *
 * These numbers were confirmed against a production integration, and the one
 * that catches people is the row cap: **10 rows total across all sections**,
 * not 10 per section. Two sections of six rows each pass every per-section
 * check and are rejected by Meta.
 *
 * wamock REJECTS rather than truncates. A well-behaved client clips titles
 * defensively so the send survives; a mock that does the same hides the very
 * 400 it exists to reproduce.
 */

// Every cap below is from Meta's reply-buttons and list message pages.
const MAX_BUTTONS = 3
const BUTTON_TITLE_MAX = 20
const BUTTON_ID_MAX = 256
const BUTTON_BODY_MAX = 1024
const LIST_BODY_MAX = 4096
const FOOTER_MAX = 60
const HEADER_TEXT_MAX = 60
const MAX_ROWS_TOTAL = 10
const MAX_SECTIONS = 10
const ROW_ID_MAX = 200
const ROW_TITLE_MAX = 24
const ROW_DESC_MAX = 72
const SECTION_TITLE_MAX = 24
const LIST_BUTTON_MAX = 20

const invalid = (details: string): GraphError =>
  new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })


function assertLength(value: string, max: number, field: string): void {
  if (value.length > max) {
    throw invalid(`Param ${field} exceeds the ${max} character limit (got ${value.length})`)
  }
}

function bodyText(interactive: Record<string, unknown>, max: number): void {
  const body = interactive['body']
  if (!isRecord(body) || typeof body['text'] !== 'string' || body['text'] === '') {
    throw invalid('Param interactive[body][text] is required')
  }
  assertLength(body['text'], max, 'interactive[body][text]')
}

/** The optional footer and text header every interactive type shares. */
/**
 * The optional header and footer. A footer needs its text; a header needs
 * the content of its type. Reply buttons and CTA URL messages take a text,
 * image, video or document header; a list takes text only.
 */
function frame(interactive: Record<string, unknown>, mediaHeader: boolean): void {
  const footer = interactive['footer']
  if (footer !== undefined) {
    if (!isRecord(footer) || typeof footer['text'] !== 'string' || footer['text'] === '') {
      throw invalid('Param interactive[footer][text] is required when there is a footer')
    }
    assertLength(footer['text'], FOOTER_MAX, 'interactive[footer][text]')
  }

  const header = interactive['header']
  if (header === undefined) return
  if (!isRecord(header)) throw invalid('Param interactive[header] must be an object')
  const type = header['type']
  if (type === 'text') {
    if (typeof header['text'] !== 'string' || header['text'] === '') {
      throw invalid('Param interactive[header][text] is required for a text header')
    }
    assertLength(header['text'], HEADER_TEXT_MAX, 'interactive[header][text]')
    return
  }
  if (!mediaHeader || (type !== 'image' && type !== 'video' && type !== 'document')) {
    throw invalid(
      mediaHeader
        ? 'Param interactive[header][type] must be one of {text, image, video, document}'
        : 'Param interactive[header][type] must be text for a list message',
    )
  }
  const media = header[type]
  // Exactly one of the two, as for a media message.
  const hasLink = isRecord(media) && typeof media['link'] === 'string' && media['link'] !== ''
  const hasId = isRecord(media) && typeof media['id'] === 'string' && media['id'] !== ''
  if (hasLink === hasId) throw invalid(`Param interactive[header][${type}] needs exactly one of link or id`)
}

export function validateInteractive(interactive: unknown): void {
  if (!isRecord(interactive)) {
    throw invalid('Param interactive is required for type interactive')
  }

  switch (interactive['type']) {
    case 'button':
      return validateButtons(interactive)
    case 'list':
      return validateList(interactive)
    case 'cta_url':
      return validateCtaUrl(interactive)
    default:
      throw invalid('Param interactive[type] must be one of {button, list, cta_url}')
  }
}

function validateButtons(interactive: Record<string, unknown>): void {
  bodyText(interactive, BUTTON_BODY_MAX)
  frame(interactive, true)

  const action = interactive['action']
  const buttons = isRecord(action) ? action['buttons'] : undefined
  if (!Array.isArray(buttons) || buttons.length === 0) {
    throw invalid('Param interactive[action][buttons] must contain at least one button')
  }
  if (buttons.length > MAX_BUTTONS) {
    throw invalid(
      `Param interactive[action][buttons] allows at most ${MAX_BUTTONS} buttons (got ${buttons.length})`,
    )
  }

  const titles = new Set<string>()
  for (const [index, entry] of buttons.entries()) {
    const reply = isRecord(entry) ? entry['reply'] : undefined
    if (!isRecord(reply) || typeof reply['id'] !== 'string' || reply['id'] === '') {
      throw invalid(`Param interactive[action][buttons][${index}][reply][id] is required`)
    }
    assertLength(reply['id'], BUTTON_ID_MAX, `interactive[action][buttons][${index}][reply][id]`)
    if (typeof reply['title'] !== 'string' || reply['title'] === '') {
      throw invalid(`Param interactive[action][buttons][${index}][reply][title] is required`)
    }
    assertLength(reply['title'], BUTTON_TITLE_MAX, `interactive[action][buttons][${index}][reply][title]`)
    // Meta requires distinct labels: two identical buttons cannot be told apart.
    if (titles.has(reply['title'])) {
      throw invalid(`Param interactive[action][buttons][${index}][reply][title] must be unique`)
    }
    titles.add(reply['title'])
  }
}

/** A single call-to-action button that opens a URL (Meta's CTA URL message page). */
function validateCtaUrl(interactive: Record<string, unknown>): void {
  bodyText(interactive, BUTTON_BODY_MAX)
  frame(interactive, true)

  const action = interactive['action']
  const parameters = isRecord(action) ? action['parameters'] : undefined
  if (!isRecord(action) || action['name'] !== 'cta_url' || !isRecord(parameters)) {
    throw invalid("Param interactive[action] must be {name: 'cta_url', parameters: {display_text, url}}")
  }
  if (typeof parameters['display_text'] !== 'string' || parameters['display_text'] === '') {
    throw invalid('Param interactive[action][parameters][display_text] is required')
  }
  assertLength(parameters['display_text'], BUTTON_TITLE_MAX, 'interactive[action][parameters][display_text]')
  if (typeof parameters['url'] !== 'string' || !isWebUrl(parameters['url'])) {
    throw invalid('Param interactive[action][parameters][url] is required: the URL the button opens')
  }
}

function validateList(interactive: Record<string, unknown>): void {
  bodyText(interactive, LIST_BODY_MAX)
  frame(interactive, false)

  const action = interactive['action']
  if (!isRecord(action)) {
    throw invalid('Param interactive[action] is required')
  }

  const buttonLabel = action['button']
  if (typeof buttonLabel !== 'string' || buttonLabel === '') {
    throw invalid('Param interactive[action][button] is required')
  }
  assertLength(buttonLabel, LIST_BUTTON_MAX, 'interactive[action][button]')

  const sections = action['sections']
  if (!Array.isArray(sections) || sections.length === 0) {
    throw invalid('Param interactive[action][sections] must contain at least one section')
  }
  if (sections.length > MAX_SECTIONS) {
    throw invalid(
      `Param interactive[action][sections] allows at most ${MAX_SECTIONS} sections (got ${sections.length})`,
    )
  }

  // The budget is global. Counting per section is the mistake this reproduces.
  let totalRows = 0

  for (const [s, section] of sections.entries()) {
    if (!isRecord(section)) {
      throw invalid(`Param interactive[action][sections][${s}] must be an object`)
    }

    const sectionTitle = section['title']
    if (typeof sectionTitle === 'string') {
      assertLength(sectionTitle, SECTION_TITLE_MAX, `interactive[action][sections][${s}][title]`)
    } else if (sections.length > 1) {
      // A title is optional only when there is a single section.
      throw invalid(`Param interactive[action][sections][${s}][title] is required when there is more than one section`)
    }

    const rows = section['rows']
    if (!Array.isArray(rows) || rows.length === 0) {
      throw invalid(`Param interactive[action][sections][${s}][rows] must contain at least one row`)
    }
    totalRows += rows.length

    for (const [r, row] of rows.entries()) {
      const field = `interactive[action][sections][${s}][rows][${r}]`
      if (!isRecord(row) || typeof row['id'] !== 'string' || row['id'] === '') {
        throw invalid(`Param ${field}[id] is required`)
      }
      assertLength(row['id'], ROW_ID_MAX, `${field}[id]`)
      if (typeof row['title'] !== 'string' || row['title'] === '') {
        throw invalid(`Param ${field}[title] is required`)
      }
      assertLength(row['title'], ROW_TITLE_MAX, `${field}[title]`)
      if (typeof row['description'] === 'string') {
        assertLength(row['description'], ROW_DESC_MAX, `${field}[description]`)
      }
    }
  }

  if (totalRows > MAX_ROWS_TOTAL) {
    throw invalid(
      `Param interactive[action][sections] allows at most ${MAX_ROWS_TOTAL} rows in total across all sections (got ${totalRows})`,
    )
  }
}
