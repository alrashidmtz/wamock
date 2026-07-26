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

const MAX_BUTTONS = 3
const BUTTON_TITLE_MAX = 20
const MAX_ROWS_TOTAL = 10
const ROW_TITLE_MAX = 24
const ROW_DESC_MAX = 72
const SECTION_TITLE_MAX = 24
const LIST_BUTTON_MAX = 20

const invalid = (details: string): GraphError =>
  new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function assertLength(value: string, max: number, field: string): void {
  if (value.length > max) {
    throw invalid(`Param ${field} exceeds the ${max} character limit (got ${value.length})`)
  }
}

function bodyText(interactive: Record<string, unknown>): void {
  const body = interactive['body']
  if (!isRecord(body) || typeof body['text'] !== 'string' || body['text'] === '') {
    throw invalid('Param interactive[body][text] is required')
  }
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
    default:
      throw invalid("Param interactive[type] must be one of {button, list}")
  }
}

function validateButtons(interactive: Record<string, unknown>): void {
  bodyText(interactive)

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

  for (const [index, entry] of buttons.entries()) {
    const reply = isRecord(entry) ? entry['reply'] : undefined
    if (!isRecord(reply) || typeof reply['id'] !== 'string' || reply['id'] === '') {
      throw invalid(`Param interactive[action][buttons][${index}][reply][id] is required`)
    }
    if (typeof reply['title'] !== 'string' || reply['title'] === '') {
      throw invalid(`Param interactive[action][buttons][${index}][reply][title] is required`)
    }
    assertLength(reply['title'], BUTTON_TITLE_MAX, `interactive[action][buttons][${index}][reply][title]`)
  }
}

function validateList(interactive: Record<string, unknown>): void {
  bodyText(interactive)

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

  // The budget is global. Counting per section is the mistake this reproduces.
  let totalRows = 0

  for (const [s, section] of sections.entries()) {
    if (!isRecord(section)) {
      throw invalid(`Param interactive[action][sections][${s}] must be an object`)
    }

    const sectionTitle = section['title']
    if (typeof sectionTitle === 'string') {
      assertLength(sectionTitle, SECTION_TITLE_MAX, `interactive[action][sections][${s}][title]`)
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
