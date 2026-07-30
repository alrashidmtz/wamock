import Fastify from 'fastify'
import type { FastifyBodyParser, FastifyInstance } from 'fastify'

import { registerControlRoutes } from './control/routes.js'
import { DEFAULT_SETTLE_TIMEOUT_MS } from './core/engine.js'
import type { WamockEngine } from './core/engine.js'
import { ERROR_CODES, GraphError } from './errors/graph-error.js'

/**
 * The HTTP shell. Everything here is routing and error rendering; the
 * behaviour lives in the engine, so server mode and library mode cannot drift.
 */

/**
 * Graph version segment. Real integrations pin anything from v17 to v23, and a
 * mock that only answers on one of them fails for reasons that have nothing to
 * do with the code under test (spec §5.1).
 */
const VERSION_PATTERN = /^v\d+\.\d+$/

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

export function createServer(engine: WamockEngine, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? false,
    // Explicit rather than inherited: a mock accepts arbitrary bodies from
    // whatever is under test, and 1 MiB is far above any real WhatsApp payload.
    bodyLimit: options.bodyLimit ?? 1024 * 1024,
  })

  // Every failure leaves as a Meta-shaped body. A fastify-shaped error would
  // teach the integration under test to parse something Meta never sends.
  app.setErrorHandler((error: unknown, _request, reply) => {
    const graphError =
      error instanceof GraphError
        ? error
        : new GraphError(ERROR_CODES.INVALID_PARAMETER, {
            details: error instanceof Error ? error.message : String(error),
          })
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
    try {
      done(null, JSON.parse(raw))
    } catch {
      done(
        new GraphError(ERROR_CODES.INVALID_PARAMETER, {
          details: 'Body is not valid JSON. The control API reads every body as JSON.',
        }),
        undefined,
      )
    }
  }

  // The catch-all covers what curl's `-d` sends. `text/plain` needs naming
  // separately because Fastify parses it itself, handing the route a string
  // that then failed validation as "Expected object, received string" — a
  // message that describes the symptom and hides the cause.
  app.addContentTypeParser('*', { parseAs: 'string' }, parseControlBody)
  app.addContentTypeParser('text/plain', { parseAs: 'string' }, parseControlBody)

  /**
   * Hand over the webhooks this control call triggered before answering it.
   *
   * The library helpers have always done this (`createWamock`'s `flush`), and
   * the HTTP door did not — so `POST /__mock/quality` changed the rating,
   * returned 200, and delivered nothing until something moved the clock. The
   * README promises it "announces it"; this is what makes that true (#4).
   *
   * A hook rather than a line per route: it covers inbound, statuses, quality,
   * template transitions and `time/advance` at once, and any control endpoint
   * added later is born correct. Scoped to `/__mock/` on purpose — the Graph
   * routes schedule their statuses at +50ms and +500ms, which are deliberately
   * NOT due yet, and must keep needing a real `advance()`.
   */
  const settleTimeoutMs = options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS
  app.addHook('onSend', async (request, _reply, payload) => {
    if (request.url.startsWith('/__mock/')) await engine.flush(settleTimeoutMs)
    return payload
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
        engine.sendMessage(request.params.phoneNumberId, body, bearerToken(request.headers)),
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
      const { input_token: inputToken, access_token: accessToken } = request.query
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
      return reply.send(engine.subscribeApp(request.params.wabaId, bearerToken(request.headers)))
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

  app.post<{ Params: { version: string; phoneNumberId: string } }>(
    '/:version/:phoneNumberId/media',
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
  app.get<{ Params: { version: string; objectId: string }; Querystring: { fields?: string } }>(
    '/:version/:objectId',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const { objectId } = request.params

      if (engine.state.phoneNumber(objectId)) {
        const fields = (request.query.fields ?? '')
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean)
        return reply.send(engine.getPhoneNumberFields(objectId, fields))
      }

      return reply.send(engine.getMedia(objectId))
    },
  )

  // --- message templates (spec §5.3) --------------------------------------

  app.post<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/message_templates',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(engine.createTemplate(request.params.wabaId, body))
    },
  )

  app.get<{ Params: { version: string; wabaId: string } }>(
    '/:version/:wabaId/message_templates',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) return reply.callNotFound()
      return reply.send(engine.listTemplates(request.params.wabaId))
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
