# OpenClaw System Prompt 构建系统完整架构

本文档详细分析了 OpenClaw 的 System Prompt 构建系统，包括 Bootstrap 文件系统、Skills 系统、Tool 注入和 Hook 系统。

---

## 1. 核心架构图

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         System Prompt 构建流程                                    │
└──────────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────────────────┐
                    │     buildEmbeddedSystemPrompt()         │ ← Entry Point
                    │   (pi-embedded-runner/system-prompt.ts) │
                    └────────────────┬────────────────────────┘
                                     │
                    ┌────────────────▼────────────────────────┐
                    │      buildAgentSystemPrompt()           │ ← Core Builder
                    │         (system-prompt.ts)              │
                    └────────────────┬────────────────────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
    ┌─────▼─────┐            ┌───────▼───────┐          ┌───────▼───────┐
    │ Bootstrap │            │    Skills     │          │   Runtime     │
    │   Files   │            │    System     │          │    Info       │
    └─────┬─────┘            └───────┬───────┘          └───────┬───────┘
          │                          │                          │
    ┌─────▼─────────────┐    ┌───────▼───────┐          ┌───────▼───────────┐
    │ loadWorkspace     │    │ resolveSkills │          │ buildRuntimeLine  │
    │ BootstrapFiles()  │    │ PromptForRun()│          │   (model, host,   │
    │ (workspace.ts)    │    │ (skills/      │          │    channel, etc)  │
    └─────┬─────────────┘    │ workspace.ts) │          └───────────────────┘
          │                  └───────┬───────┘
          │                          │
    ┌─────▼─────────────┐    ┌───────▼─────────────────┐
    │ filterBootstrap   │    │ buildWorkspaceSkills    │
    │ FilesForSession() │    │ Prompt()                │
    │ (subagent filter) │    │ - loadSkillEntries()    │
    └─────┬─────────────┘    │ - filterSkillEntries()  │
          │                  │ - formatSkillsForPrompt │
          │                  └─────────────────────────┘
    ┌─────▼─────────────┐
    │ applyBootstrap    │
    │ HookOverrides()   │
    │ (hook injection)  │
    └───────────────────┘
```

---

## 2. Bootstrap 文件系统

**文件位置**: `src/agents/workspace.ts`

### 2.1 支持的 Bootstrap 文件

| 文件名         | 用途          |
| -------------- | ------------- |
| `AGENTS.md`    | 代理指令      |
| `SOUL.md`      | 人格/语气定义 |
| `TOOLS.md`     | 工具使用指南  |
| `IDENTITY.md`  | 身份信息      |
| `USER.md`      | 用户信息      |
| `HEARTBEAT.md` | 心跳配置      |
| `BOOTSTRAP.md` | 启动引导      |
| `MEMORY.md`    | 记忆文件      |

### 2.2 加载流程

```typescript
// 1. 加载工作区 Bootstrap 文件
loadWorkspaceBootstrapFiles(workspaceDir)
  │
  ├── AGENTS.md    → 注入到系统提示
  ├── SOUL.md      → 注入人格/语气 (如果存在，提示要求遵循)
  ├── TOOLS.md     → 注入工具指南
  ├── IDENTITY.md  → 注入身份信息
  ├── USER.md      → 注入用户信息
  ├── HEARTBEAT.md → 注入心跳配置
  └── MEMORY.md    → 注入记忆上下文

// 2. Subagent 过滤 (仅允许 AGENTS.md 和 TOOLS.md)
filterBootstrapFilesForSession(files, sessionKey)
  └── SUBAGENT_BOOTSTRAP_ALLOWLIST = ["AGENTS.md", "TOOLS.md"]

// 3. Hook 覆盖 (插件可修改 Bootstrap 文件)
applyBootstrapHookOverrides(files, context)
  └── triggerInternalHook("agent", "bootstrap", ...)
```

### 2.3 文件截断机制

防止超大文件导致 context 溢出：

```typescript
// bootstrap.ts
const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000;
const BOOTSTRAP_HEAD_RATIO = 0.7; // 保留头部 70%
const BOOTSTRAP_TAIL_RATIO = 0.2; // 保留尾部 20%

// 超长文件会被截断为: head + marker + tail
// marker: [...truncated, read {fileName} for full content...]
```

---

## 3. Skills 系统

**文件位置**: `src/agents/skills/workspace.ts`

### 3.1 Skills 加载优先级

后者覆盖前者：

```
extra < bundled < managed < workspace
  │        │         │         │
  │        │         │         └── ~/.openclaw/workspace/skills/
  │        │         └── ~/.openclaw/skills/ (managed)
  │        └── 内置 bundled skills
  └── config.skills.load.extraDirs
