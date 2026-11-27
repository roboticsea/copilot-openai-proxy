import assert from "node:assert/strict";
import test from "node:test";
import { externalToolDefinitions } from "../src/openai/tools.js";
import { UNSLOTH_TOOLS } from "./fixtures/unsloth-tools.js";

test("all Unsloth schemas are declaration-only and handlers perform no work", async () => {
  const calls: Array<{ name: string; arguments: unknown }> = [];
  const definitions = externalToolDefinitions(UNSLOTH_TOOLS, (name) => async (arguments_) => {
    calls.push({ name, arguments: arguments_ });
    return new Promise<never>(() => undefined);
  });
  assert.deepEqual(definitions.map((tool) => tool.name), ["python", "terminal", "edit_file", "view_image", "web_search"]);
  for (const [index, definition] of definitions.entries()) assert.equal(definition.parameters, UNSLOTH_TOOLS[index]!.function.parameters);
  const invocation = { sessionId: "s", toolCallId: "call_1", toolName: "terminal", arguments: { command: "pwd" } };
  const terminal = definitions.find((tool) => tool.name === "terminal")!;
  void terminal.handler?.({ command: "pwd" }, invocation);
  await Promise.resolve();
  assert.deepEqual(calls, [{ name: "terminal", arguments: { command: "pwd" } }]);
});
