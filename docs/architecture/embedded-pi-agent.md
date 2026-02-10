# Embedded Pi Agent 核心执行引擎分析

本文档深入分析 OpenClaw 中 Embedded Pi Agent 的内部执行细节，包括 PI Agent SDK 交互、事件订阅、流式处理、工具执行、Context 管理等。

---

## 架构概览

```
runEmbeddedPiAgent()                     -- 主入口，auth 轮转，重试循环
  |
  v
runEmbeddedAttempt()                     -- 单次尝试
  |
  |-- createOpenClawCodingTools()        -- 工具创建 + 策略过滤
  |-- buildEmbeddedSystemPrompt()        -- 系统提示词组装
  |-- SessionManager.open()              -- JSONL 会话文件
  |-- createAgentSession()               -- PI SDK 会话
  |-- subscribeEmbeddedPiSession()       -- 事件订阅
  |-- setActiveEmbeddedRun()             -- Queue handle 注册
  |
  v
activeSession.prompt(effectivePrompt)    -- 核心 LLM 调用
  |
  PI Agent SDK 内部循环:
  |   transformContext() -> convertToLlm() -> streamFn() -> 处理响应
  |   -> tool_use -> execute tool -> tool_result -> 继续循环
  |   -> end_turn (无更多 tool calls)
  |
  v
事件流处理 (subscribeEmbeddedPiSession)
  |-- message_start/update/end           -- 文本流式处理
  |-- tool_execution_start/update/end    -- 工具执行追踪
  |-- auto_compaction_start/end          -- Context 压缩
```

### 核心文件索引

| 文件                                                     | 说明                             | 规模      |
| -------------------------------------------------------- | -------------------------------- | --------- |
| `src/agents/pi-embedded-runner/run.ts`                   | 主入口，auth 轮转，重试循环      | ~725 行   |
| `src/agents/pi-embedded-runner/run/attempt.ts`           | 单次尝试，5 个阶段               | ~900 行   |
| `src/agents/pi-embedded-runner/run/params.ts`            | `RunEmbeddedPiAgentParams` 类型  | 105+ 字段 |
| `src/agents/pi-embedded-subscribe.ts`                    | 事件订阅入口，状态管理           | ~566 行   |
| `src/agents/pi-embedded-subscribe.handlers.ts`           | 事件路由 switch                  |           |
| `src/agents/pi-embedded-subscribe.handlers.messages.ts`  | 消息流式处理                     |           |
| `src/agents/pi-embedded-subscribe.handlers.tools.ts`     | 工具执行追踪                     |           |
| `src/agents/pi-embedded-subscribe.handlers.lifecycle.ts` | 生命周期 (start/end/compaction)  |           |
| `src/agents/pi-embedded-runner/system-prompt.ts`         | 系统提示词组装                   |           |
| `src/agents/pi-embedded-runner/compact.ts`               | Context 压缩                     | ~500 行   |
| `src/agents/pi-embedded-runner/model.ts`                 | Model 发现与解析                 |           |
| `src/agents/pi-embedded-runner/runs.ts`                  | 活跃运行追踪，steering/abort     |           |
| `src/agents/pi-embedded-runner/extra-params.ts`          | Stream 参数注入                  |           |
| `src/agents/pi-embedded-runner/cache-ttl.ts`             | Cache TTL 追踪                   |           |
| `src/agents/pi-embedded-runner/history.ts`               | 历史轮次限制                     |           |
| `src/agents/compaction.ts`                               | 压缩算法 (自适应分块 + 分段摘要) |           |

---

## 1. 主入口: runEmbeddedPiAgent()

### 1.1 Session Lane 队列化

```
resolveEmbeddedSessionLane(sessionKey)
  -> session lane (per-session 串行)
  -> global lane (全局串行)
  -> enqueue 整个运行
```

确保每个 session 的操作串行执行，避免并发写入会话文件。

### 1.2 Model 解析

```
resolveModel(provider, modelId, config)
  |-- Model registry 查找
  |-- Inline provider models (config.models.providers)
  |-- Forward-compat fallbacks:
  |     Codex gpt-5.3 -> gpt-5.2 template
  |     Opus 4.6 -> Opus 4.5 template
  |-- Context window 校验:
  |     < CONTEXT_WINDOW_HARD_MIN_TOKENS -> throw FailoverError
  |     < CONTEXT_WINDOW_WARN_BELOW_TOKENS -> log warning
```