```

### 3.2 Skills 解析流程

```typescript
loadSkillEntries(workspaceDir, opts)
  │
  ├── loadSkills({ dir: bundledSkillsDir })
  ├── loadSkills({ dir: managedSkillsDir })
  ├── loadSkills({ dir: workspaceSkillsDir })
  └── loadSkills({ dir: extraDirs })
      │
      └── 合并去重 (按 skill.name)
          │
          └── 解析 Frontmatter:
              ├── parseFrontmatter(raw)
              ├── resolveOpenClawMetadata(frontmatter)
              └── resolveSkillInvocationPolicy(frontmatter)

// 生成 Skills Prompt
buildWorkspaceSkillsPrompt(workspaceDir, opts)
  │
  ├── filterSkillEntries(entries, config, filter, eligibility)
  │   └── shouldIncludeSkill({ entry, config, eligibility })
  │
  └── formatSkillsForPrompt(skills)  // 来自 pi-coding-agent
```

### 3.3 Skills Frontmatter 配置

```yaml
---
name: my-skill
description: Skill description
openclaw:
  primaryEnv: nodejs
command-dispatch: tool
command-tool: my_tool
command-arg-mode: raw
---
```

---

## 4. System Prompt 核心构建器

**文件位置**: `src/agents/system-prompt.ts`

### 4.1 PromptMode 类型

```typescript
type PromptMode = "full" | "minimal" | "none";

// full: 完整系统提示 (主 Agent)
// minimal: 精简系统提示 (Subagent) - 仅 Tooling, Safety, Workspace, Sandbox, Runtime
// none: 仅基础身份行
```

### 4.2 核心 Sections 构建

```typescript
buildAgentSystemPrompt(params) {
  // 1. 工具部分
  const toolLines = buildToolSection(params.toolNames, params.toolSummaries);

  // 2. 各功能 Section
  const skillsSection = buildSkillsSection({ skillsPrompt, isMinimal, readToolName });
  const memorySection = buildMemorySection({ isMinimal, availableTools });
  const docsSection = buildDocsSection({ docsPath, isMinimal, readToolName });
  const userIdentitySection = buildUserIdentitySection(ownerLine, isMinimal);
  const timeSection = buildTimeSection({ userTimezone });
  const safetySection = buildSafetySection();
  const replyTagsSection = buildReplyTagsSection(isMinimal);
  const messagingSection = buildMessagingSection({ ... });
  const voiceSection = buildVoiceSection({ isMinimal, ttsHint });

  // 3. 上下文文件注入
  for (const file of contextFiles) {
    lines.push(`## ${file.path}`, file.content);
  }

  // 4. Runtime 信息
  lines.push(buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, defaultThinkLevel));
}
```

### 4.3 System Prompt 完整结构

```
You are a personal assistant running inside OpenClaw.

## Tooling
Tool availability (filtered by policy):
- read: Read file contents
- write: Create or overwrite files
- exec: Run shell commands
...

## Tool Call Style
Default: do not narrate routine, low-risk tool calls...

## Safety
You have no independent goals...

## OpenClaw CLI Quick Reference
...

## Skills (mandatory)
<available_skills>
...
</available_skills>

## Memory Recall
...

## Model Aliases
...

## Workspace
Your working directory is: ...

## Documentation
OpenClaw docs: ...

## Sandbox (if enabled)
...

## User Identity
Owner numbers: ...

## Current Date & Time
Time zone: ...

## Workspace Files (injected)
...

## Reply Tags
...

## Messaging
...

## Voice (TTS)
...

# Project Context
## AGENTS.md
...
## SOUL.md
...
## TOOLS.md
...

## Silent Replies
...

## Heartbeats
...

