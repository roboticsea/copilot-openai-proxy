import { chmod, mkdir } from "node:fs/promises";
import { CopilotClient, RuntimeConnection, type CopilotSession, type CreateSessionOptions, type Model } from "@microsoft/copilot-sdk";
import type { ProxyConfig } from "../config.js";
import { loadGitHubToken } from "../auth/github-device-auth.js";
export class ProxyAuthError extends Error {
  readonly statusCode = 401;
  constructor(message = "GitHub Copilot authentication is required") {
    super(message);
    this.name = "ProxyAuthError";
  }
}
export interface CopilotClientLike {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  listModels(): Promise<Model[]>;
  createSession(config: CreateSessionOptions): Promise<CopilotSession>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface CopilotAdapterDependencies {
  tokenProvider?: typeof loadGitHubToken;
  clientFactory?: (token: string) => CopilotClientLike;
}

export class CopilotAdapter {
  private client: CopilotClientLike | undefined;

  constructor(private readonly config: ProxyConfig, private readonly dependencies: CopilotAdapterDependencies = {}) {}

  async start(): Promise<void> {
    for (const dir of [this.config.home, this.config.runtimeDirectory, this.config.configDirectory]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => undefined);
    }
    const provider = this.dependencies.tokenProvider ?? loadGitHubToken;
    const token = await provider();
    if (token.kind === "cancelled") throw new ProxyAuthError("not_authenticated: run npm run auth:login or set COPILOT_PROXY_GITHUB_TOKEN");
    this.client = this.createClient(token.accessToken);
    await this.client.start();
  }

  async listModels(): Promise<Model[]> {
    const client = this.requireClient();
    try {
      return await client.listModels();
    } catch (firstError) {
      if (!isAuthenticationError(firstError)) throw firstError;
      const provider = this.dependencies.tokenProvider ?? loadGitHubToken;
      const refreshed = await provider();
      if (refreshed.kind === "cancelled") throw new ProxyAuthError();
      await client.stop();
      this.client = this.createClient(refreshed.accessToken);
      await this.client.start();
      try {
        return await this.client.listModels();
      } catch {
        throw isAuthenticationError(firstError) ? new ProxyAuthError() : firstError;
      }
    }
  }

  async createSession(config: Omit<CreateSessionOptions, "github" | "configDirectory" | "permissions">): Promise<CopilotSession> {
    return this.requireClient().createSession({
      ...config,
      configDirectory: this.config.configDirectory,
      github: {
        tokenProvider: async () => (this.dependencies.tokenProvider ?? loadGitHubToken)(),
      },
      permissions: { onRequest: () => ({ kind: "reject", feedback: "All non-bridge permissions are denied" }) },
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.requireClient().deleteSession(sessionId);
  }

  async stop(): Promise<Error[]> {
    if (!this.client) return [];
    return this.client.stop();
  }
  private createClient(token: string): CopilotClientLike {
    if (this.dependencies.clientFactory) return this.dependencies.clientFactory(token);
    return new CopilotClient({
      mode: "empty",
      runtime: RuntimeConnection.forDefault({ baseDirectory: this.config.runtimeDirectory }),
      github: { token, useLoggedInUser: false },
    });
  }

  private requireClient(): CopilotClientLike {
    if (!this.client) throw new Error("Copilot client has not been started");
    return this.client;
  }
}

function isAuthenticationError(error: unknown): boolean {
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return text.includes("auth") || text.includes("unauthor") || text.includes("forbidden") || text.includes("token");
}