### 1.3 Auth Profile 轮转

```
构建有序的 auth profile 候选列表
  |
  v
尝试 profile[0]
  |-- 成功 -> 标记 "good"
  |-- Auth 失败 -> 标记 "failed" + cooldown -> 尝试 profile[1]
  |-- Rate limit -> cooldown -> 尝试 profile[1]
  |-- 所有 profile 耗尽 -> 返回错误
```

### 1.4 主重试循环

```
while (true) {
  attempt = runEmbeddedAttempt(params)

  if (context_overflow && retries < 3) {
    compactEmbeddedPiSessionDirect()  // 压缩
    continue                          // 重试
  }

  if (thinking_unsupported) {
    downgrade thinking level          // 降级
    continue                          // 重试
  }

  if (auth_failure) {
    advance to next profile           // 轮转
    continue                          // 重试
  }

  break  // 成功或不可重试的错误
}
```

---

## 2. 单次尝试: runEmbeddedAttempt()

### Phase 1: 准备 (lines 142-400)

**工具创建**:

```
createOpenClawCodingTools(runtimeContext)
  -> 见 tool-initialization.md 完整流程
  -> 输出: 经过策略过滤 + 适配包装的工具列表
```

**系统提示词组装** (`buildEmbeddedSystemPrompt`):

```
组件:
  |-- OpenClaw 身份与用途
  |-- 当前运行时 (host, OS, Node, model)
  |-- Skills prompt (自定义工具文档)
  |-- Bootstrap context files
  |-- Channel capabilities + message tool hints
  |-- Sandbox info (如果在容器中)
  |-- Thinking level guidance
  |-- Reaction guidance (Telegram/Signal)
  |-- TTS hints
  |-- Timezone + 当前时间
  |-- Tool list + schemas
  |-- Model aliases
```

### Phase 2: Session 初始化 (lines 401-543)

```
获取 session 写锁
  |
  v
SessionManager.open(sessionFile)
  |-- JSONL 格式会话文件
  |-- 损坏文件自动修复
  |-- prewarmSessionFile (OS page cache 预热, 45s TTL)
  |
  v
createAgentSession({
  cwd, model, thinkingLevel, tools,
  sessionManager, settingsManager
})
  |
  v
设置 streamFn:
  streamSimple (base LLM stream, from @mariozechner/pi-ai)
    -> cache trace wrapper (缓存可观测性)
    -> Anthropic payload logger (请求体日志)
    -> extra-params wrapper (temperature/maxTokens/cacheRetention)
  |
  v
历史消息清洗:
  |-- 校验 turn 顺序 (Gemini/Anthropic)
  |-- 限制 DM 历史 (limitHistoryTurns)
  |-- 移除无效状态
  |-- 替换 agent messages
```

### Phase 3: 订阅与流式设置 (lines 622-661)

```
subscribeEmbeddedPiSession({
  session, runId,
  onBlockReply,        // 流式文本块
  onPartialReply,      // 增量更新
  onToolResult,        // 工具执行摘要
  onReasoningStream,   // Thinking 块流式
  onAssistantMessageStart,  // 打字信号
  onAgentEvent,        // 低级别事件
})
  -> { assistantTexts, toolMetas, unsubscribe, ... }
  |
  v
setActiveEmbeddedRun(sessionId, queueHandle)
  -> ACTIVE_EMBEDDED_RUNS Map 注册
  -> 允许外部 steer/abort
  |
  v
设置超时 + 外部 abort signal
```

### Phase 4: Prompt 执行 (lines 717-846)

