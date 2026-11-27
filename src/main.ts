import { runAuthCommand, type CliCommand } from "./cli.js";
import { loadConfig, requireServeApiKey } from "./config.js";
import { buildServer } from "./server.js";

const command = (process.argv[2] ?? "serve") as CliCommand;

async function main(): Promise<void> {
  if (!process.argv[2]) throw new Error("usage: node dist/main.js <serve|auth:login|auth:logout|auth:status>");
  if (command === "auth:login" || command === "auth:logout" || command === "auth:status") {
    await runAuthCommand(command);
    return;
  }
  if (command !== "serve") throw new Error(`unknown command: ${command}`);
  const config = loadConfig();
  requireServeApiKey(config);
  const { app, adapter, conversations } = buildServer(config);
  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`Received ${signal}; draining proxy.\n`);
    await app.close().catch(() => undefined);
    await conversations.stop();
    await adapter.stop();
  };
  process.once("SIGINT", () => void stop("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => void stop("SIGTERM").then(() => process.exit(0)));
  await adapter.start();
  await app.listen({ host: config.host, port: config.port });
  process.stderr.write(`copilot-openai-proxy listening on http://${config.host}:${config.port}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
