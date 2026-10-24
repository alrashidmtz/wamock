import { describe, expect, it } from 'vitest'

import { parseMultipart, parseUrlEncoded } from '../../src/http/forms.js'

/**
 * The two non-JSON bodies Graph accepts, parsed by hand. Malformed input must
 * come back as "not a body" (undefined), never as a half-read one.
 */

const CRLF = '\r\n'
const body = (boundary: string, parts: string[]) =>
  Buffer.from(parts.map((p) => `--${boundary}${CRLF}${p}${CRLF}`).join('') + `--${boundary}--${CRLF}`)

describe('parseMultipart', () => {
  it('reads fields and a file, keeping the file’s bytes, name and type', () => {
    const parsed = parseMultipart(
      body('b', [
        `Content-Disposition: form-data; name="type"${CRLF}${CRLF}image/jpeg`,
        `Content-Disposition: form-data; name="file"; filename="p.jpg"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}JPEG`,
      ]),
      'multipart/form-data; boundary=b',
    )
    expect(parsed).toEqual({
      type: 'image/jpeg',
      file: { bytes: Buffer.from('JPEG'), filename: 'p.jpg', contentType: 'image/jpeg' },
    })
  })

  it('takes a quoted boundary, and a part named file with no filename as a file', () => {
    const parsed = parseMultipart(
      body('a b', [`Content-Disposition: form-data; name="file"${CRLF}${CRLF}raw`]),
      'multipart/form-data; boundary="a b"',
    )
    // Strict: a file without a filename or a type has no such keys at all.
    expect(parsed).toStrictEqual({ file: { bytes: Buffer.from('raw') } })
  })

  it('needs a boundary in the content type, whatever the body holds', () => {
    // Even a body that starts with what a missing boundary would stringify to.
    expect(
      parseMultipart(body('undefined', [`Content-Disposition: form-data; name="a"${CRLF}${CRLF}v`]), 'multipart/form-data'),
    ).toBeUndefined()
  })

  it('answers undefined for a body that does not open with its boundary line', () => {
    const rest = `Content-Disposition: form-data; name="a"${CRLF}${CRLF}v${CRLF}--b--`
    // Something else where the first boundary belongs.
    expect(parseMultipart(Buffer.from(`--c${CRLF}${rest}`), 'multipart/form-data; boundary=b')).toBeUndefined()
    // The boundary, but not on a line of its own.
    expect(parseMultipart(Buffer.from(`--bXY${rest}`), 'multipart/form-data; boundary=b')).toBeUndefined()
  })

  it('reads parameters and headers written without optional whitespace', () => {
    const parsed = parseMultipart(
      body('b', [
        `Content-Disposition: form-data;name="note"${CRLF}${CRLF}hi`,
        `Content-Disposition: form-data;name="doc";filename="a.txt"${CRLF}Content-Type:text/plain${CRLF}${CRLF}x`,
      ]),
      'multipart/form-data; boundary=b',
    )
    expect(parsed).toStrictEqual({ note: 'hi', doc: { bytes: Buffer.from('x'), filename: 'a.txt', contentType: 'text/plain' } })
  })

  it('trims the whitespace around a part’s content type', () => {
    const parsed = parseMultipart(
      body('b', [`Content-Disposition: form-data; name="file"${CRLF}Content-Type:   image/png  ${CRLF}${CRLF}x`]),
      'multipart/form-data; boundary=b',
    )
    expect(parsed).toStrictEqual({ file: { bytes: Buffer.from('x'), contentType: 'image/png' } })
  })

  it('answers undefined for a body that does not follow its boundary', () => {
    expect(parseMultipart(Buffer.from('x'), 'multipart/form-data')).toBeUndefined()
    expect(parseMultipart(Buffer.from('nothing here'), 'multipart/form-data; boundary=b')).toBeUndefined()
    expect(parseMultipart(Buffer.from(`--b${CRLF}no headers end`), 'multipart/form-data; boundary=b')).toBeUndefined()
    expect(
      parseMultipart(Buffer.from(`--b${CRLF}Content-Disposition: form-data; name="x"${CRLF}value${CRLF}--b--`), 'multipart/form-data; boundary=b'),
    ).toBeUndefined()
  })

  it('keeps file bytes that contain the boundary text, which only a whole delimiter line ends', () => {
    const data = 'prefix-data--b--not-a-delimiter-suffix\r\n--bX still data'
    const parsed = parseMultipart(
      body('b', [`Content-Disposition: form-data; name="file"; filename="f"${CRLF}${CRLF}${data}`]),
      'multipart/form-data; boundary=b',
    )
    expect((parsed?.['file'] as { bytes: Buffer }).bytes.toString()).toBe(data)
  })

  it('reads a JSON-valued field as JSON, as the urlencoded form does', () => {
    const parsed = parseMultipart(
      body('b', [`Content-Disposition: form-data; name="text"${CRLF}${CRLF}{"body":"hi"}`]),
      'multipart/form-data; boundary=b',
    )
    expect(parsed).toEqual({ text: { body: 'hi' } })
  })

  it('tells name from filename whatever their order', () => {
    const parsed = parseMultipart(
      body('b', [`Content-Disposition: form-data; filename="a.txt"; name="file"${CRLF}${CRLF}x`]),
      'multipart/form-data; boundary=b',
    )
    expect(parsed).toStrictEqual({ file: { bytes: Buffer.from('x'), filename: 'a.txt' } })
  })

  // Mutants left alive on purpose: a missing closing delimiter fails on the
  // next boundary check whatever `next === -1` does, and the part-start
  // offset and the disposition fallback only change text no regex matches.
  it('skips a part without a name', () => {
    expect(parseMultipart(body('b', [`Content-Type: text/plain${CRLF}${CRLF}x`]), 'multipart/form-data; boundary=b')).toEqual({})
  })
})

describe('parseUrlEncoded', () => {
  it('reads JSON-valued fields as JSON and everything else as strings', () => {
    expect(parseUrlEncoded('type=text&text=%7B%22body%22%3A%22hi%22%7D&list=%5B1%5D&to=521')).toEqual({
      type: 'text',
      text: { body: 'hi' },
      list: [1],
      to: '521',
    })
  })

  it('reads JSON with whitespace around it as JSON, as JSON itself allows', () => {
    expect(parseUrlEncoded('text=%20%7B%22body%22%3A%22hi%22%7D%0A')).toEqual({ text: { body: 'hi' } })
  })

  it('keeps a value that only looks like JSON as the string it is', () => {
    expect(parseUrlEncoded('note=%7Bnot%20json')).toEqual({ note: '{not json' })
  })
})