```
运行 before_agent_start hook
  |-- 插件可注入上下文
  |-- 前置 hook 上下文到 prompt
  |
  v
图像检测与加载 (vision 模型)
  |-- 检测 prompt 中的图像引用
  |-- 从磁盘/URL 加载
  |-- 注入历史消息中的图像
  |
  v
修复孤立的 trailing user messages
  |-- 检测角色顺序错误
  |-- branch back 或 reset leaf
  |
  v
★ await abortable(activeSession.prompt(effectivePrompt, { images })) ★
  |
  |  PI Agent SDK 内部循环:
  |  1. transformContext(messages)     -- 上下文预处理 hook
  |  2. convertToLlm(messages)        -- 过滤为 user/assistant/toolResult
  |  3. streamFn(model, context, options)  -- LLM API 调用
  |  4. 处理流式响应 -> 发射 events
  |  5. 如果有 tool_use -> 执行工具 -> tool_result
  |  6. 检查 steering messages (每个工具后)
  |  7. 循环直到 end_turn
  |
  v
等待 auto-compaction 完成 (如果触发)
```

### Phase 5: 结果提取与清理 (lines 880-921)

```
提取最后 assistant message
  |
  v
工具元数据标准化 (过滤无效条目)
  |
  v
返回 EmbeddedRunAttemptResult:
  { aborted, timedOut, promptError,
    messagesSnapshot, assistantTexts, toolMetas,
    lastAssistant, lastToolError,
    didSendViaMessagingTool, messagingToolSentTexts }
  |
  v
清理:
  |-- flush pending tool results
  |-- dispose session
  |-- 释放 session 写锁
  |-- 恢复 skill 环境
  |-- 恢复工作目录
```

---

## 3. 事件订阅系统

### 3.1 状态管理

`EmbeddedPiSubscribeState` 追踪:

```typescript
{
  assistantTexts: string[];           // 累积的 assistant 文本块
  toolMetas: Map<string, ToolMeta>;   // 按 toolCallId 索引的工具元数据
  deltaBuffer: string;                // 文本 delta 累积缓冲
  blockBuffer: string;                // block reply 缓冲
  blockState: {
    thinking: boolean;                // 当前是否在 <think> 块内
    final: boolean;                   // 当前是否在 <final> 块内
    inlineCode: boolean;              // 当前是否在代码块内
  };
  messagingToolSentTexts: string[];   // 已通过工具发送的文本 (去重用)
  compactionInFlight: boolean;        // 压缩是否进行中
  pendingCompactionRetry: number;     // 待重试压缩次数
}
```

### 3.2 消息流式处理

#### handleMessageStart

- 重置所有流式缓冲区和状态
- 设置 `assistantTextBaseline` (用于去重)
- 调用 `onAssistantMessageStart?.()` (typing 信号)

#### handleMessageUpdate

```
text_delta 事件:
  |
  |-- 累积到 deltaBuffer
  |-- 如果有 blockChunker: feed chunk
  |   否则: 追加到 blockBuffer
  |
  |-- stripBlockTags(chunk, blockState)
  |   跨 chunk 状态追踪 <think>/<final> 标签
  |   代码块内跳过标签
  |
  |-- reasoning streaming (如启用):
  |   extractThinkingFromTaggedStream()
  |   -> onReasoningStream({ text })
  |
  |-- onPartialReply({ text, mediaUrls })
  |-- onAgentEvent({ stream: "assistant", data: { text, delta } })
  |
  |-- block emission:
  |   blockReplyBreak === "text_end" && is text_end -> drain force
  |   否则 -> normal drain (基于 min/max char 阈值)
```

#### handleMessageEnd

```
  |-- promoteThinkingTagsToBlocks() -> 内联 <think> 转为 content blocks
  |-- 提取 reasoning
  |-- 最终文本组装 + strip tags
  |-- 去重检查 (vs messagingToolSentTexts)
  |-- 如果 blockReplyBreak === "message_end": drain buffer
  |-- 发射最终 reasoning (if includeReasoning)
  |-- 尾部指令解析 (consumeReplyDirectives)
```

### 3.3 工具执行追踪

#### handleToolExecutionStart (async)

```
  |-- flushBlockReplyBuffer() (保持消息边界)
  |-- 构造工具元数据 (name, args, flags)
  |-- 如果 shouldEmitToolResult(): emitToolSummary()
  |-- 检测 messaging tool:
  |   |-- 提取接收者 target + 消息文本
  |   |-- 存入 pendingMessagingTexts (未提交)
```

#### handleToolExecutionEnd

