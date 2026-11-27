import { defineTool, type Tool, type ToolInvocation } from "@microsoft/copilot-sdk";
import { OpenAIRequestError } from "./messages.js";

export interface OpenAIFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_SCHEMA_DEPTH = 48;
const MAX_SCHEMA_NODES = 10_000;

function assertJsonSchema(value: Record<string, unknown>, location: string): void {
  if (!Object.getPrototypeOf(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new OpenAIRequestError(`${location} must be a JSON object`);
  }
  let nodes = 0;
  const visit = (candidate: unknown, path: string, depth: number): void => {
    if (depth > MAX_SCHEMA_DEPTH) throw new OpenAIRequestError(`${path} exceeds maximum JSON Schema nesting depth`);
    nodes += 1;
    if (nodes > MAX_SCHEMA_NODES) throw new OpenAIRequestError(`${location} exceeds maximum JSON Schema complexity`);
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean" || (typeof candidate === "number" && Number.isFinite(candidate))) return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${path}[${index}]`, depth + 1));
      return;
    }
    if (typeof candidate !== "object" || Object.getPrototypeOf(candidate) !== Object.prototype) {
      throw new OpenAIRequestError(`${path} is not valid JSON Schema`);
    }
    for (const [key, child] of Object.entries(candidate)) visit(child, `${path}.${key}`, depth + 1);
  };
  visit(value, location, 0);
  if (value.type !== undefined && typeof value.type !== "string" && !Array.isArray(value.type)) throw new OpenAIRequestError(`${location}.type must be a string or array`);
}

export interface DeferredToolHandler {
  (arguments_: unknown, invocation: ToolInvocation): Promise<unknown>;
}

export function validateTools(input: unknown, toolChoice: unknown, parallel: unknown): OpenAIFunctionTool[] {
  if (parallel === false) throw new OpenAIRequestError("parallel_tool_calls: false is unsupported");
  if (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none") {
    if (toolChoice === "required") throw new OpenAIRequestError("tool_choice: required is unsupported");
    throw new OpenAIRequestError("named tool_choice values are unsupported");
  }
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new OpenAIRequestError("tools must be an array");
  if (input.length > 100) throw new OpenAIRequestError("tools catalog cannot exceed 100 entries");
  const names = new Set<string>();
  const tools = input.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || (candidate as { type?: unknown }).type !== "function") throw new OpenAIRequestError(`tools[${index}] must be a function tool`);
    const fn = (candidate as { function?: unknown }).function;
    if (!fn || typeof fn !== "object") throw new OpenAIRequestError(`tools[${index}].function is required`);
    const functionValue = fn as Record<string, unknown>;
    if (typeof functionValue.name !== "string" || functionValue.name.length === 0) throw new OpenAIRequestError(`tools[${index}].function.name must be nonempty`);
    if (!VALID_TOOL_NAME.test(functionValue.name)) throw new OpenAIRequestError(`tools[${index}].function.name must match /^[a-zA-Z0-9_-]{1,128}$/`);
    if (names.has(functionValue.name)) throw new OpenAIRequestError(`duplicate tool name: ${functionValue.name}`);
    names.add(functionValue.name);
    if (!functionValue.parameters || typeof functionValue.parameters !== "object" || Array.isArray(functionValue.parameters)) throw new OpenAIRequestError(`tools[${index}].function.parameters must be an object`);
    assertJsonSchema(functionValue.parameters as Record<string, unknown>, `tools[${index}].function.parameters`);
    if (functionValue.description !== undefined && typeof functionValue.description !== "string") throw new OpenAIRequestError(`tools[${index}].function.description must be a string`);
    return candidate as OpenAIFunctionTool;
  });
  return toolChoice === "none" ? [] : tools;
}

export function externalToolDefinitions(tools: readonly OpenAIFunctionTool[], handlerFor: (name: string) => DeferredToolHandler): Tool[] {
  return tools.map((tool) => defineTool(tool.function.name, {
    ...(tool.function.description !== undefined ? { description: tool.function.description } : {}),
    parameters: tool.function.parameters,
    defer: "never",
    skipPermission: true,
    handler: (arguments_, invocation) => handlerFor(tool.function.name)(arguments_, invocation),
  }));
}
