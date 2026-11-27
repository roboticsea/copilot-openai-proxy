import assert from "node:assert/strict";
import test from "node:test";
import { DeferredToolCalls } from "../src/copilot/deferred-tool-calls.js";

const invocation = (id: string, name: string) => ({ toolCallId: id, toolName: name, arguments: {} });

test("deferred tool stores an early result and releases when handler arrives", async () => {
  const deferred = new DeferredToolCalls();
  deferred.beginRound(["call_terminal_1"]);
  deferred.resolveFromOpenAI([{ role: "tool", content: "/tmp/work", tool_call_id: "call_terminal_1" }]);
  assert.equal(await deferred.defer(invocation("call_terminal_1", "terminal")), "/tmp/work");
});

test("parallel calls resolve only after every result", async () => {
  const deferred = new DeferredToolCalls();
  const one = deferred.defer(invocation("call_1", "python"));
  const two = deferred.defer(invocation("call_2", "terminal"));
  deferred.beginRound(["call_1", "call_2"]);
  let settled = false;
  void Promise.all([one, two]).then(() => { settled = true; });
  deferred.resolveFromOpenAI([{ role: "tool", content: "one", tool_call_id: "call_1" }]);
  await Promise.resolve();
  assert.equal(settled, false);
  deferred.resolveFromOpenAI([{ role: "tool", content: "two", tool_call_id: "call_2" }]);
  assert.deepEqual(await Promise.all([one, two]), ["one", "two"]);
});

test("orphan tool result is rejected", () => {
  const deferred = new DeferredToolCalls();
  deferred.beginRound(["call_expected"]);
  assert.throws(() => deferred.resolveFromOpenAI([{ role: "tool", content: "no", tool_call_id: "orphan" }]), /orphan/);
});
