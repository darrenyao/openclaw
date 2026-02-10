# Chat 到 Agent 完整数据流转分析

本文档基于源码分析，梳理 OpenClaw 从消息接收到 Agent 执行完成再到响应投递的完整数据流。

---

## 架构分层

```
+------------------------------------------------------------------+
|                        Entry Points (入口层)                       |
|  Telegram | Discord | Slack | Signal | iMessage | Web | Plugins   |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                       Dispatch Layer (分发层)                      |
|  MsgContext 构建 -> finalizeInboundContext -> dispatchInboundMessage|
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                        Reply Layer (编排层)                        |
|  getReplyFromConfig -> resolveDirectives -> runPreparedReply      |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                      Agent Runner (执行层)                        |
|  runReplyAgent -> runAgentTurnWithFallback -> runEmbeddedPiAgent  |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                    Embedded Pi Agent (核心 AI)                     |
|  runEmbeddedAttempt -> activeSession.prompt() -> 事件订阅/流式处理  |
+------------------------------------------------------------------+
                              |
                              v
+------------------------------------------------------------------+
|                    Response Delivery (投递层)                      |
|  ReplyDispatcher -> deliverReply / routeReply -> Channel Send     |
+------------------------------------------------------------------+
```

### 核心文件索引

| 层级    | 文件                                             | 核心函数                       |
| ------- | ------------------------------------------------ | ------------------------------ |
| 入口层  | `src/telegram/bot/message-handler.ts`            | Telegram 入口                  |
| 入口层  | `src/discord/monitor/message-handler.process.ts` | `processDiscordMessage()`      |
| 入口层  | `src/slack/events/message.ts`                    | Slack 入口                     |
| 分发层  | `src/auto-reply/dispatch.ts`                     | `dispatchInboundMessage()`     |
| 分发层  | `src/auto-reply/reply/dispatch-from-config.ts`   | `dispatchReplyFromConfig()`    |
| 分发层  | `src/auto-reply/templating.ts`                   | `MsgContext` 类型定义          |
| 编排层  | `src/auto-reply/reply/get-reply.ts`              | `getReplyFromConfig()`         |
| 编排层  | `src/auto-reply/reply/get-reply-run.ts`          | `runPreparedReply()`           |
| 执行层  | `src/auto-reply/reply/agent-runner.ts`           | `runReplyAgent()`              |
| 执行层  | `src/auto-reply/reply/agent-runner-execution.ts` | `runAgentTurnWithFallback()`   |
| 核心 AI | `src/agents/pi-embedded-runner/run.ts`           | `runEmbeddedPiAgent()`         |
| 核心 AI | `src/agents/pi-embedded-runner/run/attempt.ts`   | `runEmbeddedAttempt()`         |
| 核心 AI | `src/agents/pi-embedded-subscribe.ts`            | `subscribeEmbeddedPiSession()` |
| 投递层  | `src/auto-reply/reply/reply-dispatcher.ts`       | `ReplyDispatcher`              |
| 投递层  | `src/auto-reply/reply/route-reply.ts`            | `routeReply()`                 |

---

## 1. 入口层 (Channel Layer)

每个消息通道将原始消息转换为统一的 `MsgContext`:

### MsgContext 核心字段

```typescript
type MsgContext = {
  Body?: string; // 完整消息体 (含 envelope/history/context)
  RawBody?: string; // 原始消息 (无结构化上下文)
  CommandBody?: string; // 命令检测用
  From?: string; // 发送者标识 (如 "discord:123456")
  To?: string; // 接收者/回复目标
  SessionKey?: string; // 会话路由键
  AccountId?: string; // Provider 账号 ID
  ChatType?: string; // "direct" | "channel" | "group"
  SenderId?: string; // 发送者 ID
  SenderName?: string; // 发送者昵称
  SenderUsername?: string; // 发送者用户名
  Provider?: string; // 如 "telegram", "discord"
  Surface?: string; // Provider surface label
  WasMentioned?: boolean; // 是否被 @
  CommandAuthorized?: boolean;
  OriginatingChannel?: string; // 回复路由用
  OriginatingTo?: string; // 回复目标
  MessageSid?: string; // 消息 ID
  Timestamp?: number;
  // ... 更多字段 (媒体、转发、线程、群组等)
};
```

