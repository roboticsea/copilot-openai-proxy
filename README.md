# Copilot OpenAI proxy

***This is offered as-is and I do not plan to extend this project further.  Hopefully the Unsloth Desktop team will add Github Copilot as an officially supported provider.  In the meantime, you can use this proxy as a bridge between Unsloth Desktop and Github Copilot.  I have personally tested this for model selection, chat, and tool calling/use (was fun getting it to work with how Unsloth handles tool calls).  This codebase has also been reviewed/mitigated of security vulnerabilities (not saying there aren't any at all, obviously, but it's pretty solid).  Use at your own risk.  It works on MacOS.  I haven't tested Ubuntu yet, but it probably works.  `-robotsea`***

A loopback-only OpenAI Chat Completions proxy backed by GitHub Copilot. It exposes model declarations and forwards Unsloth function-tool calls without executing them. Tool execution remains in Unsloth's existing sandbox.

## Requirements

- Node.js 22.12+
- macOS x64/ARM64 or Ubuntu x64/ARM64
- A GitHub OAuth App with **Device Flow** enabled, or a supported `gho_`, `ghu_`, or `github_pat_` token

Classic `ghp_` personal access tokens are rejected. Tokens are never written to plaintext files or logged.

## Setup

```sh
npm install
export COPILOT_PROXY_GITHUB_CLIENT_ID='your-oauth-app-client-id'
npm run auth:login
export COPILOT_PROXY_API_KEY="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
npm start
```

`auth:login` uses the OAuth App device flow with `read:user offline_access`. Visit the displayed verification URL and enter the displayed code; the command does not open a browser. Credentials are stored in macOS Keychain or Ubuntu Secret Service/kernel-keyring through `@napi-rs/keyring`.

For a locked/headless environment, use an environment-only override instead:

```sh
export COPILOT_PROXY_GITHUB_TOKEN='gho_...'
```

Check status with `npm run auth:status`; remove stored credentials with `npm run auth:logout`.

## Verbose diagnostics

Set `COPILOT_PROXY_VERBOSE=1` before `npm start` to write newline-delimited diagnostic JSON to stderr. This is useful while troubleshooting HTTP traffic, Copilot event timing, and tool-result correlation:

```sh
COPILOT_PROXY_VERBOSE=1 npm start
```

Logs contain request IDs, methods, paths, status codes, elapsed time, Copilot event types, tool names/IDs, and byte counts. They deliberately exclude authorization headers, tokens, message text, reasoning text, system prompts, tool arguments, tool results, credential-store payloads, and stack traces. Do not enable verbose mode in shared logs unless tool names and IDs are acceptable metadata.

## Unsloth configuration

Start Unsloth separately and use these values:

- provider: `Custom`
- API type: `OpenAI Chat Completions`
- base URL: `http://127.0.0.1:11436/v1`
- API key: the same `COPILOT_PROXY_API_KEY`
- model IDs: loaded from `GET /v1/models`

The service listens only on `127.0.0.1` or `::1`. `GET /healthz` is unauthenticated. `/v1/models` and `/v1/chat/completions` require the bearer API key.

## Tools

This default is deliberate: tool-capable conversations can inspect or modify files and perform network searches inside Unsloth's sandbox. The proxy only emits OpenAI `tool_calls`; it waits for Unsloth to execute them and return `role: "tool"` results. Unsloth's existing sandbox, permission, workdir, and approval behavior remains authoritative.

## Adding more external tools

The proxy already accepts any OpenAI `type: "function"` declaration supplied in `POST /v1/chat/completions`; it is not hard-coded to the five base Unsloth tools. A caller can add a new tool by including a unique name, description, and JSON Schema in `tools`. The proxy maps that schema unchanged to a Copilot external declaration, emits the call, then correlates the matching `tool_call_id` result without executing anything.

For an OpenAI client, adding a declaration is sufficient at the proxy boundary. For Unsloth Studio, the tool must also be implemented by Unsloth's tool loop/catalog and exposed to the composer. Add execution, permissions, UI cards, result shaping, and tests in Unsloth—not in this proxy. Do not add shell, filesystem, Python, editor, or network execution branches to the proxy.

Limits and wire contracts:

- At most 100 function tools per request.
- Names must be unique and nonempty; only `type: "function"` is accepted.
- `tool_choice: "auto"` is supported; `"none"` removes every declaration. `"required"`, named selection, and `parallel_tool_calls: false` are rejected rather than weakened.
- Parameters are forwarded as JSON Schema. Invalid schemas return `400 invalid_request_error`.
- A tool call returns the unchanged call ID and fragmented JSON arguments. Its result must arrive in a later request with the same `tool_call_id`.
- Parallel calls remain pending until every call ID from that assistant turn has a matching result.
- Built-in Copilot tools and MCP remain excluded; external-tool schemas do not change that policy.

## State and security

Runtime state stays beneath `COPILOT_PROXY_HOME` (or the platform state directory) in `copilot/` and `copilot-config/`. Built-in Copilot agent tools and MCP tools are disabled. Custom `python`, `terminal`, `edit_file`, `view_image`, `web_search`, and any caller-supplied declarations are deferred back to the OpenAI caller and never executed, opened, written, searched, or spawned by this process.

Sampling fields currently accepted by the OpenAI endpoint are ignored when Copilot cannot honor them. `response_format`, unsupported tool selection modes, image/audio parts, and invalid tool schemas return OpenAI `invalid_request_error` responses.
