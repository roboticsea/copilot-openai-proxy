import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  COPILOT_PROXY_HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  COPILOT_PROXY_PORT: z.string().regex(/^\d+$/).default("11436").transform(Number),
  COPILOT_PROXY_API_KEY: z.string().min(32).optional(),
  COPILOT_PROXY_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  COPILOT_PROXY_GITHUB_TOKEN: z.string().optional(),
  COPILOT_PROXY_HOME: z.string().min(1).optional(),
  COPILOT_PROXY_VERBOSE: z.enum(["0", "1", "false", "true"]).default("false"),
});

export interface ProxyConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  apiKey?: string;
  githubClientId?: string;
  githubToken?: string;
  home: string;
  runtimeDirectory: string;
  configDirectory: string;
  verbose: boolean;
}

function defaultStateHome(env: NodeJS.ProcessEnv): string {
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "copilot-openai-proxy");
  }
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), ".local", "state"), "copilot-openai-proxy");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const name = issue?.path[0] ?? "COPILOT_PROXY_*";
    throw new Error(`invalid ${String(name)}: ${issue?.message ?? "invalid value"}`);
  }
  if (parsed.data.COPILOT_PROXY_PORT < 1 || parsed.data.COPILOT_PROXY_PORT > 65535) {
    throw new Error("invalid COPILOT_PROXY_PORT: must be between 1 and 65535");
  }
  const token = parsed.data.COPILOT_PROXY_GITHUB_TOKEN || undefined;
  if (token?.startsWith("ghp_")) {
    throw new Error("unsupported COPILOT_PROXY_GITHUB_TOKEN: ghp_ classic personal access tokens are rejected");
  }
  if (token && !/^(?:gho_|ghu_|github_pat_)/.test(token)) {
    throw new Error("unsupported COPILOT_PROXY_GITHUB_TOKEN: expected gho_, ghu_, or github_pat_");
  }
  const home = path.resolve(parsed.data.COPILOT_PROXY_HOME || defaultStateHome(env));
  return {
    host: parsed.data.COPILOT_PROXY_HOST,
    port: parsed.data.COPILOT_PROXY_PORT,
    ...(parsed.data.COPILOT_PROXY_API_KEY ? { apiKey: parsed.data.COPILOT_PROXY_API_KEY } : {}),
    ...(parsed.data.COPILOT_PROXY_GITHUB_CLIENT_ID ? { githubClientId: parsed.data.COPILOT_PROXY_GITHUB_CLIENT_ID } : {}),
    ...(token ? { githubToken: token } : {}),
    home,
    runtimeDirectory: path.join(home, "copilot"),
    configDirectory: path.join(home, "copilot-config"),
    verbose: parsed.data.COPILOT_PROXY_VERBOSE === "1" || parsed.data.COPILOT_PROXY_VERBOSE === "true",
  };
}

export function requireServeApiKey(config: ProxyConfig): string {
  if (!config.apiKey) throw new Error("COPILOT_PROXY_API_KEY is required for serve and must contain at least 32 characters");
  return config.apiKey;
}

export function bearerMatches(authorization: string | undefined, expected: string): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = authorization.slice("Bearer ".length);
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  const width = Math.max(a.length, b.length, 1);
  const normalizedA = Buffer.alloc(width);
  const normalizedB = Buffer.alloc(width);
  a.copy(normalizedA);
  b.copy(normalizedB);
  return a.length === b.length && timingSafeEqual(normalizedA, normalizedB);
}
