import assert from "node:assert/strict";
import test from "node:test";
import { parseChatCompletionRequest } from "../src/openai/request.js";

const base = { model: "gpt-test", messages: [{ role: "user", content: "hello" }] };

test("sampling-only fields are accepted and ignored", () => {
  const request = parseChatCompletionRequest({ ...base, temperature: 0.2, top_p: 0.7, max_tokens: 20, stream_options: { include_usage: true } });
  assert.equal(request.model, "gpt-test");
  assert.equal(request.stream, true);
});

test("unsupported response formats and reserved model fail", () => {
  assert.throws(() => parseChatCompletionRequest({ ...base, response_format: { type: "json_object" } }), /response_format/);
  assert.throws(() => parseChatCompletionRequest({ ...base, model: "default" }), /reserved/);
});

test("image and audio parts fail explicitly", () => {
  assert.throws(() => parseChatCompletionRequest({ ...base, messages: [{ role: "user", content: [{ type: "image_url" }] }] }), /image_url/);
  assert.throws(() => parseChatCompletionRequest({ ...base, messages: [{ role: "user", content: [{ type: "input_audio" }] }] }), /input_audio/);
});
