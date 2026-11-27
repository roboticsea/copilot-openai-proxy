import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotSession, Model } from "@microsoft/copilot-sdk";
import { loadConfig } from "../src/config.js";
import { CopilotAdapter, type CopilotClientLike } from "../src/copilot/copilot-adapter.js";
import { buildServer } from "../src/server.js";

const apiKey = "k".repeat(32);

function fakeClient(): CopilotClientLike {
  return {
    async start() {},
    async stop() { return []; },
    async listModels() { return [{ id: "gpt-test" } as Model]; },
    async createSession() { throw new Error("not used"); return undefined as unknown as CopilotSession; },
    async deleteSession() {},
  };
}

test("models endpoint filters IDs and enforces bearer", async () => {
  const config = loadConfig({ COPILOT_PROXY_API_KEY: apiKey, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
  const adapter = new CopilotAdapter(config, { tokenProvider: async () => ({ kind: "token", accessToken: "gho_test", expiresIn: 7200 }), clientFactory: fakeClient });
  await adapter.start();
  const { app, conversations } = buildServer(config, { adapter });
  try {
    assert.equal((await app.inject({ url: "/healthz" })).statusCode, 200);
    assert.equal((await app.inject({ url: "/v1/models" })).statusCode, 401);
    const response = await app.inject({ url: "/v1/models", headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { object: "list", data: [{ id: "gpt-test", object: "model", owned_by: "github-copilot" }] });
  } finally {
    await conversations.stop();
    await adapter.stop();
    await app.close();
  }
});