```
  |-- 成功:
  |   |-- pendingMessagingTexts -> 提交到 messagingToolSentTexts
  |   |-- 标准化文本用于未来去重
  |   |-- 维持最大 200 条
  |
  |-- 失败:
  |   |-- 丢弃 pending 文本
  |   |-- 记录 lastToolError
  |
  |-- emitToolOutput() (如 verboseLevel === "full")
```

### 3.4 生命周期处理

#### handleAutoCompactionEnd

```
  willRetry: true
    |-- resetForCompactionRetry() -> 清除所有累积状态
    |-- noteCompactionRetry() -> 递增重试计数
  willRetry: false
    |-- maybeResolveCompactionWait() -> 解析等待 promise
```

---

## 4. Thinking 标签处理

### 识别的标签类型

| 标签        | 开始            | 结束             |
| ----------- | --------------- | ---------------- |
| think       | `<think>`       | `</think>`       |
| thinking    | `<thinking>`    | `</thinking>`    |
| thought     | `<thought>`     | `</thought>`     |
| antthinking | `<antthinking>` | `</antthinking>` |

### 跨 chunk 状态追踪

`stripBlockTags(text, blockState)`:

```
输入: "...some text <think>reasoning..." (chunk 1)
blockState.thinking = true

输入: "...more reasoning</think> final answer" (chunk 2)
blockState.thinking = false
输出: " final answer" (reasoning 部分被 strip)
```

**代码块感知**: 如果在 `` ` `` 内，不处理标签。

**`<final>` 强制模式** (可选): 只返回 `<final>` 块内的内容，防止 reasoning 泄漏。

### Reasoning 流式输出

```
extractThinkingFromTaggedStream(deltaBuffer, blockState)
  -> 提取未闭合 <think> 标签内的可见文本
  -> formatReasoningMessage() 包装为 "Reasoning:\n_..._"
  -> onReasoningStream({ text })
  -> 去重: 相同文本不重复发射
```

---

## 5. Block Reply Chunking

### 配置

```typescript
BlockReplyChunking = {
  minChars: number;           // 发射前最低字符数
  maxChars: number;           // 每块最大字符数
  breakPreference: "paragraph" | "newline" | "sentence";
  flushOnParagraph?: boolean; // 段落边界立即刷新
};
```

### 发射时机

| blockReplyBreak | 行为                                 |
| --------------- | ------------------------------------ |
| `"text_end"`    | 每个 `text_end` 事件时 drain (force) |
| `"message_end"` | 只在 `message_end` 时 drain          |

### EmbeddedBlockChunker

- 缓冲输入文本
- `drain()`: 按安全断点 (段落/换行/句号) 分割
- 保持 Markdown 代码围栏完整 (重新开闭)
- `force: true` = 发射所有剩余内容
- `force: false` = 只在达到 minChars 阈值时发射

---

## 6. Steering 与 Follow-up 机制

### 活跃运行管理

`src/agents/pi-embedded-runner/runs.ts`:

```typescript
ACTIVE_EMBEDDED_RUNS: Map<sessionId, EmbeddedPiQueueHandle>

// 注入用户消息 (运行中)
queueEmbeddedPiMessage(sessionId, text)
  -> handle.queueMessage(text)
  -> activeSession.steer(text)
  // PI SDK 在当前工具执行完后投递 steering message

// 中止运行
abortEmbeddedPiRun(sessionId)
  -> handle.abort()
  -> abortRun() + abort timeout

// 等待运行结束
waitForEmbeddedPiRunEnd(sessionId, timeoutMs = 15000)
  -> Promise<boolean>

// 检查状态
isEmbeddedPiRunActive(sessionId)
isEmbeddedPiRunStreaming(sessionId)
```

### PI SDK 内部的 Steering 处理

```
Agent Loop 每个 turn:
  1. 执行 LLM 调用
  2. 处理响应 (text/tool_use)
  3. 如果有 tool calls:
     对每个 tool:
       execute tool
       检查 getSteeringMessages()  <-- 这里投递 steering
       如果有 steering -> 插入用户消息, 跳过剩余 tools
  4. 检查 getFollowUpMessages()  <-- 循环结束后投递 follow-up
