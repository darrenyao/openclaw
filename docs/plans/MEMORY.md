# OpenClaw Project Memory

## Channel Plugin Pattern

- Extensions live under `extensions/<name>/` with `package.json`, `openclaw.plugin.json`, `index.ts`
- Workspace already includes `extensions/*` via `pnpm-workspace.yaml`
- Plugin SDK types imported from `openclaw/plugin-sdk` (aliased via jiti)
- Key types: `ChannelPlugin`, `OpenClawConfig`, `PluginRuntime`, `DEFAULT_ACCOUNT_ID`
- Pattern: `index.ts` registers channel + sets runtime; `src/channel.ts` defines plugin
- Feishu extension is the best template for new channel plugins
- `ClawdbotConfig` = `OpenClawConfig` (alias)
- Lint: `oxlint --type-aware`, Format: `oxfmt`
- Build: `pnpm build` (rolldown/tsdown), TypeScript: `pnpm tsgo`

## DingTalk Plugin (extensions/dingtalk)

- Created 2026-02-08; uses `dingtalk-stream-sdk-nodejs` v2.0.4
- SDK exports: `DWClient`, `TOPIC_ROBOT`, `TOPIC_CARD` (named, not default)
- `DWClient.registerCallbackListener(topic, cb)` callback is synchronous (returns void)
- `DWClient.connect()` returns Promise, `DWClient.disconnect()` for cleanup
- AI Interaction API: `https://api.dingtalk.com/v1.0/aiInteraction/{reply,prepare,update,finish}`
- OAuth: `https://api.dingtalk.com/v1.0/oauth2/accessToken` with `{appKey, appSecret}`
- Reference Python impl: `../hailong-assistant/dingtalk-gateway/`

## Multi-Agent Architecture

- Detailed analysis in [multi-agent-architecture.md](multi-agent-architecture.md)

## Gateway Architecture

- Detailed analysis in [gateway-architecture.md](gateway-architecture.md)

## Personal Assistant (Jarvis) — 落地方案 v1.0

- **完整方案**：[personal-assistant-unified.md](personal-assistant-unified.md) — 场景定义、系统架构、agent 配置、cron 任务、开发缺口、任务清单
- Voice capabilities analysis in [voice-capabilities.md](voice-capabilities.md)
- 早期讨论（已合并入 unified）：[personal-assistant-plan.md](personal-assistant-plan.md)

### 关键开发缺口

1. **DingTalk 主动推送**：`outbound.sendText` 需用 `prepareCard` API 改造（AI Assistant 模式无 conversationToken）
2. **Apple Health 扩展**：添加 HRV、restingHeartRate、vo2Max、activeEnergyBurned 到 iOS 客户端
3. **钉钉日程 API**：bash 脚本调钉钉日历 API（先行）→ 后续 MCP
4. **OmniFocus JXA**：osascript 脚本读写任务

### 实施进度

- Phase 1a（资讯管线 MVP）：进行中
