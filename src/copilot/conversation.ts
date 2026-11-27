import { randomUUID } from "node:crypto";
import type { CopilotSession, SessionEvent } from "@microsoft/copilot-sdk";
import type { CopilotAdapter } from "./copilot-adapter.js";
import { DeferredToolCalls } from "./deferred-tool-calls.js";
import { OpenAIRequestError, replayPromptFrom, systemMessagesFrom, type OpenAIMessage } from "../openai/messages.js";
import { externalToolDefinitions, type OpenAIFunctionTool } from "../openai/tools.js";
import { RateLimitError } from "../server.js";
export interface ConversationEventSink {
  publish(event: SessionEvent): void;
}

interface Conversation {
  session: CopilotSession;
  deferred: DeferredToolCalls;
  lastActivity: number;
  sink: ConversationEventSink | undefined;
  unsubscribe: () => void;
  destroyed: boolean;
  controller: AbortController;
  ignoreNextTurnEnd: boolean;
}

const INJECTED_LOCAL_CALL_PREFIXES = ["rag_auto_", "conv_recall_"] as const;
const DEFAULT_MAX_CONVERSATIONS = 64;

export class ConversationBridge {
  private readonly conversations = new Map<string, Conversation>();
  private readonly idByToolCall = new Map<string, string>();
  private readonly idleTimer: NodeJS.Timeout;

  constructor(
    private readonly adapter: CopilotAdapter,
    private readonly idleTimeoutMs = 15 * 60 * 1000,
    private readonly diagnostic?: (event: Record<string, unknown>) => void,
    private readonly maxConversations = DEFAULT_MAX_CONVERSATIONS,
  ) {
    this.idleTimer = setInterval(() => void this.expireIdle(), 60_000);
    this.idleTimer.unref();
  }

  async start(model: string, messages: readonly OpenAIMessage[], tools: readonly OpenAIFunctionTool[], sink: ConversationEventSink, signal?: AbortSignal, correlateResults = true): Promise<{ conversationId: string; send: () => Promise<string> }> {
    if (correlateResults && messages.at(-1)?.role === "tool") {
      return this.resume(model, messages, tools, sink, signal);
    }
    if (model === "default") throw new OpenAIRequestError('model must be an opaque Copilot model ID; "default" is reserved');
    await this.ensureCapacity();
    const id = randomUUID();
    const deferred = new DeferredToolCalls();
    const definitions = externalToolDefinitions(tools, (name) => async (arguments_, invocation) => {
      this.idByToolCall.set(invocation.toolCallId, id);
      this.diagnostic?.({ kind: "copilot.tool.handler", conversationId: id, toolCallId: invocation.toolCallId, toolName: name });
      return deferred.defer({ toolCallId: invocation.toolCallId, toolName: name, arguments: arguments_ });
    });
    const systemMessage = systemMessagesFrom(messages);
    const session = await this.adapter.createSession({
      model,
      ...(systemMessage ? { systemMessage: { mode: "append" as const, content: systemMessage } } : {}),
      tools: {
        availableTools: definitions.map((tool) => `custom:${tool.name}`),
        definitions,
        excludedTools: ["builtin:*", "mcp:*"],
      },
    });
    const controller = new AbortController();
    const conversation: Conversation = {
      session,
      deferred,
      lastActivity: Date.now(),
      sink,
      unsubscribe: () => undefined,
      destroyed: false,
      controller,
      ignoreNextTurnEnd: false,
    };
    conversation.unsubscribe = session.on((event) => this.forward(id, event));
    this.conversations.set(id, conversation);
    signal?.addEventListener("abort", () => void this.abort(id), { once: true });
    return { conversationId: id, send: async () => session.send({ prompt: replayPromptFrom(messages) }) };
  }

  async resume(model: string, history: readonly OpenAIMessage[], tools: readonly OpenAIFunctionTool[], sink: ConversationEventSink, signal?: AbortSignal): Promise<{ conversationId: string; send: () => Promise<string> }> {
    const { results, calls, hasExtraTrailingResults } = trailingToolTurn(history);
    if (results.some((message) => !message.tool_call_id)) {
      throw new OpenAIRequestError("every tool message must contain tool_call_id");
    }
    if (hasExtraTrailingResults || calls.length === 0) {
      this.diagnostic?.({ kind: "tool.result.correlation_failed", incomingIds: results.map((result) => result.tool_call_id), pending: [...this.conversations.values()].map((conversation) => conversation.deferred.pendingIds()) });
      throw new OpenAIRequestError("tool_call_id does not match one active conversation");
    }
    if (calls.every((call) => INJECTED_LOCAL_CALL_PREFIXES.some((prefix) => call.id.startsWith(prefix)))) {
      this.diagnostic?.({ kind: "tool.history.replayed", incomingIds: calls.map((call) => call.id) });
      return this.start(model, history, tools, sink, signal, false);
    }
    const directOwners = new Set(results.map((message) => message.tool_call_id).filter((id): id is string => Boolean(id)).map((id) => this.idByToolCall.get(id)).filter(Boolean));
    let id = directOwners.size === 1 ? [...directOwners][0] : undefined;
    let aliases = new Map<string, string>();
    if (!id && directOwners.size === 0) {
      const matches: Array<{ conversationId: string; aliases: Map<string, string> }> = [];
      for (const [conversationId, conversation] of this.conversations.entries()) {
        const aliasMap = matchRenamedPendingCalls(calls, conversation.deferred.pendingCalls());
        if (aliasMap) matches.push({ conversationId, aliases: aliasMap });
      }
      if (matches.length === 1) {
        id = matches[0]!.conversationId;
        aliases = matches[0]!.aliases;
      }
    }
    if (!id) {
      this.diagnostic?.({ kind: "tool.result.correlation_failed", incomingIds: calls.map((call) => call.id), pending: [...this.conversations.values()].map((conversation) => conversation.deferred.pendingIds()) });
      throw new OpenAIRequestError("tool_call_id does not match one active conversation");
    }
    const conversation = this.conversations.get(id)!;
    this.diagnostic?.({ kind: "tool.result.correlated", conversationId: id, incomingIds: results.map((result) => result.tool_call_id), pendingIds: conversation.deferred.pendingIds() });
    conversation.sink = sink;
    conversation.lastActivity = Date.now();
    conversation.ignoreNextTurnEnd = true;
    conversation.deferred.resolveFromOpenAI(results, aliases);
    signal?.addEventListener("abort", () => void this.abort(id!), { once: true });
    return {
      conversationId: id,
      send: async () => conversation.session.send({
        prompt: "The external tool results have been received. Continue from them and provide the assistant's final answer. Do not repeat completed tool calls.",
      }),
    };
  }