### Channel 处理示例 (Discord)

`src/discord/monitor/message-handler.process.ts`:

```
Discord 原始事件
  |
  |-- 解析 mediaList, messageText
  |-- 构建 fromLabel (DM 或 Guild)
  |-- 处理 Forum/Thread 上下文
  |-- 构建 channel history (guild messages)
  |-- 解析 reply context (引用消息)
  |-- 解析 thread starter body
  |
  v
finalizeInboundContext({
  Body: combinedBody,
  RawBody: baseText,
  From: effectiveFrom,
  To: effectiveTo,
  SessionKey: threadKeys.sessionKey,
  Provider: "discord",
  Surface: "discord",
  ...
})
  |
  v
dispatchInboundMessage(ctx, cfg, dispatcher, replyOptions)
```

---

## 2. 分发层 (Dispatch Layer)

### dispatchInboundMessage

`src/auto-reply/dispatch.ts` -> `src/auto-reply/reply/dispatch-from-config.ts`

```
MsgContext
  |
  |-- 去重检查 (shouldSkipDuplicateInbound)
  |-- 判断是否需要跨 provider 路由 (originatingChannel != currentSurface)
  |-- 运行 message_received hook
  |-- 快速 abort 检查 (tryFastAbortFromMessage)
  |
  v
getReplyFromConfig(ctx, opts, cfg)
  |
  |-- 处理回复:
  |   |-- 正常回复 -> dispatcher.sendFinalReply(payload)
  |   |-- 跨 provider -> routeReply({ channel, to, payload })
  |   |-- Block streaming -> dispatcher.sendBlockReply(payload)
  |   |-- Tool result -> dispatcher.sendToolResult(payload)
  |
  |-- TTS 处理 (maybeApplyTtsToPayload)
  |-- 等待 dispatcher 空闲
  |
  v
{ queuedFinal, counts }
```

---

## 3. 编排层 (Reply Layer)

### getReplyFromConfig

`src/auto-reply/reply/get-reply.ts`:

```
ctx (MsgContext)
  |
  |-- 解析 agentId (resolveSessionAgentId)
  |-- 解析 provider/model (resolveDefaultModel)
  |-- 准备 workspace (ensureAgentWorkspace)
  |-- 创建 typing controller
  |-- finalizeInboundContext (CommandAuthorized default-deny)
  |-- 媒体理解 (applyMediaUnderstanding)
  |-- 链接理解 (applyLinkUnderstanding)
  |-- 命令授权 (resolveCommandAuthorization)
  |-- 会话初始化 (initSessionState)
  |   -> sessionEntry, sessionStore, sessionKey, isNewSession
  |-- 模型覆盖 (applyResetModelOverride)
  |-- 指令解析 (resolveReplyDirectives)
  |   -> thinking level, model switch, queue mode, etc.
  |-- 内联操作 (handleInlineActions)
  |   -> /new, /reset, /think, /model, etc.
  |-- 沙箱媒体准备 (stageSandboxMedia)
  |
  v
runPreparedReply(params)
```

### runPreparedReply

`src/auto-reply/reply/get-reply-run.ts`:

```
params
  |
  |-- 空消息检查
  |-- 会话提示拼接 (applySessionHints)
  |-- 系统事件前置 (prependSystemEvents)
  |-- 不可信上下文追加 (appendUntrustedContext)
  |-- Thread starter body 处理
  |-- Skill snapshot 加载
  |-- 媒体注释构建 (buildInboundMediaNote)
  |-- Thinking level 解析/降级
  |-- /new /reset 确认消息发送
  |-- 队列设置解析 (resolveQueueSettings)
  |-- 中断/steering 逻辑
  |-- Auth profile 解析
  |-- followupRun 构建 (完整运行参数)
  |
  v
runReplyAgent(params)
```

---

## 4. 执行层 (Agent Runner)

### runReplyAgent

`src/auto-reply/reply/agent-runner.ts`:

