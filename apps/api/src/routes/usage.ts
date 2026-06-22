import type { FastifyInstance } from "fastify";

/**
 * Usage routes.
 *
 * `/usage/cost` was removed — cost calculation against a static rate
 * table produced stale/mismatched "$0.00" figures. Token counts are
 * available via `/usage/today` (recent records) and `/tasks/:id/usage`
 * (per-task aggregate from `token_usage_records`).
 */

export async function registerUsageRoutes(_app: FastifyInstance) {
  // No routes currently registered here.
  // Kept as a registration stub so app.ts doesn't need editing.
}
