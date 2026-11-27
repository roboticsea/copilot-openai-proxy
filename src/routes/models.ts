import type { FastifyInstance } from "fastify";
import type { CopilotAdapter } from "../copilot/copilot-adapter.js";
import { bearerMatches, requireServeApiKey, type ProxyConfig } from "../config.js";

export function registerModelsRoute(app: FastifyInstance, config: ProxyConfig, adapter: CopilotAdapter): void {
  app.get("/healthz", async () => ({ ok: true }));
  app.get("/v1/models", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, requireServeApiKey(config))) {
      return reply.status(401).send({ error: { message: "Invalid bearer token", type: "authentication_error", code: "invalid_api_key" } });
    }
    const models = await adapter.listModels();
    return {
      object: "list",
      data: models.filter((model) => typeof model.id === "string" && model.id.length > 0).map((model) => ({
        id: model.id,
        object: "model",
        owned_by: model.provider?.label || "github-copilot",
      })),
    };
  });
}
