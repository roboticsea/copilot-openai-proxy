import { z } from "zod";
import { OpenAIRequestError, type OpenAIMessage } from "./messages.js";
import { validateTools, type OpenAIFunctionTool } from "./tools.js";

const contentPart = z.record(z.string(), z.unknown()).and(z.object({ type: z.string() }));
const toolCall = z.object({ id: z.string().min(1), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }) });
const message = z.object({
  role: z.enum(["system", "developer", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(contentPart), z.null()]),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(toolCall).optional(),
}).passthrough();

const requestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(message).min(1),
  stream: z.boolean().default(true),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  parallel_tool_calls: z.unknown().optional(),
  response_format: z.unknown().optional(),
  stream_options: z.unknown().optional(),
}).passthrough();

export interface ChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  stream: boolean;
  tools: OpenAIFunctionTool[];
}

export function parseChatCompletionRequest(input: unknown): ChatCompletionRequest {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new OpenAIRequestError(`${String(issue?.path.join(".") || "request")}: ${issue?.message ?? "invalid request"}`);
  }
  if (parsed.data.model === "default") throw new OpenAIRequestError('model "default" is reserved');
  if (parsed.data.response_format !== undefined && parsed.data.response_format !== null) throw new OpenAIRequestError("response_format constraints are unsupported");
  const messages = parsed.data.messages as OpenAIMessage[];
  for (const current of messages) {
    if (Array.isArray(current.content)) {
      for (const part of current.content) if (part.type !== "text") throw new OpenAIRequestError(`unsupported content part type: ${part.type}`);
    }
  }
  return {
    model: parsed.data.model,
    messages,
    stream: parsed.data.stream,
    tools: validateTools(parsed.data.tools, parsed.data.tool_choice, parsed.data.parallel_tool_calls),
  };
}
