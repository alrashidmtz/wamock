import { ERROR_CODES, GraphError } from '../errors/graph-error.js'
import { isRecord } from '../core/values.js'

/**
 * Validation for the message types beyond text, template and interactive:
 * media, location, contacts and reaction. Every rule is from the matching page
 * under messages/ in Meta's documentation; anything those pages leave open is
 * accepted rather than guessed at.
 */

const CAPTION_MAX = 1024

/** The media types, and whether each takes a caption. */
export const MEDIA_TYPES: Record<string, { caption: boolean }> = {
  image: { caption: true },
  video: { caption: true },
  document: { caption: true },
  audio: { caption: false },
  sticker: { caption: false },
}

const invalid = (details: string): GraphError => new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })


/** `{id}` or `{link}`, never both and never neither, plus the per-type extras. */
export function validateMedia(type: string, content: unknown): void {
  if (!isRecord(content)) throw invalid(`Param ${type} is required for type ${type}`)

  const hasId = typeof content['id'] === 'string' && content['id'] !== ''
  const hasLink = typeof content['link'] === 'string' && content['link'] !== ''
  if (hasId === hasLink) {
    throw invalid(`Param ${type} must contain exactly one of ${type}[id] or ${type}[link]`)
  }

  const caption = content['caption']
  if (caption !== undefined) {
    if (!MEDIA_TYPES[type]!.caption) throw invalid(`Param ${type}[caption] is not supported for type ${type}`)
    if (typeof caption !== 'string' || caption.length > CAPTION_MAX) {
      throw invalid(`Param ${type}[caption] must be a string of at most ${CAPTION_MAX} characters`)
    }
  }
  if (type === 'document' && content['filename'] !== undefined && typeof content['filename'] !== 'string') {
    throw invalid('Param document[filename] must be a string')
  }
  if (type === 'audio' && content['voice'] !== undefined && typeof content['voice'] !== 'boolean') {
    throw invalid('Param audio[voice] must be a boolean')
  }
}

/** A coordinate in decimal degrees, as a number or a numeric string (Meta's examples use strings). */
function coordinate(value: unknown, limit: number, field: string): void {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || Math.abs(number) > limit) {
    throw invalid(`Param location[${field}] must be decimal degrees between -${limit} and ${limit}`)
  }
}

export function validateLocation(content: unknown): void {
  if (!isRecord(content)) throw invalid('Param location is required for type location')
  coordinate(content['latitude'], 90, 'latitude')
  coordinate(content['longitude'], 180, 'longitude')
}

/** Properties a contact card may carry; Meta's schema allows no others. */
const CONTACT_PROPERTIES = new Set(['addresses', 'birthday', 'emails', 'name', 'org', 'phones', 'urls'])

/** "Each message can include information for up to 257 contacts." */
const CONTACTS_MAX = 257

export function validateContacts(content: unknown): void {
  if (!Array.isArray(content) || content.length === 0) {
    throw invalid('Param contacts must be a non-empty array of contact objects')
  }
  if (content.length > CONTACTS_MAX) throw invalid(`Param contacts can hold at most ${CONTACTS_MAX} contacts`)
  for (const [index, card] of content.entries()) {
    if (!isRecord(card)) throw invalid(`Param contacts[${index}] must be an object`)
    const unknown = Object.keys(card).filter((key) => !CONTACT_PROPERTIES.has(key))
    if (unknown.length > 0) throw invalid(`Param contacts[${index}] has unsupported properties: ${unknown.join(', ')}`)
    const name = card['name']
    if (!isRecord(name) || typeof name['formatted_name'] !== 'string' || name['formatted_name'] === '') {
      throw invalid(`Param contacts[${index}][name][formatted_name] is required`)
    }
  }
}

export function validateReaction(content: unknown): void {
  if (!isRecord(content)) throw invalid('Param reaction is required for type reaction')
  if (typeof content['message_id'] !== 'string' || content['message_id'] === '') {
    throw invalid('Param reaction[message_id] is required')
  }
  if (typeof content['emoji'] !== 'string') throw invalid('Param reaction[emoji] is required')
}