```
params
  |
  |-- Typing 信号启动
  |-- Block reply 管道建立
  |-- 队列入队 (如果有 followup/steer/collect 模式)
  |
  v
runAgentTurnWithFallback(params)
  |
  |-- Model fallback 编排
  |   |-- 尝试当前 model
  |   |-- Auth 失败 -> 轮转到下一个 auth profile
  |   |-- Rate limit -> cooldown + 重试
  |   |-- 不支持的 thinking level -> 降级重试
  |   |-- Context overflow -> 自动压缩 (最多 3 次)
  |
  v
runEmbeddedPiAgent(params) 或 runCliAgent(params)
```

---

## 5. 核心 AI 执行 (Embedded Pi Agent)

### runEmbeddedPiAgent

`src/agents/pi-embedded-runner/run.ts`:

```
params (RunEmbeddedPiAgentParams, 105+ 字段)
  |
  |-- Session/Global Lane 入队 (串行执行保证)
  |-- Workspace 解析
  |-- Model 解析 + context window 校验
  |-- Auth profile 管理 (候选列表、轮转、冷却追踪)
  |
  |-- 主重试循环:
  |   |
  |   v
  |   runEmbeddedAttempt(params) --- 见下方详细流程
  |   |
  |   |-- 成功 -> 构建 payloads, 返回结果
  |   |-- Auth 失败 -> 轮转到下一个 profile
  |   |-- Thinking 不支持 -> 降级 + 重试
  |   |-- Context overflow -> compactEmbeddedPiSessionDirect() + 重试
  |   |-- 其他错误 -> 分类处理
  |
  v
EmbeddedPiRunResult { payloads, meta, messagingToolSentTexts }
```

### runEmbeddedAttempt (单次尝试)

`src/agents/pi-embedded-runner/run/attempt.ts` (~900 行):

```
Phase 1: 准备 (lines 142-400)
  |-- 工具创建: createOpenClawCodingTools()
  |-- 工具策略过滤: 9 层 AND 过滤 (见 tool-initialization.md)
  |-- Google 工具清洗 (如需)
  |-- 系统提示词组装: buildEmbeddedSystemPrompt()
  |     skills prompt + bootstrap files + thinking guidance
  |     channel capabilities + sandbox info + timezone

Phase 2: Session 初始化 (lines 401-543)
  |-- Session 写锁获取
  |-- SessionManager.open() (JSONL 会话文件)
  |-- createAgentSession() (PI SDK)
  |-- streamFn 设置:
  |     streamSimple (base)
  |     -> cache trace wrapper
  |     -> payload logger wrapper
  |     -> extra-params wrapper (temperature/maxTokens/cacheRetention)
  |-- 历史消息清洗 (turn 顺序校验, 限制历史)

Phase 3: 订阅与流式设置 (lines 622-661)
  |-- subscribeEmbeddedPiSession() 注册事件处理器
  |-- Queue handle 注册 (ACTIVE_EMBEDDED_RUNS)
  |-- 超时/中止信号设置

Phase 4: Prompt 执行 (lines 717-846)
  |-- before_agent_start hook
  |-- 图像检测与加载 (vision 模型)
  |-- await activeSession.prompt(effectivePrompt, { images })  <-- 核心调用
  |     PI SDK 内部循环: LLM -> tool_use -> tool_result -> LLM -> end_turn
  |-- 等待 compaction 完成

Phase 5: 结果提取与清理 (lines 880-921)
  |-- 提取最后 assistant message
  |-- 工具元数据标准化
  |-- 释放写锁, 恢复工作目录
```

---

## 6. 事件订阅系统

### subscribeEmbeddedPiSession

`src/agents/pi-embedded-subscribe.ts` + `pi-embedded-subscribe.handlers.ts`

PI Agent SDK 发出的事件类型和处理逻辑:

