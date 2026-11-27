import { OpenAIRequestError, flattenContent, type OpenAIMessage } from "../openai/messages.js";

interface DeferredCall {
  id: string;
  name: string;
  arguments: unknown;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  resultStored?: unknown;
}

export class DeferredToolCalls {
  private readonly calls = new Map<string, DeferredCall>();
  private readonly registered = new Set<string>();
  private readonly namesById = new Map<string, string>();
  private expected = new Set<string>();
  private results = new Map<string, string>();
  defer(call: { toolCallId: string; toolName: string; arguments: unknown }): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    void promise.catch(() => undefined);
    const deferred: DeferredCall = { id: call.toolCallId, name: call.toolName, arguments: call.arguments, promise, resolve, reject };
    this.calls.set(call.toolCallId, deferred);
    this.registered.add(call.toolCallId);
    this.namesById.set(call.toolCallId, call.toolName);
    this.expected.add(call.toolCallId);
    this.releaseIfComplete();
    return promise;
  }

  beginRound(ids: readonly string[], names?: ReadonlyMap<string, string>): void {
    this.expected = new Set(ids);
    if (names) {
      for (const [id, name] of names) {
        if (name) this.namesById.set(id, name);
      }
    }
    this.results = new Map([...this.results].filter(([id]) => this.expected.has(id)));
    this.releaseIfComplete();
  }

  resolveFromOpenAI(messages: readonly OpenAIMessage[], aliases: ReadonlyMap<string, string> = new Map()): void {
    const toolMessages = messages.filter((message) => message.role === "tool");
    if (toolMessages.length === 0) return;
    for (const message of toolMessages) {
      const incomingId = message.tool_call_id;
      const id = incomingId ? aliases.get(incomingId) ?? incomingId : undefined;
      if (!id || !this.expected.has(id)) throw new OpenAIRequestError(`orphan or mismatched tool_call_id: ${incomingId ?? "missing"}`);
      this.results.set(id, flattenContent(message.content));
    }
    if (this.results.size !== this.expected.size) return;
    this.releaseIfComplete();
  }

  pendingIds(): string[] {
    return [...this.expected];
  }

  pendingCalls(): Array<{ id: string; name: string | undefined }> {
    return [...this.expected].map((id) => ({ id, name: this.namesById.get(id) }));
  }

  hasActiveRound(): boolean {
    return this.expected.size > 0;
  }

  rejectAll(reason: Error): void {
    for (const call of this.calls.values()) call.reject(reason);
    this.calls.clear();
    this.expected.clear();
    this.results.clear();
    this.namesById.clear();
  }

  private releaseIfComplete(): void {
    if (this.expected.size === 0 || this.results.size !== this.expected.size) return;
    for (const id of this.expected) {
      const call = this.calls.get(id);
      const result = this.results.get(id);
      if (call && result !== undefined) {
        call.resolve(result);
        this.calls.delete(id);
      }
    }
    if ([...this.expected].every((id) => this.registered.has(id) && !this.calls.has(id))) {
      this.expected.clear();
      this.results.clear();
      this.registered.clear();
      this.namesById.clear();
    }
  }
}
