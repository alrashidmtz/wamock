import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'

import { registerControlRoutes } from './control/routes.js'
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

export interface ServerOptions {
  /** Emit a line per request. Off by default so tests stay quiet. */
  logger?: boolean
}

export function createServer(engine: WamockEngine, options: ServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })

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

  registerControlRoutes(app, engine)

  app.post<{ Params: { version: string; phoneNumberId: string } }>(
    '/:version/:phoneNumberId/messages',
    async (request, reply) => {
      if (!VERSION_PATTERN.test(request.params.version)) {
        return reply.callNotFound()
      }
      const body = (request.body ?? {}) as Record<string, unknown>
      return reply.send(engine.sendMessage(request.params.phoneNumberId, body))
    },
  )

  return app
}
