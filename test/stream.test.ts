import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@microsoft/copilot-sdk";
import { OpenAIEventTranslator } from "../src/openai/stream.js";

function event(value: Record<string, unknown>): SessionEvent {
  return value as SessionEvent;
}

test("message deltas stream as exact content chunks plus one finish and DONE", async () => {
  const translator = new OpenAIEventTranslator({ model: "gpt-test", streaming: true });
  const frames = translator.frames();
  const chunksPromise = (async () => { const output: string[] = []; for await (const chunk of frames) output.push(chunk); return output; })();
  translator.publish(event({ type: "assistant.message_delta", agentId: undefined, data: { deltaContent: "Hello" } }));
  translator.publish(event({ type: "assistant.message_delta", agentId: undefined, data: { deltaContent: " world" } }));
  translator.publish(event({ type: "assistant.turn_end", agentId: undefined, data: {} }));
  const chunks = (await chunksPromise).flatMap((frame) => frame.trim().split("\n\n")).filter(Boolean);
  const payloads = chunks.filter((chunk) => chunk !== "data: [DONE]").map((chunk) => JSON.parse(chunk.slice(6)));
  assert.deepEqual(payloads.map((payload) => payload.choices[0].delta.content).filter(Boolean), ["Hello", " world"]);
  assert.equal(payloads.at(-1).choices[0].finish_reason, "stop");
  assert.equal(chunks.filter((chunk) => chunk === "data: [DONE]").length, 1);
});

test("tool argument fragments preserve IDs, indices, and bytes", async () => {
  let marked: readonly string[] = [];
  const translator = new OpenAIEventTranslator({ model: "gpt-test", streaming: false, onToolTurn: (ids) => { marked = ids; } });
  translator.publish(event({ type: "assistant.tool_call_delta", data: { toolCallId: "call_terminal_1", toolName: "terminal", inputDelta: '{"command":' } }));
  translator.publish(event({ type: "assistant.tool_call_delta", data: { toolCallId: "call_terminal_1", inputDelta: '"pwd"}' } }));
  translator.publish(event({ type: "assistant.turn_end", data: {} }));
  const response = await translator.jsonResponse();
  const message = (response.choices as Array<{ message: { tool_calls: Array<{ function: { arguments: string }; id: string }> } }>)[0]!.message;
  assert.equal(message.tool_calls[0]!.id, "call_terminal_1");
  assert.equal(message.tool_calls[0]!.function.arguments, '{"command":"pwd"}');
  assert.deepEqual(marked, ["call_terminal_1"]);
});


test("complete assistant.message supplies fallback when provider emits no deltas", async () => {
  const translator = new OpenAIEventTranslator({ model: "mai-code-2", streaming: false });
  translator.publish(event({
    type: "assistant.message",
    data: { messageId: "message_1", content: "PONG", reasoningText: "brief reasoning" },
  }));
  translator.publish(event({ type: "assistant.turn_end", data: {} }));
  const response = await translator.jsonResponse();
  const choice = (response.choices as Array<{ message: { content: string; reasoning_content: string }; finish_reason: string }>)[0]!;
  assert.equal(choice.message.content, "PONG");
  assert.equal(choice.message.reasoning_content, "brief reasoning");
  assert.equal(choice.finish_reason, "stop");
});

test("complete assistant.message fallback preserves and immediately completes tool requests", async () => {
  const marked: string[][] = [];
  const translator = new OpenAIEventTranslator({ model: "mai-code-2", streaming: true, onToolTurn: (ids) => marked.push([...ids]) });
  const framesPromise = (async () => { const frames: string[] = []; for await (const frame of translator.frames()) frames.push(frame); return frames; })();
  translator.publish(event({
    type: "assistant.message",
    data: {
      messageId: "message_2",
      content: "",
      toolRequests: [{ toolCallId: "call_terminal_1", name: "terminal", arguments: { command: "pwd" } }],
    },
  }));
  const frames = await framesPromise;
  assert.equal(frames.at(-1), "data: [DONE]\n\n");
  assert.deepEqual(marked, [["call_terminal_1"]]);
  const toolChunk = frames.map((frame) => frame.startsWith("data: {") ? JSON.parse(frame.slice(6)) : undefined).find((payload) => payload?.choices[0]?.delta?.tool_calls);
  assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.arguments, '{"command":"pwd"}');
});