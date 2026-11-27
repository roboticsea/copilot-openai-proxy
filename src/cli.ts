import { loadConfig } from "./config.js";
import { deleteGitHubCredential, loadGitHubToken, startGitHubDeviceLogin, storedGitHubCredentialStatus } from "./auth/github-device-auth.js";

export type CliCommand = "serve" | "auth:login" | "auth:logout" | "auth:status";

export async function runAuthCommand(command: Exclude<CliCommand, "serve">): Promise<void> {
  const config = loadConfig();
  if (command === "auth:login") {
    if (!config.githubClientId) throw new Error("COPILOT_PROXY_GITHUB_CLIENT_ID is required for auth:login");
    await startGitHubDeviceLogin(config.githubClientId);
    process.stdout.write("Authenticated with GitHub.\n");
    return;
  }
  if (command === "auth:logout") {
    await deleteGitHubCredential();
    process.stdout.write("Logged out.\n");
    return;
  }
  if (config.githubToken) {
    const token = await loadGitHubToken();
    process.stdout.write(token.kind === "token" ? "authenticated=true\nexpiry=environment\n" : "authenticated=false\nexpiry=null\n");
    return;
  }
  const status = await storedGitHubCredentialStatus();
  process.stdout.write(`authenticated=${status.authenticated}\nexpiry=${status.expiresAt ?? "null"}\n`);
}
