import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotSession, CreateSessionOptions, Model, SessionEvent } from "@microsoft/copilot-sdk";
import { loadConfig } from "../src/config.js";
import { CopilotAdapter, type CopilotClientLike } from "../src/copilot/copilot-adapter.js";
import { ConversationBridge } from "../src/copilot/conversation.js";
import { buildServer } from "../src/server.js";

const key = "r".repeat(32);

class FakeSession {
  private handlers = new Set<(event: SessionEvent) => void>();
  aborted = false;
  disconnected = false;
  sends = 0;
  constructor(private readonly options: CreateSessionOptions, private readonly textOnly = false) {}
  on(handler: (event: SessionEvent) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  async send(): Promise<string> {
    this.sends += 1;
    if (!this.textOnly && this.sends === 1) {
      const terminal = this.options.tools?.definitions?.find((tool) => tool.name === "terminal");
      const pending = terminal?.handler?.({ command: "pwd" }, { sessionId: "s", toolCallId: "call_terminal_1", toolName: "terminal", arguments: { command: "pwd" } });
      this.emit({ type: "assistant.tool_call_delta", data: { toolCallId: "call_terminal_1", toolName: "terminal", inputDelta: '{"command":' } });
      this.emit({ type: "assistant.tool_call_delta", data: { toolCallId: "call_terminal_1", inputDelta: '"pwd"}' } });
      this.emit({ type: "assistant.turn_end", data: {} });
      void Promise.resolve(pending).then(() => {
        this.emit({ type: "assistant.turn_end", data: {} });
      }).catch(() => undefined);
    } else {
      this.emit({ type: "assistant.message_delta", data: { messageId: `message_${this.sends}`, deltaContent: "/tmp/work" } });
      this.emit({ type: "assistant.turn_end", data: {} });
    }
    return "message";
  }
  async abort(): Promise<void> { this.aborted = true; }
  async disconnect(): Promise<void> { this.disconnected = true; }
  private emit(raw: Record<string, unknown>): void {
    for (const handler of this.handlers) handler(raw as SessionEvent);
  }
}

function fixture(): { adapter: CopilotAdapter; session: () => FakeSession; created: () => number } {
  let session: FakeSession | undefined;
  let created = 0;
  const client: CopilotClientLike = {
    async start() {},
    async stop() { return []; },
    async listModels() { return [] as Model[]; },
    async createSession(options) {
      created += 1;
      session = new FakeSession(options);
      return session as unknown as CopilotSession;
    },
    async deleteSession() {},
  };
  const config = loadConfig({ COPILOT_PROXY_API_KEY: key, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
  const adapter = new CopilotAdapter(config, { tokenProvider: async () => ({ kind: "token", accessToken: "gho_test", expiresIn: 7200 }), clientFactory: () => client });
  return { adapter, session: () => session!, created: () => created };
}
test("tool call resumes same session once and rejects orphan ID", async () => {
  const { adapter, session, created } = fixture();
  const config = loadConfig({ COPILOT_PROXY_API_KEY: key, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
  await adapter.start();
  const { app, conversations } = buildServer(config, { adapter });
  const tool = { type: "function", function: { name: "terminal", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  const headers = { authorization: `Bearer ${key}` };
  try {
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [{ role: "user", content: "pwd" }], tools: [tool] } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.body.match(/data: \[DONE\]/g)?.length, 1);
    assert.match(first.body, /call_terminal_1/);
    const second = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_old", type: "function", function: { name: "web_search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_old", content: "older result" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_terminal_1_1_0", type: "function", function: { name: "terminal", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call_terminal_1_1_0", content: "/tmp/work" },
    ] } });
    assert.equal(second.statusCode, 200);
    assert.match(second.body, /\\u002ftmp\\u002fwork|\/tmp\/work/);
    assert.equal(session().sends, 2);
    const replayed = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "rag_auto_d32f0502231e", type: "function", function: { name: "search_knowledge_base", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "rag_auto_d32f0502231e", content: "RAG result" },
      { role: "user", content: "answer from these sources" },
    ] } });
    assert.equal(replayed.statusCode, 200);
    assert.equal(created(), 2);
  } finally {
    await conversations.stop();
    await adapter.stop();
    await app.close();
  }
});

