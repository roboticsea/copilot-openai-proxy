import { setTimeout as delay } from "node:timers/promises";
import { AsyncEntry } from "@napi-rs/keyring";
import type { GitHubTokenProviderResult } from "@microsoft/copilot-sdk";
import { z } from "zod";
import { loadConfig } from "../config.js";

const SERVICE = "copilot-openai-proxy";
const ACCOUNT = "github-oauth";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const FIVE_MINUTES_SECONDS = 5 * 60;

const credentialSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_at: z.number().int().nonnegative(),
  refresh_expires_at: z.number().int().nonnegative().optional(),
  scope: z.string(),
});

export type StoredGitHubCredential = z.infer<typeof credentialSchema>;
export type GitHubTokenResult = GitHubTokenProviderResult;

export interface LoginIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const defaultIo: LoginIo = {
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  sleep: async (milliseconds, signal) => {
    await delay(milliseconds, signal ? { signal } : undefined);
  },
};

function entry(): AsyncEntry {
  return new AsyncEntry(SERVICE, ACCOUNT);
}

function safeError(context: string, cause: unknown): Error {
  const error = cause instanceof Error ? cause : new Error("unknown error");
  return new Error(`${context}. Ensure the operating-system credential store is unlocked and available, or use COPILOT_PROXY_GITHUB_TOKEN.`, { cause: error });
}

async function postJson<T>(url: string, body: Record<string, string>, io: LoginIo): Promise<T> {
  const response = await (io.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    ...(io.signal ? { signal: io.signal } : {}),
  });
  if (!response.ok) throw new Error(`GitHub OAuth request failed with HTTP ${response.status}`);
  return await response.json() as T;
}

async function readStoredCredential(signal?: AbortSignal): Promise<StoredGitHubCredential | null> {
  let raw: string | null;
  try {
    raw = await entry().getPassword(signal);
  } catch (cause) {
    throw safeError("Unable to read the GitHub credential store", cause);
  }
  if (raw === null) return null;
  try {
    return credentialSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error("Stored GitHub credential is invalid. Run npm run auth:logout and npm run auth:login again.");
  }
}

async function storeCredential(credential: StoredGitHubCredential): Promise<void> {
  try {
    await entry().setPassword(JSON.stringify(credential));
  } catch (cause) {
    throw safeError("Unable to save the GitHub credential in the operating-system credential store", cause);
  }
}

export async function startGitHubDeviceLogin(clientId: string, io: LoginIo = defaultIo): Promise<StoredGitHubCredential> {
  if (!clientId.trim()) throw new Error("COPILOT_PROXY_GITHUB_CLIENT_ID is required for auth:login");
  const initial = await postJson<Record<string, unknown>>(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: "read:user offline_access",
  }, io);
  const deviceCode = z.string().min(1).parse(initial.device_code);
  const verificationUri = z.string().url().parse(initial.verification_uri);
  const userCode = z.string().min(1).parse(initial.user_code);
  const expiresIn = z.number().int().positive().parse(initial.expires_in);
  let interval = z.number().int().positive().parse(initial.interval);
  const deadline = Date.now() + expiresIn * 1000;
  io.stdout(`Open ${verificationUri} and enter code: ${userCode}`);

  while (Date.now() < deadline) {
    await (io.sleep ?? defaultIo.sleep!)(Math.min(interval, Math.max(1, Math.ceil((deadline - Date.now()) / 1000))) * 1000, io.signal);
    io.signal?.throwIfAborted();
    const result = await postJson<Record<string, unknown>>(ACCESS_TOKEN_URL, {
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }, io);
    const error = typeof result.error === "string" ? result.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "expired_token") throw new Error("GitHub device login expired before authorization completed");
    if (error === "access_denied") throw new Error("GitHub device login was denied");
    if (error) throw new Error(`GitHub device login failed (${error})`);

    const now = Math.floor(Date.now() / 1000);
    const credential: StoredGitHubCredential = {
      access_token: z.string().min(1).parse(result.access_token),
      expires_at: now + (typeof result.expires_in === "number" ? result.expires_in : 8 * 60 * 60),
      scope: typeof result.scope === "string" ? result.scope : "read:user offline_access",
      ...(typeof result.refresh_token === "string" ? { refresh_token: result.refresh_token } : {}),
      ...(typeof result.refresh_token_expires_in === "number" ? { refresh_expires_at: now + result.refresh_token_expires_in } : {}),
    };
    await storeCredential(credential);
    return credential;
  }
  throw new Error("GitHub device login expired before authorization completed");
}

export async function refreshGitHubCredential(clientId: string, credential: StoredGitHubCredential): Promise<StoredGitHubCredential> {
  if (!credential.refresh_token) throw new Error("GitHub credential expired and no refresh token is available; run npm run auth:login");
  const now = Math.floor(Date.now() / 1000);
  if (credential.refresh_expires_at !== undefined && credential.refresh_expires_at <= now) {
    throw new Error("GitHub refresh credential expired; run npm run auth:login");
  }
  const result = await postJson<Record<string, unknown>>(ACCESS_TOKEN_URL, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: credential.refresh_token,
  }, defaultIo);
  if (typeof result.error === "string") throw new Error("GitHub credential refresh failed; run npm run auth:login");
  const refreshed: StoredGitHubCredential = {
    access_token: z.string().min(1).parse(result.access_token),
    expires_at: now + (typeof result.expires_in === "number" ? result.expires_in : 8 * 60 * 60),
    scope: typeof result.scope === "string" ? result.scope : credential.scope,
    ...(typeof result.refresh_token === "string" ? { refresh_token: result.refresh_token } : { refresh_token: credential.refresh_token }),
    ...(typeof result.refresh_token_expires_in === "number"
      ? { refresh_expires_at: now + result.refresh_token_expires_in }
      : credential.refresh_expires_at !== undefined ? { refresh_expires_at: credential.refresh_expires_at } : {}),
  };
  await storeCredential(refreshed);
  return refreshed;
}

export async function loadGitHubToken(signal?: AbortSignal): Promise<GitHubTokenResult> {
  const config = loadConfig();
  if (config.githubToken) return { kind: "token", accessToken: config.githubToken, expiresIn: 8 * 60 * 60 };
  let credential = await readStoredCredential(signal);
  if (!credential) return { kind: "cancelled" };
  const now = Math.floor(Date.now() / 1000);
  if (credential.expires_at - now <= FIVE_MINUTES_SECONDS) {
    if (!config.githubClientId) throw new Error("COPILOT_PROXY_GITHUB_CLIENT_ID is required to refresh the stored GitHub credential");
    credential = await refreshGitHubCredential(config.githubClientId, credential);
  }
  return { kind: "token", accessToken: credential.access_token, expiresIn: Math.max(0, credential.expires_at - Math.floor(Date.now() / 1000)) };
}

export async function deleteGitHubCredential(): Promise<void> {
  try {
    await entry().deleteCredential();
  } catch (cause) {
    throw safeError("Unable to remove the GitHub credential from the operating-system credential store", cause);
  }
}

export async function storedGitHubCredentialStatus(): Promise<{ authenticated: boolean; expiresAt: string | null }> {
  const credential = await readStoredCredential();
  if (!credential) return { authenticated: false, expiresAt: null };
  return { authenticated: true, expiresAt: new Date(credential.expires_at * 1000).toISOString() };
}
