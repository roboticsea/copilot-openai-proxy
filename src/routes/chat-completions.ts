import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { ConversationBridge } from "../copilot/conversation.js";
import { bearerMatches, requireServeApiKey, type ProxyConfig } from "../config.js";
import { OpenAIEventTranslator } from "../openai/stream.js";
import { parseChatCompletionRequest } from "../openai/request.js";

export function registerChatCompletionsRoute(app: FastifyInstance, config: ProxyConfig, conversations: ConversationBridge, diagnostic?: (event: Record<string, unknown>) => void): void {
  app.post("/v1/chat/completions", async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, requireServeApiKey(config))) {
      return reply.status(401).send({ error: { message: "Invalid bearer token", type: "authentication_error", code: "invalid_api_key" } });
    }
    const body = parseChatCompletionRequest(request.body);
    diagnostic?.({
      kind: "chat.request",
      requestId: request.id,
      model: body.model,
      stream: body.stream,
      messageRoles: body.messages.map((message) => message.role),
      toolNames: body.tools.map((tool) => tool.function.name),
      toolResultIds: body.messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    });
    const controller = new AbortController();
    let cleanToolCompletion = false;
    let conversationId: string | undefined;
    const translator = new OpenAIEventTranslator({
      model: body.model,
      streaming: body.stream,
      onToolTurn: (ids, names) => {
        cleanToolCompletion = ids.length > 0;
        diagnostic?.({ kind: "chat.tool_turn", requestId: request.id, conversationId, toolCallIds: ids });
        if (conversationId) conversations.markToolCalls(conversationId, ids, names);
      },
    });
    const close = () => {
      if (cleanToolCompletion) return;
      if (!controller.signal.aborted) controller.abort();
      if (conversationId) void conversations.abort(conversationId);
    };
    const socket = request.raw.socket;
    socket.once("close", close);
    reply.raw.once("close", close);
    try {
      const started = await conversations.start(body.model, body.messages, body.tools, translator, controller.signal);
      conversationId = started.conversationId;
      void started.send().catch((error: unknown) => translator.abort(error instanceof Error ? error : new Error("SDK send failed")));
      if (body.stream) {
        reply.headers({ "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
        const stream = Readable.from(translator.frames());
        stream.once("close", () => {
          socket.removeListener("close", close);
          reply.raw.removeListener("close", close);
        });
        return reply.send(stream);
      }
      return reply.send(await translator.jsonResponse());
    } catch (error) {
      close();
      throw error;
    } finally {
      if (!body.stream) {
        socket.removeListener("close", close);
        reply.raw.removeListener("close", close);
      }
    }
  });
}

