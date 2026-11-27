import type { OpenAIFunctionTool } from "../../src/openai/tools.js";

export const UNSLOTH_TOOLS: OpenAIFunctionTool[] = [
  { type: "function", function: { name: "python", parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } } },
  { type: "function", function: { name: "terminal", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "edit_file", parameters: { type: "object", properties: { path: { type: "string" }, edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } }, required: ["old_string", "new_string"] } } }, required: ["path", "edits"] } } },
  { type: "function", function: { name: "view_image", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "web_search", parameters: { type: "object", properties: { query: { type: "string" }, url: { type: "string" } }, required: [] } } },
];
