import type { FastifyInstance } from "fastify";

import { getAdapterHealthList } from "../services/adapter-health-service";

export async function registerAdapterRoutes(app: FastifyInstance) {
  const handler = async () => {
    const items = await getAdapterHealthList();
    return {
      ok: true,
      data: {
        items,
      },
    };
  };

  app.get("/adapters/health", handler);
  app.get("/workspace/adapters/health", handler);
}
