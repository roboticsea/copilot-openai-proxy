import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { CopilotAdapter, ProxyAuthError } from "./copilot/copilot-adapter.js";
import { ConversationBridge } from "./copilot/conversation.js";
import type { ProxyConfig } from "./config.js";
import { OpenAIRequestError } from "./openai/messages.js";
import { registerChatCompletionsRoute } from "./routes/chat-completions.js";
import { registerModelsRoute } from "./routes/models.js";

export interface ServerDependencies {
  adapter?: CopilotAdapter;
  conversations?: ConversationBridge;
}

const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function safeRequestId(rawHeader: string | string[] | undefined): string {
  const candidate = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return typeof candidate === "string" && VALID_REQUEST_ID.test(candidate) ? candidate : randomUUID();
}

export class RateLimitError extends Error {
  readonly statusCode = 429;
  constructor(message = "Too many active tool conversations") {
    super(message);
    this.name = "RateLimitError";
  }
}

export function buildServer(config: ProxyConfig, dependencies: ServerDependencies = {}): { app: FastifyInstance; adapter: CopilotAdapter; conversations: ConversationBridge } {
  const diagnostic = config.verbose ? (event: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`) : undefined;
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: (req) => safeRequestId(req.headers["x-request-id"]) });
  const adapter = dependencies.adapter ?? new CopilotAdapter(config);
  const conversations = dependencies.conversations ?? new ConversationBridge(adapter, 15 * 60 * 1000, diagnostic);
  app.addHook("onRequest", async (request) => {
    diagnostic?.({ kind: "http.request", requestId: request.id, method: request.method, path: request.url.split("?", 1)[0] });
  });
  app.addHook("onResponse", async (request, reply) => {
    diagnostic?.({ kind: "http.response", requestId: request.id, method: request.method, path: request.url.split("?", 1)[0], statusCode: reply.statusCode, elapsedMs: Math.round(reply.elapsedTime) });
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error instanceof OpenAIRequestError ? 400 : error instanceof ProxyAuthError ? error.statusCode : error instanceof RateLimitError ? error.statusCode : 500;
    const type = status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error";
    const message = status >= 500 ? "Internal server error" : error instanceof Error ? error.message : "Invalid request";
    const code = status === 400 ? "invalid_request" : status === 401 ? "not_authenticated" : status === 429 ? "rate_limit_exceeded" : "internal_error";
    return reply.status(status).send({ error: { message, type, code } });
  });
  registerModelsRoute(app, config, adapter);
  registerChatCompletionsRoute(app, config, conversations, diagnostic);
  return { app, adapter, conversations };
}