```

---

## 7. Context 管理与压缩

### 触发条件

Context overflow 错误 (LLM API 返回 token 超限) -> 触发压缩

### 压缩流程

```
compactEmbeddedPiSessionDirect()
  |
  |-- 重新打开 session file
  |-- 重建 agent session
  |-- 重新应用系统提示词
  |
  |-- 自适应分块:
  |   computeAdaptiveChunkRatio(messages, contextWindow)
  |   base 40%, min 15%, 20% safety margin
  |
  |-- 分段摘要:
  |   summarizeInStages(messages, model, apiKey)
  |   |-- 分割为 chunks
  |   |-- 分别摘要
  |   |-- 合并为最终摘要
  |
  |-- 结果: { summary, firstKeptEntryId, tokensBefore, tokensAfter }
```

### Context Pruning Extension (cache-ttl 模式)

```
cache 过期 (默认 5 min)
  |
  |-- 保留最近 N 个 assistant turns (默认 3)
  |-- Soft trim: 大型 tool result (>30%) -> 保留首 1.5K + 尾 1.5K
  |-- Hard clear: 超大 tool result (>50%) -> "[Old tool result content cleared]"
```

### Compaction Safeguard 模式

```
overflow 检测
  |
  |-- 先裁剪: drop oldest chunks if > maxHistoryShare (50%)
  |-- 保留工具错误摘要 (最多 8 条)
  |-- 记录文件操作 (read/modified files)
  |-- 再摘要: summarize dropped messages
```

---

## 8. streamFn 与 Prompt Caching

### streamFn 包装链

```
streamSimple (from @mariozechner/pi-ai)
  |-- 路由到 provider 实现 (Anthropic/OpenAI/Google)
  |
  -> cache trace wrapper
  |  记录 model info, system prompt digest, messages digest
  |  输出到 ~/.openclaw/state/logs/cache-trace.jsonl
  |
  -> Anthropic payload logger
  |  捕获完整 API 请求体 + usage metrics
  |  输出到 ~/.openclaw/state/logs/anthropic-payload.jsonl
  |
  -> extra-params wrapper
     注入 temperature, maxTokens, cacheRetention
```

### Prompt Caching 机制

| Provider      | 机制             | Cache Key                                         |
| ------------- | ---------------- | ------------------------------------------------- |
| Anthropic     | 自动 (内容 hash) | `cache_control` on 系统提示词 + 最后 user message |
| OpenAI Codex  | Session 级       | `prompt_cache_key` + `session_id` header          |
| Google Gemini | Session 级       | `sessionId` in request                            |

Cache retention 配置:

```yaml
agents:
  defaults:
    models:
      "anthropic/claude-opus-4":
        params:
          cacheRetention: "long" # 1 小时 TTL
          # "short" = ephemeral (默认)
          # "none" = 不缓存
```

---

## 9. 错误处理与弹性

| 错误类型         | 处理方式                            |
| ---------------- | ----------------------------------- |
| Auth 失败        | Auth profile 轮转 + cooldown        |
| Rate limit       | Cooldown + 重试                     |
| Thinking 不支持  | 降级 (xhigh -> high -> off) + 重试  |
| Context overflow | Auto-compaction (最多 3 次) + 重试  |
| 图像尺寸/格式    | 返回用户友好错误，不自动重试        |
| 超时             | Abort + grace period + 日志         |
| 角色顺序错误     | 自动修复 (branch back / reset leaf) |
| 会话文件损坏     | 自动修复 (SessionManager)           |

---

## 10. 优化机会

详见同目录下的讨论。关键优化点:

| 优化                    | 现状                     | 机会                            |
| ----------------------- | ------------------------ | ------------------------------- |
| `transformContext` hook | 未使用                   | 每次 LLM 调用前主动裁剪 context |
| 预测性压缩              | 反应式 (overflow 后触发) | 85% 阈值提前触发                |
| Token-based 历史限制    | Turn-based               | Token budget sliding window     |
| 动态 thinking level     | 静态 per-request         | 根据消息复杂度调整              |
| 自适应 cacheRetention   | 静态 per-model           | 根据 session 特征动态选择       |
