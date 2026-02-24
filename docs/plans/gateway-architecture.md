# OpenClaw Gateway Architecture

## Overview

Central WebSocket/HTTP RPC server on port 18789. Orchestrates agent sessions, channel communications, plugin lifecycle, outbound delivery. Single port multiplexes HTTP + WebSocket.

## Key Files

- `src/gateway/server.impl.ts` — Main startup: `startGatewayServer(port, opts)`
- `src/gateway/server/ws-connection.ts` — WebSocket connection lifecycle + challenge handshake
- `src/gateway/server/ws-connection/message-handler.ts` — RPC frame dispatch
- `src/gateway/server-methods.ts` — Core handler registry (40+ methods)
- `src/gateway/server-methods/*.ts` — Individual method handlers
- `src/gateway/server-http.ts` — HTTP endpoints (OpenAI compat, canvas, webhooks)
- `src/gateway/server-chat.ts` — Chat run state & streaming buffer
- `src/gateway/server-channels.ts` — Channel lifecycle manager (start/stop, backoff restart)
- `src/gateway/server-plugins.ts` — Plugin loading
- `src/gateway/call.ts` — `callGateway()` RPC client (used by agents, CLI, subagents)
- `src/gateway/auth.ts` — Auth modes (token, password, device, local, trusted-proxy, tailscale)
- `src/gateway/config-reload.ts` — Hot reload mechanism
- `src/gateway/boot.ts` — One-time BOOT.md startup script
- `src/gateway/protocol/index.ts` — RPC schema (AJV validators)
- `src/process/command-queue.ts` — Command Lane system (Main/Cron/Subagent/Nested)
- `src/process/supervisor/` — Process spawning & management
- `src/infra/agent-events.ts` — Agent event emission + streaming
- `src/infra/outbound/agent-delivery.ts` — Outbound delivery plan resolution
- `src/infra/outbound/delivery-queue.ts` — Persistent delivery queue with retry
- `src/routing/resolve-route.ts` — Agent routing logic (hierarchical binding resolution)
- `src/plugins/hooks.ts` — Hook execution engine
- `src/daemon/` — Service management (macOS launchd, Linux systemd, Windows schtasks)

## Startup Sequence

1. Config load + validation + auto-migration
2. Auth bootstrap (generate/load gateway token)
3. Plugin loading → `loadOpenClawPlugins()` scans `extensions/*/`
4. HTTP/WS server creation (same port)
5. Sidecar services: browser control, channel manager, cron, heartbeat, node discovery
6. Event listener registration (agent events, heartbeat, skills changes)
7. Config hot-reload watcher
8. Graceful shutdown via `gateway_stop` hook

## WebSocket RPC Protocol

- Custom JSON frame protocol (not JSON-RPC)
- Frame types: `request` (id + method + params), `response` (id + ok + payload/error), `event` (unsolicited push)
- Connection starts with challenge-response handshake (nonce + token/signature)
- Auth: role-based (operator/node/viewer) + scope-based (admin, session:_, device:_)

## RPC Methods (40+)

- **Agent**: `agent`, `agent.wait`, `agent.identity.get`
- **Chat**: `chat.send`, `chat.history`, `chat.abort`
- **Sessions**: `sessions.list/preview/patch/reset/delete/compact`
- **Send**: `send` (outbound delivery)
- **Channels**: `channels.status`, `channels.logout`
- **Config**: `config.get/set/apply/patch/schema`
- **Cron**: `cron.list/add/update/remove/run`
- **Nodes**: `nodes.list/describe/invoke/pair.*`
- **Devices**: `devices.pair/token`
- **Skills**: `skills.status/install/update`
- **Health**: `health`, `status`, `logs.tail`
- **+ Plugin methods**: plugins extend via `plugin.gatewayMethods`

## HTTP Endpoints

- `GET /` — Control UI dashboard
- `POST /v1/chat/completions` — OpenAI-compatible API
- `POST /v1/responses` — OpenResponses streaming API
- `POST /tools/*` — Tool execution
- `/a2ui/*` — Canvas/AI UI preview
- `/avatar/*` — Agent avatars
- Slack webhooks — incoming Slack messages

## Message Flow: Inbound

1. Channel plugin receives message (webhook/stream)
2. Preflight checks (permissions, allowlist, mentions)
3. Route resolution: peer → guild+role → account → channel → default agent
4. Session key build: `agent:<agentId>:main:<channel>:<accountId>:<peerKind>:<peerId>`
5. Enqueue to Command Lane (Main lane, concurrency=1 by default)
6. `dispatchInboundMessage()` → `agentCommand()` → Pi Embedded Runner

## Message Flow: Agent Execution

1. Load SessionManager (disk-persisted conversation history)
2. Build system prompt (+ hooks: `beforePromptBuild`)
3. Resolve model (agent config + fallbacks + hooks: `beforeModelResolve`)
4. LLM streaming call with tools
5. Tool execution loop (bash, file ops, web, etc.)
6. Context overflow → session compaction
7. Save session + return result

## Message Flow: Outbound

1. `resolveAgentDeliveryPlan()` — determine channel + recipient
2. Message formatting (chunking, markdown)
3. Deliver via channel plugin `outbound.send()`
4. Persist to delivery queue (`~/.openclaw/state/delivery-queue/`)
5. Retry: 5 attempts, exponential backoff (5s→25s→2min→10min)

## Command Lane System

- `Main` — primary chat (concurrency=1)
- `Cron` — scheduled jobs (parallel with main)
- `Subagent` — child agent runs
- `Nested` — nested calls
- Each lane: independent queue, configurable concurrency, survives gateway restart

## Session Routing Hierarchy

1. Peer binding (thread-specific)
2. Parent peer binding (thread inheritance)
3. Guild + role binding (Discord)
4. Guild binding (Discord server-wide)
5. Team binding (MS Teams)
6. Account binding (per-account default)
7. Channel binding (fallback)
8. Default agent

## Plugin Hook Lifecycle

`gateway_start/stop` → `messageReceived/Sending/Sent` → `beforeAgentStart` → `beforeModelResolve` → `beforePromptBuild` → `llmInput/llmOutput` → `beforeToolCall/afterToolCall` → `sessionStart/sessionEnd` → `subagentSpawning/spawned/ended`

Hooks: priority-ordered, async, result-merging.

## Config Hot Reload

- Hot-reloadable: config patches, hook mappings, cron jobs, heartbeat, browser config
- Requires restart: plugin enable/disable, channel credentials, TLS settings

## Deployment

- Docker: port 18789 (WS/HTTP) + 18790 (bridge), volumes `~/.openclaw`
- Fly.io: `shared-cpu-2x`, 2GB RAM, persistent `/data` volume
- Daemon: macOS (launchd), Linux (systemd), Windows (schtasks); auto-restart on crash

## Agent Limits (defaults)

- `DEFAULT_AGENT_MAX_CONCURRENT = 4`
- `DEFAULT_SUBAGENT_MAX_CONCURRENT = 8`
- `DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH = 1`