## Runtime
Runtime: agent=default | host=xxx | model=claude-opus-4-5 | channel=telegram | thinking=off
Reasoning: off (hidden unless on/stream)
```

---

## 5. Tool 创建系统

**文件位置**: `src/agents/pi-tools.ts`

### 5.1 工具创建流程

```typescript
createOpenClawCodingTools(options) {
  // 1. 解析 Tool Policy
  const { globalPolicy, agentPolicy, groupPolicy, ... } = resolveEffectiveToolPolicy({
    config, sessionKey, modelProvider, modelId
  });

  // 2. 基础编码工具
  const base = codingTools.flatMap(tool => {
    if (tool.name === "read") return [createOpenClawReadTool(...)];
    if (tool.name === "bash" || tool.name === "exec") return []; // 替换为自定义
    if (tool.name === "write") return [createWriteTool(...)];
    if (tool.name === "edit") return [createEditTool(...)];
    return [tool];
  });

  // 3. 执行工具
  const execTool = createExecTool({ ... });
  const processTool = createProcessTool({ ... });

  // 4. OpenClaw 自定义工具
  const openclawTools = createOpenClawTools({
    browser, canvas, nodes, cron, message, gateway, sessions, ...
  });

  // 5. Channel Agent 工具
  const channelTools = listChannelAgentTools({ cfg });

  // 6. 合并并过滤
  const tools = [...base, execTool, processTool, ...channelTools, ...openclawTools];

  // 7. 应用 Policy 过滤
  const filtered = filterToolsByPolicy(tools, [
    profilePolicy, globalPolicy, agentPolicy, groupPolicy, sandboxPolicy, subagentPolicy
  ]);

  // 8. Hook 包装
  return filtered.map(tool =>
    wrapToolWithAbortSignal(
      wrapToolWithBeforeToolCallHook(tool, { agentId, sessionKey }),
      abortSignal
    )
  );
}
```

### 5.2 Tool Policy 过滤链

```
Profile Policy
    │
    ▼
Global Policy
    │
    ▼
Agent Policy
    │
    ▼
Group Policy
    │
    ▼
Sandbox Policy
    │
    ▼
Subagent Policy
    │
    ▼
Final Tool List
```

---

## 6. Hook 系统

**文件位置**: `src/agents/bootstrap-hooks.ts`

### 6.1 Hook 触发点

```typescript
// Bootstrap Hook - 允许插件修改 Bootstrap 文件
applyBootstrapHookOverrides({
  files,
  workspaceDir,
  config,
  sessionKey,
  sessionId,
  agentId
})
  │
  └── triggerInternalHook(
        createInternalHookEvent("agent", "bootstrap", sessionKey, context)
      )
```

### 6.2 Hook Context

```typescript
interface AgentBootstrapHookContext {
  workspaceDir: string;
  bootstrapFiles: WorkspaceBootstrapFile[];
  cfg?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}
```

---

## 7. 完整调用链路

```
CLI/Gateway 入口
    │
    ▼
runEmbeddedPiAgent()  ← pi-embedded-runner/run.ts
    │
    ├── loadWorkspaceBootstrapFiles(workspaceDir)
    ├── filterBootstrapFilesForSession(files, sessionKey)
    ├── applyBootstrapHookOverrides(files, context)
    │
    ├── resolveSkillsPromptForRun({ skillsSnapshot, entries, config, workspaceDir })
    │
    ├── buildBootstrapContextFiles(files, { maxChars })  ← 转换为 EmbeddedContextFile[]
    │
    └── buildAgentSystemPrompt({
          workspaceDir,
          toolNames,
          skillsPrompt,
          contextFiles,      ← Bootstrap 文件内容
          runtimeInfo,
          sandboxInfo,
          promptMode,        ← "full" | "minimal" | "none"
          ...
        })
            │
            ▼
        System Prompt 字符串
```

---

## 8. 关键设计要点

| 设计点             | 说明                                                  |
| ------------------ | ----------------------------------------------------- |
| **分层架构**       | Bootstrap 文件 → Skills → Runtime → 最终 Prompt       |
| **Subagent 精简**  | 通过 `PromptMode` 控制，subagent 仅获取必要上下文     |
| **文件截断**       | 防止超大 Bootstrap 文件导致 context 溢出              |
| **Hook 扩展**      | 插件可通过 Hook 修改 Bootstrap 文件                   |
| **Tool Policy 链** | Profile → Global → Agent → Group → Sandbox → Subagent |
| **Skills 优先级**  | workspace > managed > bundled > extra (后者覆盖前者)  |

---

## 9. 相关文件索引

```
src/agents/
├── system-prompt.ts              # 核心: buildAgentSystemPrompt
├── system-prompt-params.ts       # 运行时参数
├── system-prompt-report.ts       # 诊断报告
├── bootstrap-files.ts            # Bootstrap 文件解析
├── bootstrap-hooks.ts            # Hook 覆盖
├── workspace.ts                  # 工作空间文件加载
├── skills.ts                     # Skills 系统入口
├── skills/
│   ├── workspace.ts              # Skills 加载和构建
│   ├── config.ts                 # Skills 配置
│   ├── frontmatter.ts            # Frontmatter 解析
│   └── types.ts                  # 类型定义
├── pi-tools.ts                   # 工具创建
├── pi-embedded-runner/
│   ├── system-prompt.ts          # 嵌入式封装
│   └── run/attempt.ts            # 调用系统提示构建
└── pi-embedded-helpers/
    ├── bootstrap.ts              # 上下文文件构建
    └── types.ts                  # EmbeddedContextFile 类型
```
