/**
 * The two non-JSON bodies Meta's Graph API accepts: `multipart/form-data`
 * (the only way to upload media) and `application/x-www-form-urlencoded`
 * (accepted by the Messages API alongside JSON). Parsed by hand so wamock keeps
 * its two runtime dependencies; the formats are simple enough for a mock that
 * only ever sees one request at a time.
 */

export interface MultipartFile {
  bytes: Buffer
  filename?: string
  contentType?: string
}

/**
 * A multipart body as plain fields, with any part that carries a filename
 * (or is named `file`) returned as a {@link MultipartFile}. Undefined when the
 * boundary is missing or the body does not follow it.
 *
 * A delimiter is a whole line: CRLF, `--boundary`, then CRLF or the closing
 * `--`. File bytes that merely contain `--boundary` are data, and a file must
 * never be cut there.
 */
export function parseMultipart(body: Buffer, contentType: string): Record<string, unknown> | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const marker = boundary?.[1] ?? boundary?.[2]
  if (!marker) return undefined

  const first = Buffer.from(`--${marker}`)
  const delimiter = Buffer.from(`\r\n--${marker}`)
  if (!body.subarray(0, first.length).equals(first)) return undefined

  const fields: Record<string, unknown> = {}
  let cursor = first.length
  for (;;) {
    const after = body.subarray(cursor, cursor + 2).toString()
    if (after === '--') return fields
    if (after !== '\r\n') return undefined

    const partStart = cursor + 2
    let next = body.indexOf(delimiter, partStart)
    // Only a delimiter followed by CRLF or `--` ends the part.
    while (next !== -1) {
      const tail = body.subarray(next + delimiter.length, next + delimiter.length + 2).toString()
      if (tail === '\r\n' || tail === '--') break
      next = body.indexOf(delimiter, next + 1)
    }
    if (next === -1) return undefined

    const part = body.subarray(partStart, next)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) return undefined
    const headers = part.subarray(0, headerEnd).toString()
    const content = part.subarray(headerEnd + 4)

    const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? ''
    // `name=` as its own parameter: `filename=` contains it too.
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
    if (name !== undefined) {
      const filename = /;\s*filename="([^"]*)"/i.exec(disposition)?.[1]
      const type = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim()
      fields[name] =
        filename !== undefined || name === 'file'
          ? {
              bytes: Buffer.from(content),
              ...(filename !== undefined ? { filename } : {}),
              ...(type !== undefined ? { contentType: type } : {}),
            }
          : formValue(content.toString())
    }
    cursor = next + delimiter.length
  }
}

/**
 * A form-urlencoded body as an object. Graph reads a value that is itself JSON
 * (`text={"body":"hi"}`) as that JSON, which is how a form carries the nested
 * objects of a message; every other value stays a string.
 */
export function parseUrlEncoded(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of new URLSearchParams(body)) result[key] = formValue(value)
  return result
}

/** A form value that is itself JSON is read as that JSON; any other stays a string. */
function formValue(value: string): unknown {
  const trimmed = value.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Not JSON after all: keep the string, as Graph would.
    }
  }
  return value
}
