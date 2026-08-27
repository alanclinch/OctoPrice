/**
 * Fastify adapter for the API.
 *
 * All the behaviour lives in `handler.ts`; this only translates a Fastify
 * request into the plain shape that handler expects, and its plain response
 * back out again. The Worker adapter in `worker.ts` does the same job for the
 * production runtime, so both run identical routing and identical
 * authentication.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { handleApiRequest, type ApiContext } from './handler.ts';

export type { ApiContext } from './handler.ts';

export function createApiRoutes(context: ApiContext): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    // One catch-all: the handler owns method and path matching, so routing
    // cannot drift between the two runtimes.
    app.all('/*', async (request, reply) => {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`);

      const response = await handleApiRequest(context, {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: {
          cookie: request.headers.cookie ?? null,
          authorization: request.headers.authorization ?? null,
        },
        body: request.body,
        origin: `${request.protocol}://${request.headers.host ?? 'localhost'}`,
      });

      for (const [name, value] of Object.entries(response.headers ?? {})) {
        void reply.header(name, value);
      }

      if (response.body === undefined) return reply.status(response.status).send();
      return reply.status(response.status).send(response.body);
    });
  };
}
