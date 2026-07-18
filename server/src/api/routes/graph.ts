/**
 * GET /api/v1/graph — the vault's wikilink graph for the in-dashboard graph view
 * (SPEC.md §12.4). READ-ONLY, derived entirely from the filesystem; the per-file parse
 * cache in GraphBuilder makes repeat requests cheap even as the vault grows.
 */

import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../server.js'
import { GraphBuilder } from '../../pipeline/graph.js'

export function registerGraphRoute(app: FastifyInstance, ctx: AppContext, builder?: GraphBuilder): void {
  const graph = builder ?? new GraphBuilder(ctx.config.vaultRoot)

  app.get('/api/v1/graph', async () => {
    return graph.build()
  })
}
