import { createHash, createHmac } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { freshNumericId, makeMediaId } from '../core/ids.js'
import { ERROR_CODES, GraphError, unsupportedRequest } from '../errors/graph-error.js'

/**
 * Media, as Meta's media guide describes it.
 *
 * - Upload is multipart: `messaging_product`, `type` and the `file`, checked
 *   against Meta's supported types and their size limits.
 * - An uploaded media id lives 30 days. Each `GET /{media_id}` hands out a new
 *   download URL that lives 5 minutes: code that caches a URL and fetches it
 *   later works in a quick test and gets a 404 from Meta.
 * - Download needs a bearer token and returns the bytes with their MIME type.
 * - `phone_number_id`, when given, must be the number that uploaded the media.
 */

const MB = 1024 * 1024
const KB = 1024

/** Meta's supported media types and their size limits ("Supported media types"). */
export const SUPPORTED_MEDIA: Record<string, number> = {
  'audio/aac': 16 * MB,
  'audio/amr': 16 * MB,
  'audio/mpeg': 16 * MB,
  'audio/mp4': 16 * MB,
  'audio/ogg': 16 * MB,
  'text/plain': 100 * MB,
  'application/vnd.ms-excel': 100 * MB,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 100 * MB,
  'application/msword': 100 * MB,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 100 * MB,
  'application/vnd.ms-powerpoint': 100 * MB,
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 100 * MB,
  'application/pdf': 100 * MB,
  'image/jpeg': 5 * MB,
  'image/png': 5 * MB,
  // Stickers: 500 KB animated, 100 KB static. wamock cannot tell the two
  // apart, so it allows the larger.
  'image/webp': 500 * KB,
  'video/3gpp': 16 * MB,
  'video/mp4': 16 * MB,
}

/** Uploaded media ids expire after 30 days; ids received in webhooks after 7. */
const MEDIA_ID_TTL_MS = 30 * 24 * 60 * 60 * 1000
const RECEIVED_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** Media download URLs expire after 5 minutes. */
const MEDIA_URL_TTL_MS = 5 * 60 * 1000
/** Where Meta serves downloads; an intercepted client is routed here too. */
const META_DOWNLOAD_BASE = 'https://lookaside.fbsbx.com'
export const DOWNLOAD_PATH = '/whatsapp_business/attachments/'

export interface MediaFile {
  bytes: Buffer
  filename?: string
  contentType?: string
}

interface MediaRecord {
  id: string
  phoneNumberId: string
  mimeType: string
  bytes: Buffer
  sha256: string
  uploadedAt: number
  ttlMs: number
}

/**
 * The file hash as Meta writes it: base64, as in every inbound media example
 * (`"SfInY0gGKTsJlUWbwxC1k+FAD0FZHvzwfpvO0zX0GUI="`). The media API reference
 * gives no example of its own, and it describes the same file.
 */
const sha256Of = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64')

const invalid = (details: string): GraphError => new GraphError(ERROR_CODES.INVALID_PARAMETER, { details })

/** The size limit of a supported MIME type; never a property every object has. */
const mediaLimit = (mimeType: string): number | undefined =>
  Object.hasOwn(SUPPORTED_MEDIA, mimeType) ? SUPPORTED_MEDIA[mimeType] : undefined

/** The MIME types each kind of media message can carry. */
export const MIME_TYPES_BY_KIND: Record<string, ReadonlySet<string>> = {
  image: new Set(['image/jpeg', 'image/png']),
  video: new Set(['video/3gpp', 'video/mp4']),
  audio: new Set(['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg']),
  sticker: new Set(['image/webp']),
  document: new Set([
    'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/pdf',
  ]),
}

export class MediaService {
  readonly #context: MockContext
  readonly #media = new Map<string, MediaRecord>()
  /** Keys the download URLs, so a URL cannot be forged from an id alone. */
  readonly #urlKey = 'wamock-media-url'

  constructor(context: MockContext) {
    this.#context = context
  }

