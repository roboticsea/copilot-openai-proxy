import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bearerMatches, loadConfig } from "../src/config.js";
import { CopilotAdapter } from "../src/copilot/copilot-adapter.js";

test("configuration rejects LAN binding, weak keys, and ghp tokens", () => {
  assert.throws(() => loadConfig({ COPILOT_PROXY_HOST: "0.0.0.0" }), /invalid COPILOT_PROXY_HOST/);
  assert.throws(() => loadConfig({ COPILOT_PROXY_API_KEY: "short" }), /COPILOT_PROXY_API_KEY/);
  assert.throws(() => loadConfig({ COPILOT_PROXY_GITHUB_TOKEN: "ghp_secret" }), /ghp_.*rejected/);
});

test("configuration defaults to loopback and supports accepted token prefixes", () => {
  for (const prefix of ["gho_", "ghu_", "github_pat_"]) {
    const config = loadConfig({ COPILOT_PROXY_GITHUB_TOKEN: `${prefix}value` });
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 11436);
    assert.equal(config.verbose, false);
    assert.match(config.runtimeDirectory, /copilot-openai-proxy\/copilot$/);
  }
});

test("bearer comparison is exact", () => {
  const key = "x".repeat(32);
  assert.equal(bearerMatches(`Bearer ${key}`, key), true);
  assert.equal(bearerMatches("Bearer wrong", key), false);
  assert.equal(bearerMatches(undefined, key), false);
});

test("verbose diagnostics are opt-in", () => {
  assert.equal(loadConfig({ COPILOT_PROXY_VERBOSE: "1" }).verbose, true);
  assert.equal(loadConfig({ COPILOT_PROXY_VERBOSE: "false" }).verbose, false);
});

test("adapter start enforces 0o700 permissions on proxy home directories", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "copilot-proxy-perm-"));
  const home = path.join(tempRoot, "state-home");
  try {
    const config = loadConfig({ COPILOT_PROXY_HOME: home, COPILOT_PROXY_GITHUB_TOKEN: "gho_test" });
    const adapter = new CopilotAdapter(config, {
      tokenProvider: async () => ({ kind: "token", accessToken: "gho_test", expiresIn: 7200 }),
      clientFactory: () => ({
        async start() {},
        async stop() { return []; },
        async listModels() { return []; },
        async createSession() { throw new Error("unused"); },
        async deleteSession() {},
      }),
    });
    await adapter.start();
    for (const dir of [config.home, config.runtimeDirectory, config.configDirectory]) {
      const mode = (await stat(dir)).mode & 0o777;
      assert.equal(mode, 0o700, `expected 0700 on ${dir}, got ${mode.toString(8)}`);
    }
    await adapter.stop();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