| 事件                    | 处理逻辑                                                                        |
| ----------------------- | ------------------------------------------------------------------------------- |
| `message_start`         | 重置流式缓冲区、block state、thinking 追踪                                      |
| `message_update`        | 累积 delta; strip thinking/final 标签; feed block chunker; 发射 partial replies |
| `message_end`           | 提升 thinking 标签为内容块; 最终文本组装; 去重检查; 发射 block reply            |
| `tool_execution_start`  | 刷新 pending block reply; 构造工具元数据; 发射工具摘要                          |
| `tool_execution_update` | 流式工具部分结果                                                                |
| `tool_execution_end`    | 提交 messaging tool 已发送文本; 记录错误; 发射工具输出                          |
| `agent_start`           | 生命周期日志                                                                    |
| `agent_end`             | 最终缓冲区刷新; 解析 compaction 等待                                            |
| `auto_compaction_start` | 标记压缩进行中                                                                  |
| `auto_compaction_end`   | 如果 willRetry: 重置所有状态并重试                                              |

### 关键流式处理机制

**Thinking 标签处理**: 识别 `<think>`, `<thinking>`, `<thought>`, `<antthinking>` 四种标签，跨 chunk 状态追踪，代码块内跳过。

**Messaging Tool 去重**: 追踪 `messagingToolSentTexts` (最多 200 条)，block reply 发射时跳过已通过工具发送的重复内容。

**Block Reply Chunking**: 按 paragraph/newline/sentence 断点分块，保持 Markdown 围栏完整性。

---

## 7. 响应投递层

```
Agent 执行完成
  |
  |-- 构建 ReplyPayload { text, mediaUrl, replyToId, audioAsVoice }
  |
  |-- 同 provider 投递:
  |   dispatcher.sendFinalReply(payload)
  |   -> 按 channel 投递 (deliverDiscordReply / sendTelegramReply / ...)
  |
  |-- 跨 provider 路由:
  |   routeReply({ channel, to, payload })
  |   -> 查找目标 channel 的发送接口
  |   -> 投递到原始来源 channel
  |
  |-- TTS 后处理 (如配置):
  |   maybeApplyTtsToPayload()
  |   -> 生成语音文件
  |   -> 附加 mediaUrl
  |
  v
消息送达用户
```

---

## 8. 辅助系统

| 系统       | 文件                                    | 说明                                                               |
| ---------- | --------------------------------------- | ------------------------------------------------------------------ |
| 路由       | `src/routing/resolve-route.ts`          | `resolveAgentRoute()` 根据 binding rules 解析 agentId + sessionKey |
| 会话存储   | `src/config/sessions.ts`                | JSONL 会话文件管理                                                 |
| 命令队列   | `src/process/command-queue.ts`          | Session-specific + global lanes 串行执行                           |
| 事件总线   | `src/infra/agent-events.ts`             | 全局 agent 事件广播                                                |
| Steering   | `src/agents/pi-embedded-runner/runs.ts` | `queueEmbeddedPiMessage()` 运行中注入用户消息                      |
| Compaction | `src/agents/compaction.ts`              | Context 压缩/摘要化                                                |
| 工具系统   | `src/agents/pi-tools.ts`                | 见 [tool-initialization.md](/architecture/tool-initialization)     |

---

## 9. 完整生命周期示例

以 Discord 群消息为例:

```
1. Discord 原始事件到达
2. processDiscordMessage() 解析消息、构建 MsgContext
3. dispatchInboundMessage() 去重、hook、路由判断
4. getReplyFromConfig() 解析 agent/model、初始化会话、处理指令
5. runPreparedReply() 拼接 prompt、加载 skills、解析队列模式
6. runReplyAgent() 启动 typing、建立 block reply 管道
7. runAgentTurnWithFallback() model fallback 编排
8. runEmbeddedPiAgent() session lane 入队、auth profile 轮转
9. runEmbeddedAttempt():
   a. 创建工具 + 系统提示词
   b. 打开 SessionManager + 创建 AgentSession
   c. 设置 streamFn + 清洗历史
   d. 订阅事件 + 注册 queue handle
   e. await activeSession.prompt() -- 核心 LLM 调用
   f. PI SDK 内部: LLM -> tool_use -> tool_result -> LLM -> end_turn
   g. 事件流: message_update -> strip tags -> chunk -> block reply
   h. 提取结果 + 清理
10. 构建 ReplyPayload
11. dispatcher.sendFinalReply() -> deliverDiscordReply()
12. 消息送达用户
```