test("unrelated tool_call_id cannot hijack another pending session and RAG autoinject starts fresh", async () => {
  let created = 0;
  const sessions: FakeSession[] = [];
  const client: CopilotClientLike = {
    async start() {},
    async stop() { return []; },
    async listModels() { return [] as Model[]; },
    async createSession(options) {
      created += 1;
      const s = new FakeSession(options, created > 1);
      sessions.push(s);
      return s as unknown as CopilotSession;
    },
    async deleteSession() {},
  };
  const config = loadConfig({ COPILOT_PROXY_API_KEY: key, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
  const adapter = new CopilotAdapter(config, { tokenProvider: async () => ({ kind: "token", accessToken: "gho_test", expiresIn: 7200 }), clientFactory: () => client });
  await adapter.start();
  const { app, conversations } = buildServer(config, { adapter });
  const tool = { type: "function", function: { name: "terminal", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  const headers = { authorization: `Bearer ${key}` };
  try {
    // Start session 1, leaving call_terminal_1 pending
    const first = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [{ role: "user", content: "pwd" }], tools: [tool] } });
    assert.equal(first.statusCode, 200);
    assert.equal(created, 1);

    // Attempt to send unrelated single tool call while session 1 is pending -> must 400, NOT hijack session 1
    const hijackAttempt = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_other_99", type: "function", function: { name: "terminal", arguments: '{"command":"id"}' } }] },
      { role: "tool", tool_call_id: "call_other_99", content: "uid=0" },
    ] } });
    assert.equal(hijackAttempt.statusCode, 400);
    assert.equal(sessions[0]!.sends, 1);

    // Attempt suffix match with wrong tool name -> must 400
    const wrongToolName = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_terminal_1_1_0", type: "function", function: { name: "python", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_terminal_1_1_0", content: "spoof" },
    ] } });
    assert.equal(wrongToolName.statusCode, 400);
    assert.equal(sessions[0]!.sends, 1);

    // Trailing RAG autoinject exchange while session 1 is pending -> must start a fresh session, NOT hijack session 1
    const ragTurn = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "user", content: "summarize attached doc" },
      { role: "assistant", content: "", tool_calls: [{ id: "rag_auto_d32f0502231e", type: "function", function: { name: "search_knowledge_base", arguments: '{"query":"doc"}' } }] },
      { role: "tool", name: "search_knowledge_base", tool_call_id: "rag_auto_d32f0502231e", content: "Doc body" },
    ] } });
    assert.equal(ragTurn.statusCode, 200);
    assert.equal(created, 2);
    assert.equal(sessions[0]!.sends, 1);

    // Session 1 remains intact and can still complete with valid renamed ID
    const validResume = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call_terminal_1_2_0", type: "function", function: { name: "terminal", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call_terminal_1_2_0", content: "/tmp/work" },
    ] } });
    assert.equal(validResume.statusCode, 200);
    assert.equal(sessions[0]!.sends, 2);

    // Follow-up user turn after completed tool calls starts a fresh session instead of failing correlation
    const followUp = await app.inject({ method: "POST", url: "/v1/chat/completions", headers, payload: { model: "gpt-test", messages: [
      { role: "user", content: "pwd" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_terminal_1", type: "function", function: { name: "terminal", arguments: '{"command":"pwd"}' } }] },
      { role: "tool", tool_call_id: "call_terminal_1", content: "/tmp/work" },
      { role: "assistant", content: "/tmp/work" },
      { role: "user", content: "now explain it" },
    ] } });
    assert.equal(followUp.statusCode, 200);
    assert.equal(created, 3);
  } finally {
    await conversations.stop();
    await adapter.stop();
    await app.close();
  }
});

test("conversation capacity cap returns 429 and x-request-id rejects control characters", async () => {
  const { adapter } = fixture();
  const config = loadConfig({ COPILOT_PROXY_API_KEY: key, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
  await adapter.start();
  const conversations = new ConversationBridge(adapter, 15 * 60 * 1000, undefined, 1);
  const { app } = buildServer(config, { adapter, conversations });
  const seenIds: string[] = [];
  app.addHook("onRequest", async (req) => { seenIds.push(req.id); });
  const tool = { type: "function", function: { name: "terminal", parameters: { type: "object", properties: { command: { type: "string" } } } } };
  try {
    const ok = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}`, "x-request-id": "bad\x1b[31m_id" },
      payload: { model: "gpt-test", messages: [{ role: "user", content: "pwd" }], tools: [tool] },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(seenIds.length, 1);
    assert.notEqual(seenIds[0], "bad\x1b[31m_id");
    assert.match(seenIds[0]!, /^[0-9a-f-]{36}$/);

    const capped = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Bearer ${key}`, "x-request-id": "valid-req-123" },
      payload: { model: "gpt-test", messages: [{ role: "user", content: "pwd" }], tools: [tool] },
    });
    assert.equal(capped.statusCode, 429);
    assert.equal(seenIds[1], "valid-req-123");
    assert.equal(capped.json().error.type, "rate_limit_error");
  } finally {
    await conversations.stop();
    await adapter.stop();
    await app.close();
  }
});
