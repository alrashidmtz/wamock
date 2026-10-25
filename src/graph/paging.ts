import { ERROR_CODES, GraphError } from '../errors/graph-error.js'

/** Opaque, like Meta's cursors; wamock's just encode the record id. */
export const toCursor = (id: string): string => Buffer.from(id).toString('base64url')
export const fromCursor = (cursor: string): string => Buffer.from(cursor, 'base64url').toString()

export interface PageOptions {
  limit?: number
  after?: string
  before?: string
}

export interface Page {
  /** The ids on this page, in order. */
  ids: string[]
  /** `{cursors, previous?, next?}`, or undefined for an empty page. */
  paging?: Record<string, unknown>
}

/**
 * Cursor paging, as every Graph edge pages: a cursor names a record, and
 * `after`/`before` read the page on either side of it. `link` builds the URL
 * of a neighbouring page from the query the call was made with.
 *
 * Returns undefined when a cursor names no record in `ordered`, so each edge
 * can answer that the way Meta does for it.
 */
export function pageOf(
  ordered: string[],
  options: PageOptions & { defaultLimit: number },
  link: (param: 'after' | 'before', cursor: string) => string,
): Page | undefined {
  // Checked here, in the service, rather than where HTTP parses the query: a
  // call through the library is held to it too, and only after the object
  // the call names was found usable.
  if (options.limit !== undefined && !(Number.isInteger(options.limit) && options.limit >= 1 && options.limit <= 100)) {
    throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param limit must be an integer between 1 and 100' })
  }
  const at = (cursor: string | undefined) => (cursor === undefined ? -1 : ordered.indexOf(fromCursor(cursor)))
  if ((options.after !== undefined && at(options.after) < 0) || (options.before !== undefined && at(options.before) < 0)) {
    return undefined
  }
  const limit = options.limit ?? options.defaultLimit
  let start = 0
  if (options.after !== undefined) start = at(options.after) + 1
  else if (options.before !== undefined) start = Math.max(0, at(options.before) - limit)
  const end = options.before !== undefined && options.after === undefined ? Math.max(0, at(options.before)) : start + limit
  const ids = ordered.slice(start, Math.min(end, ordered.length))
  if (ids.length === 0) return { ids }

  const cursors = { before: toCursor(ids[0]!), after: toCursor(ids.at(-1)!) }
  return {
    ids,
    paging: {
      cursors,
      ...(start > 0 ? { previous: link('before', cursors.before) } : {}),
      ...(start + ids.length < ordered.length ? { next: link('after', cursors.after) } : {}),
    },
  }
}
