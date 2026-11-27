import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@microsoft/copilot-sdk";
import type { ConversationEventSink } from "../copilot/conversation.js";

export interface StreamOptions {
  model: string;
  streaming: boolean;
  onToolTurn?: (ids: readonly string[], names: ReadonlyMap<string, string>) => void;
}

export interface CompletionToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export class OpenAIEventTranslator implements ConversationEventSink {
  readonly id = `chatcmpl-${randomUUID()}`;
  readonly created = Math.floor(Date.now() / 1000);
  private readonly chunks: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private readonly toolIndices = new Map<string, number>();
  private readonly toolCalls = new Map<string, CompletionToolCall>();
  private readonly deltaMessageIds = new Set<string>();
  private readonly completion = Promise.withResolvers<void>();
  private content = "";
  private reasoning = "";
  private done = false;
  private toolTurnEnded = false;
  private failed: Error | undefined;

  constructor(private readonly options: StreamOptions) {}

  publish(event: SessionEvent): void {
    if (this.done || event.agentId) return;
    if (event.type === "assistant.message_delta") {
      this.deltaMessageIds.add(event.data.messageId);
      this.content += event.data.deltaContent;
      this.pushChunk({ delta: { content: event.data.deltaContent }, finish_reason: null });
      return;
    }
    if (event.type === "assistant.message") {
      if (!this.deltaMessageIds.has(event.data.messageId)) {
        if (event.data.content) {
          this.content += event.data.content;
          this.pushChunk({ delta: { content: event.data.content }, finish_reason: null });
        }
        if (!this.reasoning && event.data.reasoningText) {
          this.reasoning += event.data.reasoningText;
          this.pushChunk({ delta: { reasoning_content: event.data.reasoningText }, finish_reason: null });
        }
      }
      for (const request of event.data.toolRequests ?? []) {
        if (this.toolCalls.has(request.toolCallId)) continue;
        const index = this.toolIndices.size;
        const argumentsText = JSON.stringify(request.arguments ?? {});
        this.toolIndices.set(request.toolCallId, index);
        this.toolCalls.set(request.toolCallId, { id: request.toolCallId, type: "function", function: { name: request.name, arguments: argumentsText } });
        this.pushChunk({
          delta: { tool_calls: [{ index, id: request.toolCallId, type: "function", function: { name: request.name, arguments: argumentsText } }] },
          finish_reason: null,
        });
      }
      if (event.data.toolRequests?.length) this.endToolTurn();
      return;
    }
    if (event.type === "assistant.reasoning_delta") {
      this.reasoning += event.data.deltaContent;
      this.pushChunk({ delta: { reasoning_content: event.data.deltaContent }, finish_reason: null });
      return;
    }
    if (event.type === "assistant.tool_call_delta") {
      const id = event.data.toolCallId;
      let index = this.toolIndices.get(id);
      if (index === undefined) {
        index = this.toolIndices.size;
        this.toolIndices.set(id, index);
        this.toolCalls.set(id, { id, type: "function", function: { name: event.data.toolName ?? "", arguments: "" } });
      }
      const call = this.toolCalls.get(id)!;
      call.function.arguments += event.data.inputDelta;
      if (event.data.toolName && !call.function.name) call.function.name = event.data.toolName;
      this.pushChunk({
        delta: {
          tool_calls: [{
            index,
            id,
            type: "function",
            function: { name: event.data.toolName, arguments: event.data.inputDelta },
          }],
        },
        finish_reason: null,
      });
      return;
    }
    if (event.type === "assistant.turn_end") {
      const ids = [...this.toolIndices.keys()];
      if (ids.length > 0) this.endToolTurn();
      else {
        this.options.onToolTurn?.([], new Map());
        this.pushChunk({ delta: {}, finish_reason: "stop" });
        this.finish();
      }
      return;
    }
    if (event.type.includes("error") || event.type.includes("quota") || event.type.includes("auth")) {
      this.fail(new Error("GitHub Copilot request failed"));
    }
  }

  abort(reason: Error = new Error("Request aborted")): void {
    this.fail(reason);
  }

  async *frames(): AsyncGenerator<string> {
    while (true) {
      while (this.chunks.length > 0) yield this.chunks.shift()!;
      if (this.done) return;
      await this.nextChunk();
    }
  }

  async jsonResponse(): Promise<Record<string, unknown>> {
    await this.completion.promise;
    if (this.failed) throw this.failed;
    const message: Record<string, unknown> = this.content ? { role: "assistant", content: this.content } : { role: "assistant", content: null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.size > 0) message.tool_calls = [...this.toolCalls.values()];
    return {
      id: this.id,
      object: "chat.completion",
      created: this.created,
      model: this.options.model,
      choices: [{ index: 0, message, finish_reason: this.toolCalls.size > 0 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  private endToolTurn(): void {
    if (this.toolTurnEnded || this.done) return;
    this.toolTurnEnded = true;
    const ids = [...this.toolIndices.keys()];
    const names = new Map<string, string>();
    for (const id of ids) {
      const name = this.toolCalls.get(id)?.function.name;
      if (name) names.set(id, name);
    }
    this.options.onToolTurn?.(ids, names);
    this.pushChunk({ delta: {}, finish_reason: "tool_calls" });
    this.finish();
  }

  private pushChunk(choice: Record<string, unknown>): void {
    if (!this.options.streaming) return;
    const payload = { id: this.id, object: "chat.completion.chunk", created: this.created, model: this.options.model, choices: [{ index: 0, ...choice }] };
    this.chunks.push(`data: ${JSON.stringify(payload)}\n\n`);
    this.wake();
  }

  private finish(): void {
    if (this.done) return;
    this.done = true;
    if (this.options.streaming) {
      this.chunks.push("data: [DONE]\n\n");
      this.wake();
    }
    this.completion.resolve();
  }

  private fail(error: Error): void {
    if (this.done) return;
    this.failed = error;
    this.done = true;
    if (this.options.streaming) {
      this.chunks.push(`data: ${JSON.stringify({ error: { message: "GitHub Copilot request failed", type: "api_error", code: "upstream_error" } })}\n\n`);
      this.wake();
    }
    this.completion.reject(error);
  }
  private async nextChunk(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.push(resolve);
    await promise;
  }

  private wake(): void {
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
