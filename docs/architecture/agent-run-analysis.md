# OpenClaw AgentRun 核心架构分析

## 会话总结

本文档记录了对 OpenClaw 项目架构的完整分析，重点提取 **AgentRun 的核心逻辑**。

---

## 1. AgentRun 核心执行流程

### 分析的核心文件

| 文件                                             | 功能                                          |
| ------------------------------------------------ | --------------------------------------------- |
| `src/agents/pi-embedded-runner/run.ts`           | **runEmbeddedPiAgent()** 主执行函数           |
| `src/agents/pi-embedded-runner/run/attempt.ts`   | **runEmbeddedAttempt()** 单次执行尝试         |
| `src/agents/pi-embedded-subscribe.ts`            | **subscribeEmbeddedPiSession()** 会话事件订阅 |
| `src/infra/agent-events.ts`                      | 全局事件总线 (AgentRunContext 定义)           |
| `src/commands/agent.ts`                          | CLI 入口                                      |
| `src/auto-reply/reply/agent-runner-execution.ts` | 自动回复执行                                  |

---

## 2. 完整架构图

### 分层架构

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              Entry Points (入口层)                                │
├──────────────────────────────────────────────────────────────────────────────────┤
│  CLI (agent.ts)  │  Auto-Reply  │  Cron/Wake  │  Gateway WS  │  Sessions Tool   │
└────────┬─────────┴──────┬───────┴──────┬──────┴──────┬───────┴────────┬─────────┘
         │                │              │             │                │
         └────────────────┴──────────────┴─────────────┴────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │         Core Execution (核心执行层)       │
                    │         runEmbeddedPiAgent()            │
                    │      (pi-embedded-runner/run.ts)        │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │         Attempt Layer (尝试执行层)        │
                    │         runEmbeddedAttempt()            │
                    │    (pi-embedded-runner/run/attempt.ts)  │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │      Subscription Layer (订阅监听层)      │
                    │      subscribeEmbeddedPiSession()       │
                    │      (pi-embedded-subscribe.ts)         │
                    └────────────────────┬────────────────────┘
                                         │
         ┌───────────────────────────────┼───────────────────────────────┐
         │                               │                               │
┌────────▼────────┐            ┌─────────▼─────────┐           ┌─────────▼─────────┐
│  pi-agent-core  │            │  pi-coding-agent  │           │      pi-ai        │
│  (会话管理)      │            │  (编码工具)        │           │  (模型适配)        │
└─────────────────┘            └───────────────────┘           └───────────────────┘
```

---

## 3. 关键设计模式

### 3.1 队列串行化 (Lane 机制)

```typescript
// 每个 sessionKey 有独立的执行队列
await agentLane.run(sessionKey, async () => {
  // 串行执行，防止并发冲突
});
```

### 3.2 认证配置轮换 (Auth Profile Rotation)

```typescript
// 多个认证配置自动轮换
const authProfiles = resolveAuthProfiles(config);
for (const profile of authProfiles) {
  try {
    await runWithProfile(profile);
    break; // 成功则退出
  } catch (e) {
    // 失败则尝试下一个 profile
  }
}
```

### 3.3 模型降级策略 (Model Fallback)

```typescript
// 主模型失败时自动降级到备用模型
const models = [primaryModel, ...fallbackModels];
for (const model of models) {
  try {
    await runWithModel(model);
    break;
  } catch (e) {
    // 继续尝试下一个模型
  }
}
```

### 3.4 上下文溢出自动压缩

```typescript
// 检测 context overflow 错误
if (isContextOverflowError(error)) {
  await compactSession(sessionKey);
  // 重试执行
}
```

### 3.5 块流式响应 (Block Streaming)

```typescript
// 订阅流式事件
subscribeEmbeddedPiSession(session, {
  onBlock: (block) => {
    /* 处理文本块 */
  },
  onToolCall: (call) => {
    /* 处理工具调用 */
  },
  onToolResult: (result) => {
    /* 处理工具结果 */
  },
  onComplete: (response) => {
    /* 完成处理 */
  },
});
```

### 3.6 `<think>`/`<final>` 标签解析

```typescript
// 解析推理格式
const parsed = parseReasoningResponse(content);
// parsed.thinking - 内部推理 (不显示给用户)
// parsed.final - 最终回复 (显示给用户)
```

---

## 4. 核心数据流

```
User Message
    │
    ▼
┌─────────────────┐
│  入口层处理      │  CLI / Auto-Reply / Gateway
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  队列串行化      │  agentLane.run(sessionKey, ...)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  认证解析        │  resolveAuthProfiles()
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  System Prompt  │  buildAgentSystemPrompt()
│  构建           │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  工具创建        │  createOpenClawCodingTools()
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  会话执行        │  runEmbeddedAttempt()
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  流式订阅        │  subscribeEmbeddedPiSession()
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  响应处理        │  Block Streaming / Tool Calls
└────────┬────────┘
         │
         ▼
Final Response
```

---

## 5. 项目关键路径

```
src/agents/
├── pi-embedded-runner/
│   ├── run.ts              # 核心: runEmbeddedPiAgent
│   ├── run/
│   │   └── attempt.ts      # 单次尝试执行
│   └── system-prompt.ts    # 嵌入式系统提示封装
├── pi-embedded-subscribe.ts # 会话事件订阅
├── system-prompt.ts        # 核心系统提示构建
├── system-prompt-params.ts # 运行时参数
├── pi-tools.ts             # 工具创建
├── workspace.ts            # 工作空间文件加载
├── skills.ts               # Skills 系统
└── bootstrap-hooks.ts      # Hook 覆盖

src/infra/
└── agent-events.ts         # 全局事件总线

src/commands/
└── agent.ts                # CLI 入口

src/auto-reply/
└── reply/
    └── agent-runner-execution.ts  # 自动回复执行
```

---

## 6. 错误恢复机制

| 错误类型         | 恢复策略               |
| ---------------- | ---------------------- |
| Context Overflow | 自动压缩会话历史并重试 |
| Auth Failure     | 轮换到下一个认证配置   |
| Model Failure    | 降级到备用模型         |
| Rate Limit       | 等待后重试             |
| Network Error    | 指数退避重试           |
