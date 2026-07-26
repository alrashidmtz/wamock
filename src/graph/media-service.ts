import { createHash } from 'node:crypto'

import type { MockContext } from '../core/context.js'
import { makeMediaId } from '../core/ids.js'
import { ERROR_CODES, GraphError } from '../errors/graph-error.js'

/**
 * Media (spec §5.5) — a stub by design.
 *
 * No bytes are stored. What is reproduced is the part that actually breaks
 * integrations: Meta's download URLs die after about five minutes, so code that
 * caches one and fetches it later works in every test and fails against Meta.
 */

/** Meta's media download URLs are valid for roughly five minutes. */
const MEDIA_URL_TTL_MS = 5 * 60 * 1000

interface MediaRecord {
  id: string
  mimeType: string
  uploadedAt: number
}

export class MediaService {
  readonly #context: MockContext
  readonly #media = new Map<string, MediaRecord>()

  constructor(context: MockContext) {
    this.#context = context
  }

  /** `POST /{phone_number_id}/media`. */
  upload(phoneNumberId: string, body: Record<string, unknown>): { id: string } {
    const { clock, state } = this.#context

    if (!state.phoneNumber(phoneNumberId)) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${phoneNumberId}' does not exist`,
      })
    }

    const mimeType = body['type'] ?? body['mime_type']
    if (typeof mimeType !== 'string' || mimeType === '') {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param type is required' })
    }

    const id = makeMediaId(state.nextSeq())
    this.#media.set(id, { id, mimeType, uploadedAt: clock.now() })
    return { id }
  }

  /** `GET /{media_id}` — resolves until the URL expires, then stops. */
  get(mediaId: string): Record<string, unknown> {
    const media = this.#media.get(mediaId)
    if (!media) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Object with ID '${mediaId}' does not exist`,
      })
    }

    if (this.#context.clock.now() - media.uploadedAt >= MEDIA_URL_TTL_MS) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        details: `Media ID '${mediaId}' has expired. Media download URLs are valid for a limited time.`,
      })
    }

    return {
      messaging_product: 'whatsapp',
      id: media.id,
      mime_type: media.mimeType,
      // `.invalid` is reserved by RFC 2606 and can never resolve — nothing can
      // accidentally fetch a real resource from a mock URL.
      url: `https://wamock.invalid/media/${media.id}`,
      sha256: createHash('sha256').update(media.id).digest('hex'),
      file_size: 1024,
    }
  }

  clear(): void {
    this.#media.clear()
  }
}
