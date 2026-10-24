import Fastify from 'fastify'
import type { FastifyBodyParser, FastifyInstance, FastifyRequest } from 'fastify'

import { registerControlRoutes } from './control/routes.js'
import { FORWARDED_HOST_HEADER } from './intercept.js'
import { DOWNLOAD_PATH } from './graph/media-service.js'
import { parseMultipart, parseUrlEncoded } from './http/forms.js'
import { DEFAULT_SETTLE_TIMEOUT_MS } from './core/engine.js'
import type { WamockEngine } from './core/engine.js'
import { ERROR_CODES, GraphError } from './errors/graph-error.js'

/**
 * The HTTP shell. Everything here is routing and error rendering; the
 * behaviour lives in the engine, so server mode and library mode cannot drift.
 */

/**
 * Graph version segment. Real integrations pin anything from v17 to v26 (the
 * latest, released 2026-07-29), expired versions included, and a mock that only
 * answers on one of them fails for reasons that have nothing to do with the
 * code under test (spec §5.1).
 */
const VERSION_PATTERN = /^v\d+\.\d+$/

/** The largest media upload (a 100 MB document) plus room for the multipart framing. */
const MULTIPART_BODY_LIMIT = 101 * 1024 * 1024

/**
 * Pull the bearer token out of the Authorization header, or undefined when
 * there is none. Absent is meaningful: unauthenticated calls are allowed so the
 * quickstart stays short, but a token that IS supplied gets validated.
 */
function bearerToken(headers: Record<string, unknown>): string | undefined {
  const header = headers['authorization']
  if (typeof header !== 'string' || !header.toLowerCase().startsWith('bearer ')) return undefined
  const token = header.slice('bearer '.length).trim()
  return token === '' ? undefined : token
}

/**
 * The token of a Graph call, wherever Graph takes it: the Authorization
 * header, or an `access_token` parameter in the query or the body. Reading
 * only the header let a token in the query go unchecked: an expired one
 * passed, and a tenant's token reached another tenant.
 */
/**
 * Where URLs this answer hands out should point: the mock's own address, or,
 * for a request the interceptor redirected, nowhere of ours, so each edge
 * falls back to Meta's host as Meta answers it.
 */
function publicBase(request: FastifyRequest): string | undefined {
  if (request.headers[FORWARDED_HOST_HEADER] !== undefined) return undefined
  const host = request.headers.host
  if (host === undefined) return undefined
  const base = `${request.protocol}://${host}`
  // The Host header is the caller's input: one that is no host is its 100,
  // not a fault when a URL is built from it.
  try {
    new URL(base)
  } catch {
    throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `The Host header (${host}) is not a valid host` })
  }
  return base
}