  markToolCalls(conversationId: string, ids: readonly string[], names?: ReadonlyMap<string, string>): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.deferred.beginRound(ids, names);
    for (const id of ids) this.idByToolCall.set(id, conversationId);
  }

  async abort(conversationId: string): Promise<void> {
    await this.destroy(conversationId, new Error("conversation aborted"));
  }

  async stop(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.conversations.keys()].map((id) => this.destroy(id, new Error("proxy stopping"))));
  }

  private async ensureCapacity(): Promise<void> {
    if (this.conversations.size < this.maxConversations) return;
    await this.expireIdle();
    if (this.conversations.size >= this.maxConversations) {
      throw new RateLimitError("Too many active conversations; wait for pending tool calls to complete");
    }
  }

  private async destroy(conversationId: string, reason: Error): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.destroyed) return;
    conversation.destroyed = true;
    this.conversations.delete(conversationId);
    for (const [id, owner] of this.idByToolCall) if (owner === conversationId) this.idByToolCall.delete(id);
    conversation.controller.abort(reason);
    conversation.deferred.rejectAll(reason);
    conversation.unsubscribe();
    await conversation.session.abort().catch(() => undefined);
    await conversation.session.disconnect().catch(() => undefined);
    await this.adapter.deleteSession(conversation.session.sessionId).catch(() => undefined);
  }

  private forward(conversationId: string, event: SessionEvent): void {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    conversation.lastActivity = Date.now();
    this.diagnostic?.({
      kind: "copilot.event",
      conversationId,
      eventType: event.type,
      ...(event.type === "assistant.tool_call_delta" ? { toolCallId: event.data.toolCallId, toolName: event.data.toolName, inputBytes: Buffer.byteLength(event.data.inputDelta) } : {}),
      ...(event.type === "assistant.message_delta" ? { contentBytes: Buffer.byteLength(event.data.deltaContent) } : {}),
    });
    if (event.type === "assistant.turn_end" && conversation.ignoreNextTurnEnd) {
      conversation.ignoreNextTurnEnd = false;
      this.diagnostic?.({ kind: "copilot.turn_end.suppressed", conversationId });
      return;
    }
    conversation.sink?.publish(event);
    if (event.type === "assistant.turn_end") {
      if (conversation.deferred.hasActiveRound() === false) void this.destroy(conversationId, new Error("conversation complete"));
      else conversation.sink = undefined;
    }
  }
  private async expireIdle(): Promise<void> {
    const deadline = Date.now() - this.idleTimeoutMs;
    await Promise.all([...this.conversations.entries()].filter(([, conversation]) => conversation.lastActivity < deadline).map(([id]) => this.destroy(id, new Error("conversation idle timeout"))));
  }
}

function isRenamedCallId(incomingId: string, pendingId: string): boolean {
  if (incomingId === pendingId) return true;
  if (!incomingId.startsWith(`${pendingId}_`)) return false;
  const suffix = incomingId.slice(pendingId.length + 1);
  return /^\d+_\d+(?:_\d+)?$/.test(suffix);
}

function matchRenamedPendingCalls(
  calls: NonNullable<OpenAIMessage["tool_calls"]>,
  pending: ReadonlyArray<{ id: string; name: string | undefined }>,
): Map<string, string> | undefined {
  if (calls.length === 0 || calls.length !== pending.length) return undefined;
  const aliases = new Map<string, string>();
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]!;
    const expected = pending[index]!;
    if (!isRenamedCallId(call.id, expected.id)) return undefined;
    if (expected.name && call.function.name !== expected.name) return undefined;
    aliases.set(call.id, expected.id);
  }
  return aliases;
}

function trailingToolTurn(messages: readonly OpenAIMessage[]): {
  results: OpenAIMessage[];
  calls: NonNullable<OpenAIMessage["tool_calls"]>;
  hasExtraTrailingResults: boolean;
} {
  let cursor = messages.length - 1;
  while (cursor >= 0 && messages[cursor]!.role === "tool") cursor -= 1;
  const trailingResults = messages.slice(cursor + 1);
  const preceding = cursor >= 0 ? messages[cursor] : undefined;
  if (!preceding || preceding.role !== "assistant" || !preceding.tool_calls?.length) {
    return { results: trailingResults, calls: [], hasExtraTrailingResults: trailingResults.length > 0 };
  }
  const expected = new Set(preceding.tool_calls.map((call) => call.id));
  const matched = trailingResults.filter((candidate) => candidate.tool_call_id !== undefined && expected.has(candidate.tool_call_id));
  const hasExtraTrailingResults = matched.length !== trailingResults.length;
  return { results: matched, calls: preceding.tool_calls, hasExtraTrailingResults };
}