  /** `POST /{phone_number_id}/media`. */
  upload(phoneNumberId: string, body: Record<string, unknown>): { id: string } {
    const { clock, state } = this.#context

    if (!state.phoneNumber(phoneNumberId)) throw unsupportedRequest('post', phoneNumberId)
    if (body['messaging_product'] !== 'whatsapp') {
      throw invalid("Param messaging_product must be 'whatsapp'")
    }
    const file = body['file'] as MediaFile | undefined
    if (!file || !Buffer.isBuffer(file.bytes)) {
      throw invalid('Param file is required: upload the media as multipart/form-data')
    }

    // Meta's parameter table requires `type`, while its own example sends the
    // MIME type only on the file part (`-F 'file=@video.mp4;type=video/mp4'`).
    // Either is accepted: the field when present, the file part's otherwise.
    const declared = typeof body['type'] === 'string' && body['type'] !== '' ? body['type'] : file.contentType
    if (declared === undefined || declared === '') throw invalid('Param type is required')
    const type = declared.split(';')[0]!.trim().toLowerCase()
    const limit = mediaLimit(type)
    if (limit === undefined) throw invalid(`Param type (${declared}) is not a supported media type`)

    if (file.bytes.length > limit) {
      throw invalid(`File is ${file.bytes.length} bytes; ${type} is limited to ${limit} bytes`)
    }

    const id = this.#freshId()
    this.#media.set(id, {
      id,
      phoneNumberId,
      mimeType: type,
      bytes: file.bytes,
      sha256: sha256Of(file.bytes),
      uploadedAt: clock.now(),
      ttlMs: MEDIA_ID_TTL_MS,
    })
    return { id }
  }

  /**
   * Media a customer sent: stored like an upload, but its id lives 7 days, as
   * ids from webhooks do. Returns the fields the inbound message carries.
   */
  receive(phoneNumberId: string, mimeType: string, bytes: Buffer): { id: string; sha256: string; url: string } {
    const { clock } = this.#context
    const id = this.#freshId()
    const sha256 = sha256Of(bytes)
    this.#media.set(id, { id, phoneNumberId, mimeType, bytes, sha256, uploadedAt: clock.now(), ttlMs: RECEIVED_MEDIA_TTL_MS })
    return { id, sha256, url: this.get(id)['url'] as string }
  }

  /**
   * A numeric id no other object holds: a media id that matched a number's or
   * a WABA's would let that owner's token reach these bytes.
   */
  #freshId(): string {
    const { state } = this.#context
    const id = freshNumericId(makeMediaId, () => state.nextSeq(), (candidate) => state.isIdTaken(candidate) || this.#media.has(candidate))
    state.reserveId(id)
    return id
  }

  /** The number that uploaded or received this media, while it lives. */
  ownerOf(mediaId: string): string | undefined {
    return this.#live(mediaId)?.phoneNumberId
  }

  /**
   * The MIME type of a live media id, or undefined once it expired or never
   * existed: what a send by `id` checks, for both.
   */
  mimeTypeOf(mediaId: string): string | undefined {
    return this.#live(mediaId)?.mimeType
  }

  /**
   * `GET /{media_id}` — a fresh 5-minute download URL each time. `baseUrl` is
   * where the URL points: the mock's own address when the call came over HTTP,
   * Meta's download host otherwise (an intercepted client is routed here).
   */
  get(mediaId: string, options: { phoneNumberId?: string; baseUrl?: string } = {}): Record<string, unknown> {
    const media = this.#owned('get', mediaId, options.phoneNumberId)
    const expires = Math.floor((this.#context.clock.now() + MEDIA_URL_TTL_MS) / 1000)
    const url = new URL(DOWNLOAD_PATH, options.baseUrl ?? META_DOWNLOAD_BASE)
    url.searchParams.set('mid', media.id)
    url.searchParams.set('ext', String(expires))
    url.searchParams.set('hash', this.#sign(media.id, expires))
    return {
      messaging_product: 'whatsapp',
      url: url.toString(),
      mime_type: media.mimeType,
      sha256: media.sha256,
      file_size: String(media.bytes.length),
      id: media.id,
    }
  }

  /**
   * `GET <media URL>` — the bytes, for a URL this mock issued that has not
   * expired. Anything else is a 404, which Meta answers too, and the cure is
   * to look the id up again.
   */
  download(query: { mid?: string; ext?: string; hash?: string }): { bytes: Buffer; mimeType: string } | undefined {
    const { mid, ext, hash } = query
    if (!mid || !ext || !hash || hash !== this.#sign(mid, Number(ext))) return undefined
    if (this.#context.clock.now() >= Number(ext) * 1000) return undefined
    const media = this.#live(mid)
    return media ? { bytes: media.bytes, mimeType: media.mimeType } : undefined
  }

  /** `DELETE /{media_id}`. */
  delete(mediaId: string, options: { phoneNumberId?: string } = {}): { success: true } {
    this.#owned('delete', mediaId, options.phoneNumberId)
    this.#media.delete(mediaId)
    return { success: true }
  }

  clear(): void {
    this.#media.clear()
  }

  #live(mediaId: string): MediaRecord | undefined {
    const media = this.#media.get(mediaId)
    if (!media) return undefined
    return this.#context.clock.now() - media.uploadedAt < media.ttlMs ? media : undefined
  }

  #owned(method: 'get' | 'delete', mediaId: string, phoneNumberId?: string): MediaRecord {
    const media = this.#live(mediaId)
    if (!media || (phoneNumberId !== undefined && media.phoneNumberId !== phoneNumberId)) {
      throw unsupportedRequest(method, mediaId)
    }
    return media
  }

  #sign(mediaId: string, expires: number): string {
    return createHmac('sha256', this.#urlKey).update(`${mediaId}:${expires}`).digest('hex').slice(0, 32)
  }
}