function graphToken(request: FastifyRequest): string | undefined {
  const fromHeader = bearerToken(request.headers)
  if (fromHeader !== undefined) return fromHeader
  for (const source of [request.query, request.body]) {
    const value = typeof source === 'object' && source !== null ? (source as Record<string, unknown>)['access_token'] : undefined
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

export interface ServerOptions {
  /** Emit a line per request. Off by default so tests stay quiet. */
  logger?: boolean
  /** Max accepted request body, in bytes. Defaults to 1 MiB. */
  bodyLimit?: number
  /**
   * How long a control-API call waits for the receiver to take the webhooks it
   * triggered. Bounded so a hung receiver cannot hold the request open.
   */
  settleTimeoutMs?: number
}

/**
 * The paging part of a Graph edge's query (`limit`, `after`, `before`), plus
 * where the call came in, so `paging.next` points back at the same server and
 * version.
 */
function pagingQuery(request: FastifyRequest<{ Params: { version: string }; Querystring: Record<string, string> }>): {
  limit?: number
  after?: string
  before?: string
  baseUrl?: string
  version: string
} {
  const { limit, after, before } = request.query
  if (limit !== undefined && !(/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 100)) {
    throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param limit must be an integer between 1 and 100' })
  }
  const baseUrl = publicBase(request)
  return {
    ...(limit !== undefined ? { limit: Number(limit) } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    version: request.params.version,
  }
}

export function createServer(engine: WamockEngine, options: ServerOptions = {}): FastifyInstance {
  // Explicit rather than inherited: a mock accepts arbitrary bodies from
  // whatever is under test, and 1 MiB is far above any real WhatsApp payload.
  const bodyLimit = options.bodyLimit ?? 1024 * 1024
  const app = Fastify({ logger: options.logger ?? false, bodyLimit })

  // Every failure leaves as a Meta-shaped body. A fastify-shaped error would
  // teach the integration under test to parse something Meta never sends.
  app.setErrorHandler((error: unknown, _request, reply) => {
    const message = error instanceof Error ? error.message : String(error)
    // A request Fastify could not read (bad JSON, an oversized body) is the
    // caller's, and Graph answers it 100. Anything else that is not a
    // GraphError is a fault in wamock: answered 500, and named as such, rather
    // than passed off as a 100 the request earned.
    const status = (error as { statusCode?: unknown }).statusCode
    const clientError = typeof status === 'number' && status >= 400 && status < 500
    const graphError =
      error instanceof GraphError
        ? error
        : clientError
          ? new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: message })
          : new GraphError(ERROR_CODES.UNKNOWN, { details: `wamock internal error: ${message}` })
    return reply.status(graphError.httpStatus).send(graphError.toBody(engine.nextFbtraceId()))
  })

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send(
      new GraphError(ERROR_CODES.INVALID_PARAMETER, {
        message: 'Unsupported request',
        details: 'Unknown path. wamock emulates /{version}/... and /__mock/...',
      }).toBody(engine.nextFbtraceId()),
    ),
  )

  // `curl -d '{"ms":1000}' .../__mock/time/advance` labels the body
  // `application/x-www-form-urlencoded`, because that is curl's default for
  // `-d`. Fastify ships a JSON parser only, so every control-API call anyone
  // types in a terminal died in the error handler as "(#100) Invalid
  // parameter" — an error that blamed the parameters for a body it never read.
  //
  // The control API is wamock's own affordance, not a surface that has to match
  // Meta, so it takes the ergonomic reading: a body that parses as JSON is
  // JSON. The Graph routes below stay strict, where the fidelity actually
  // matters, which is why this checks the path rather than parsing everything.
  // Fastify's own JSON parser, which guards against `__proto__` and
  // `constructor` keys; every JSON body goes through it.
  const parseJson = app.getDefaultJsonParser('error', 'error')
  const parseControlBody: FastifyBodyParser<string> = (request, body, done) => {
    if (!request.url.startsWith('/__mock/')) {
      done(
        new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: `Unsupported content type '${request.headers['content-type'] ?? ''}'. Send application/json.`,
        }),
        undefined,
      )
      return
    }
    const raw = body
    if (raw.trim() === '') {
      done(null, {})
      return
    }
    // Fastify's own parser, for its guard against `__proto__` and
    // `constructor` keys; a parse failure keeps this API's wording.
    parseJson(request, raw, (error, value) => {
      if (error) {
        done(
          new GraphError(ERROR_CODES.INVALID_PARAMETER, {
            details: 'Body is not valid JSON. The control API reads every body as JSON.',
          }),
          undefined,
        )
        return
      }
      done(null, value)
    })
  }

  // The catch-all covers what curl's `-d` sends. `text/plain` needs naming
  // separately because Fastify parses it itself, handing the route a string
  // that then failed validation as "Expected object, received string" — a
  // message that describes the symptom and hides the cause.
  // JSON with no body is no parameters, not an error: Meta's own examples
  // call request_code, verify_code and deregister with nothing but a query,
  // and many clients still send `content-type: application/json`.
  // Only the empty body is answered here; the rest goes to parseJson.
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : body.toString()
    if (text.trim() === '') {
      done(null, {})
      return
    }
    parseJson(request, text, done)
  })
  app.addContentTypeParser('*', { parseAs: 'string' }, parseControlBody)
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseControlBody)

  // Graph takes two more bodies than JSON. A form is how the Messages API
  // accepts a send without JSON; multipart is the only way to upload media.
  // The control API keeps reading everything as JSON.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (request, body: string, done) => {
      if (request.url.startsWith('/__mock/')) return parseControlBody(request, body, done)
      done(null, parseUrlEncoded(body))
    },
  )
  app.addContentTypeParser(
    'multipart/form-data',
    // Read by Fastify like any body, under the route's limit: 1 MiB, except
    // the media upload route, which takes documents up to 100 MB.
    { parseAs: 'buffer' },
    (request, body: Buffer, done) => {
      // The control API reads every body as JSON, this content type included.
      if (request.url.startsWith('/__mock/')) return parseControlBody(request, body.toString(), done)
      const fields = parseMultipart(body, String(request.headers['content-type'] ?? ''))
      if (fields === undefined) {
        done(new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Malformed multipart/form-data body' }), undefined)
        return
      }
      done(null, fields)
    },
  )

  /**
   * Hand over the webhooks this control call triggered before answering it.
   *
   * The library helpers have always done this (`createWamock`'s `flush`), and
   * the HTTP door did not — so a control call changed state, returned 200, and
   * delivered the webhook it caused only once something moved the clock (#4).
   *
   * A hook rather than a line per route: it covers inbound, statuses, limit
   * changes, template transitions and `time/advance` at once, and any control endpoint
   * added later is born correct.
   *
   * Scoped to `/__mock/` because Meta answers a send immediately and does not
   * wait on your webhook endpoint first. A Graph route that settled here would
   * take as long as the slowest receiver, which is both wrong and the sort of
   * latency bug this mock exists to expose rather than absorb. It is NOT what
   * keeps delivery statuses waiting for the clock — they are scheduled at
   * +50ms and +500ms, so no `advance(0)` would deliver them wherever it ran.
   */
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  // Where each control request's own deliveries start: the flush after it
  // waits for those (and what they set off), never for ones already running
  // when it arrived — a receiver calling back mid-delivery included.
  const startedAt = new WeakMap<object, number>()
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/__mock/')) startedAt.set(request, engine.deliverer.nextAttempt())
  })
  // One flush, so one budget, per request: a hook can run twice for the same
  // request (an unknown /__mock/ path runs `preHandler` again on its way to
  // the 404), and a second flush would spend a second budget.
  const flushed = new WeakSet<object>()
  const flushOnce = async (request: FastifyRequest): Promise<void> => {
    if (flushed.has(request.raw)) return
    flushed.add(request.raw)
    await engine.flush(settleTimeoutMs, startedAt.get(request))
  }
  // Writes only: a read flushed in `preHandler` already, and its handler sets
  // nothing off.
  // Not when answering a fault: the drain that failed would run, and fail,
  // again while the error is being rendered, and lose its Graph body.
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.method !== 'GET' && request.url.startsWith('/__mock/') && reply.statusCode < 500) await flushOnce(request)
    return payload
  })

  /**
   * A read flushes BEFORE it answers, not after.
   *
   * `onSend` runs once the handler has already built its payload, which is the
   * right moment for a write — the deliveries it causes do not exist until it
   * runs. For a read it is one moment too late: `/__mock/state` would report a
   * delivery count taken before the queue it is about to drain, so the endpoint
   * meant to be pasted into bug reports would be off by one. That is the same
   * class of lie as #3, and not one to reintroduce next to its fix.
   *
   * Reads only, deliberately. Draining ahead of `POST /__mock/reset` would push
   * the previous test's webhooks into the receiver on the way to clearing them,
   * which is the opposite of what a reset is for.
   */
  app.addHook('preHandler', async (request) => {
    if (request.method === 'GET' && request.url.startsWith('/__mock/')) await flushOnce(request)
  })

  registerControlRoutes(app, engine)

  app.post<{ Params: { version: string; phoneNumberId: string } }>(
    '/:version/:phoneNumberId/messages',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) {
        return reply.callNotFound()
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(
        engine.postMessages(request.params.phoneNumberId, body, graphToken(request)),
      )
    },
  )

  // --- tech provider (spec §9) ---------------------------------------------
  // Registered BEFORE the catch-all `/:version/:objectId` so they win the
  // route match.

  app.get<{ Params: { version: string }; Querystring: Record<string, string> }>(
    '/:version/oauth/access_token',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const { client_id: clientId, client_secret: clientSecret, code } = request.query
      if (!clientId || !clientSecret || !code) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'client_id, client_secret and code are all required',
        })
      }
      return reply.send(engine.exchangeCode(clientId, clientSecret, code))
    },
  )

  app.get<{ Params: { version: string }; Querystring: Record<string, string> }>(
    '/:version/debug_token',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      // The app token goes in the query or, like any Graph token, in the
      // Authorization header.
      const inputToken = request.query['input_token']
      const accessToken = request.query['access_token'] ?? bearerToken(request.headers)
      if (!inputToken || !accessToken) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'input_token and access_token are both required',
        })
      }
      return reply.send(engine.debugToken(inputToken, accessToken))
    },
  )

  app.post<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/subscribed_apps',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(
        await engine.subscribeAppVerified(request.params.wabaId, (request.body ?? {}) as Record<string, unknown>),
      )
    },
  )

  app.delete<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/subscribed_apps',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(engine.unsubscribeApp(request.params.wabaId))
    },
  )

  app.get<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/subscribed_apps',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(engine.listSubscribedApps(request.params.wabaId))
    },
  )

  // --- media (spec §5.5) ---------------------------------------------------

  /**
   * Every Graph call carries a token, and a token wamock issued is checked on
   * every route: expired or revoked fails with 190 wherever it is used. Only
   * the send route and app subscription used to check it, so an integration's
   * expired-token handling was exercised on sends and nowhere else.
   *
   * The two token endpoints themselves authenticate differently (client
   * secret, app token) and are left alone.
   *
   * The object and edge come from the matched route and its decoded params,
   * never from the raw URL: `%50NID_…` routes to `PNID_…`, so a check on the
   * raw text would authorize one object and serve another.
   */
  // A parameter given twice reaches a handler as an array. Every route reads
  // its query as single values, and a repeated `access_token` would have
  // slipped past the token check, so it is refused for all of them at once.
  // Meta documents no handling of a repeated parameter; refusing it is
  // wamock's choice, made so the token check cannot be skipped.
  app.addHook('preHandler', async (request) => {
    const repeated = Object.entries((request.query ?? {}) as Record<string, unknown>).find(([, value]) => Array.isArray(value))
    if (repeated) {
      throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: `Param ${repeated[0]} is given more than once` })
    }
  })

  app.addHook('preHandler', async (request) => {
    const params = (request.params ?? {}) as Record<string, string | undefined>
    const route = request.routeOptions.url ?? ''
    if (params['version'] === undefined || !VERSION_PATTERN.test(params['version'])) return
    if (route === '/:version/oauth/access_token' || route === '/:version/debug_token') return
    const objectId = params['phoneNumberId'] ?? params['wabaId'] ?? params['objectId']
    const edge = route.split('/')[3]
    engine.assertAccessToken(graphToken(request), {
      ...(objectId !== undefined ? { objectId } : {}),
      ...(edge !== undefined ? { edge } : {}),
      method: request.method === 'DELETE' ? 'delete' : request.method === 'POST' ? 'post' : 'get',
    })
  })

  app.get<{ Params: { version: string; wabaId: string }; Querystring: Record<string, string> }>(
    '/:version/:wabaId/phone_numbers',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const fields = (request.query['fields'] ?? '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
      // Meta documents the sort both as `['last_onboarded_time_ascending']`
      // and as `last_onboarded_time.asc`; either means oldest first.
      const sort = request.query['sort'] ?? ''
      return reply.send(
        engine.listPhoneNumbers(request.params.wabaId, {
          fields,
          ascending: sort.includes('last_onboarded_time_ascending') || sort.includes('last_onboarded_time.asc'),
          ...(request.query['sort'] !== undefined ? { sort } : {}),
          ...pagingQuery(request),
        }),
      )
    },
  )

  // Putting a number on Cloud API: create, request a code, verify, register.
  // `request_code` and `verify_code` take their parameters in the query, as
  // Meta's examples do, or in the body (its other example posts a form).
  const params = (request: FastifyRequest): Record<string, unknown> => ({
    ...((request.body ?? {}) as Record<string, unknown>),
    ...(request.query as Record<string, unknown>),
  })
  app.post<{ Params: { version: string; wabaId: string } }>('/:version/:wabaId/phone_numbers', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.createPhoneNumber(request.params.wabaId, (request.body ?? {}) as Record<string, unknown>))
  })
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/request_code', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.requestVerificationCode(request.params.phoneNumberId, params(request)))
  })
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/verify_code', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.verifyCode(request.params.phoneNumberId, params(request)))
  })
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/register', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.registerPhoneNumber(request.params.phoneNumberId, (request.body ?? {}) as Record<string, unknown>))
  })
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/deregister', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.deregisterPhoneNumber(request.params.phoneNumberId))
  })

  // The Block Users API: block, unblock and list a number's blocked customers.
  app.post<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/block_users', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.blockUsers(request.params.phoneNumberId, (request.body ?? {}) as Record<string, unknown>))
  })
  app.delete<{ Params: { version: string; phoneNumberId: string } }>('/:version/:phoneNumberId/block_users', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(engine.unblockUsers(request.params.phoneNumberId, (request.body ?? {}) as Record<string, unknown>))
  })
  app.get<{ Params: { version: string; phoneNumberId: string }; Querystring: Record<string, string> }>(
    '/:version/:phoneNumberId/block_users',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(engine.listBlockedUsers(request.params.phoneNumberId, pagingQuery(request)))
    },
  )

  // Coexistence: request the Business app's contacts or chat history, once
  // each, within 24 hours of onboarding.
  app.post<{ Params: { version: string; phoneNumberId: string } }>(
    '/:version/:phoneNumberId/smb_app_data',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(engine.syncBusinessAppData(request.params.phoneNumberId, body))
    },
  )

  app.post<{ Params: { version: string; phoneNumberId: string } }>(
    '/:version/:phoneNumberId/media',
    // Documents go up to 100 MB; leave room for the multipart framing. This
    // route alone: everywhere else keeps the server's limit.
    { bodyLimit: MULTIPART_BODY_LIMIT },
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(engine.uploadMedia(request.params.phoneNumberId, body))
    },
  )

  /**
   * `GET /{version}/{object_id}` — Graph's generic object fetch. It serves both
   * media metadata and phone-number fields, so it dispatches on which object
   * the id names. Registered last, after every more specific route.
   */
  app.get<{
    Params: { version: string; objectId: string }
    Querystring: { fields?: string; phone_number_id?: string }
  }>(
    '/:version/:objectId',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const { objectId } = request.params

      const fields = (request.query.fields ?? '')
        .split(',')
        .map((field) => field.trim())
        .filter(Boolean)
      if (engine.state.phoneNumber(objectId)) return reply.send(engine.getPhoneNumberFields(objectId, fields))
      if (engine.state.waba(objectId)) return reply.send(engine.getWabaFields(objectId, fields))

      // The download URL points back at this server, so a client that only
      // knows a base URL can fetch the bytes too; through the interceptor it
      // is Meta's lookaside URL, which the interceptor routes here.
      const baseUrl = publicBase(request)
      return reply.send(
        engine.getMedia(objectId, {
          ...(request.query.phone_number_id !== undefined ? { phoneNumberId: request.query.phone_number_id } : {}),
          ...(baseUrl !== undefined ? { baseUrl } : {}),
        }),
      )
    },
  )

  /**
   * `POST /{version}/{phone_number_id}`: of the settings Meta takes here,
   * wamock emulates `webhook_configuration`, the number's own callback URL.
   */
  app.post<{ Params: { version: string; objectId: string } }>('/:version/:objectId', async (request, reply) => {
    if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
    return reply.send(
      await engine.configurePhoneNumber(request.params.objectId, (request.body ?? {}) as Record<string, unknown>),
    )
  })

  /** `DELETE /{version}/{media_id}`. */
  app.delete<{ Params: { version: string; objectId: string }; Querystring: { phone_number_id?: string } }>(
    '/:version/:objectId',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(
        engine.deleteMedia(request.params.objectId, {
          ...(request.query.phone_number_id !== undefined ? { phoneNumberId: request.query.phone_number_id } : {}),
        }),
      )
    },
  )

  /**
   * A media download URL. It needs a bearer token, like Meta's, and answers
   * 404 once the URL is more than 5 minutes old: the cure is to look the media
   * id up again for a fresh URL.
   */
  app.get<{ Querystring: { mid?: string; ext?: string; hash?: string } }>(DOWNLOAD_PATH, async (request, reply) => {
    const token = bearerToken(request.headers)
    if (token === undefined) {
      const error = new GraphError(ERROR_CODES.TOKEN_INVALID)
      return reply.status(401).send(error.toBody(engine.nextFbtraceId()))
    }
    // The bytes are the media's, so the token needs what reading the media
    // needs: the messaging permission and, for a business token, ownership.
    if (request.query.mid !== undefined) engine.assertAccessToken(token, { objectId: request.query.mid, method: 'get' })
    else engine.assertAccessToken(token)
    const media = engine.downloadMedia(request.query)
    if (!media) return reply.status(404).send()
    return reply.header('content-type', media.mimeType).send(media.bytes)
  })

  // --- message templates (spec §5.3) --------------------------------------

  app.post<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/message_templates',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(engine.createTemplate(request.params.wabaId, body))
    },
  )

  app.get<{ Params: { version: string; wabaId: string }; Querystring: Record<string, string> }>(
    '/:version/:wabaId/message_templates',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const { name } = request.query
      return reply.send(
        engine.listTemplates(request.params.wabaId, { ...(name !== undefined ? { name } : {}), ...pagingQuery(request) }),
      )
    },
  )

  app.delete<{ Params: { version: string; wabaId: string }; Querystring: { name?: string } }>(
    '/:version/:wabaId/message_templates',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const name = request.query.name
      if (!name) {
        throw new GraphError(ERROR_CODES.INVALID_PARAMETER, { details: 'Param name is required' })
      }
      return reply.send(engine.deleteTemplate(request.params.wabaId, name))
    },
  )

  return app
}
