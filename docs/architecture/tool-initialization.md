# 工具初始化完整技术架构

本文档基于源码分析，梳理 OpenClaw 从工具定义到 LLM 可用的完整初始化流程，提炼可复用的设计模式。

---

## 架构全景

```
┌──────────────────────────────────────────────────────────────┐
│                   Tool Initialization Pipeline                │
│                                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 1. 定义层 │→│ 2. 注册层 │→│ 3. 策略层 │→│ 4. 适配层 │    │
│  │ Define   │  │ Registry │  │ Policy   │  │ Adapter  │    │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │
│       │              │              │              │         │
│   Schema 定义    工具收集       多层过滤      Provider 适配  │
│   Execute 实现   分组索引       权限门控      Schema 标准化  │
│   Result 格式    插件发现       Owner 过滤    Hook 包装      │
│                                              Abort 包装     │
└──────────────────────────────────────────────────────────────┘
```

### 核心文件索引

| 层级   | 文件                                       | 说明                                     |
| ------ | ------------------------------------------ | ---------------------------------------- |
| 定义层 | `src/agents/tools/common.ts`               | 类型、参数读取、结果格式化辅助           |
| 定义层 | `src/agents/schema/typebox.ts`             | Schema helper (stringEnum 等)            |
| 注册层 | `src/agents/pi-tools.ts`                   | 主编排入口 `createOpenClawCodingTools()` |
| 注册层 | `src/agents/openclaw-tools.ts`             | 平台工具工厂 `createOpenClawTools()`     |
| 注册层 | `src/agents/channel-tools.ts`              | Channel 工具发现                         |
| 注册层 | `src/plugins/tools.ts`                     | 插件工具发现                             |
| 策略层 | `src/agents/tool-policy.ts`                | 分组定义、Profile 预设、匹配辅助         |
| 策略层 | `src/agents/pi-tools.policy.ts`            | 策略解析、过滤、subagent deny-list       |
| 策略层 | `src/config/group-policy.ts`               | 群组/频道/per-sender 策略                |
| 适配层 | `src/agents/pi-tools.schema.ts`            | Schema 标准化 (anyOf 展平、type 补全)    |
| 适配层 | `src/agents/schema/clean-for-gemini.ts`    | Gemini Schema 清洗                       |
| 适配层 | `src/agents/pi-tools.before-tool-call.ts`  | 插件 Hook 包装                           |
| 适配层 | `src/agents/pi-tools.abort.ts`             | Abort Signal 包装                        |
| 适配层 | `src/agents/pi-tools.read.ts`              | Claude Code 参数兼容包装                 |
| 适配层 | `src/agents/pi-tool-definition-adapter.ts` | AgentTool → ToolDefinition 转换          |
| 适配层 | `src/agents/pi-embedded-runner/google.ts`  | Google provider 工具清洗                 |

---

## 1. 定义层 (Define)

### 1.1 核心类型

```typescript
// 源自 @mariozechner/pi-agent-core
type AgentTool<P = unknown, D = unknown> = {
  name: string; // 标识符，策略匹配用 (snake_case)
  label?: string; // 人类可读名
  description?: string; // 给 LLM 看的功能说明
  parameters: unknown; // JSON Schema (TypeBox 生成)
  execute: (
    toolCallId: string, // 本次调用 UUID
    params: P, // 经过 schema 校验的参数
    signal?: AbortSignal, // 取消信号
    onUpdate?: (partial: AgentToolResult<D>) => void, // 流式进度
  ) => Promise<AgentToolResult<D>>;
};

type AgentToolResult<D = unknown> = {
  content: Array<
    { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
  >;
  details?: D; // 工具特定元数据
};
```

### 1.2 Schema 定义规范

使用 TypeBox 生成 JSON Schema，但有严格约束以兼容多 provider：

```typescript
import { Type } from "@sinclair/typebox";

const MyToolSchema = Type.Object({
  // 基础类型
  command: Type.String({ description: "Shell command" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
  enabled: Type.Optional(Type.Boolean()),
  tags: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),

  // 枚举：用 stringEnum helper (Type.Unsafe 包装)
  action: stringEnum(["create", "update", "delete"] as const),
  level: optionalStringEnum(["low", "medium", "high"] as const),
});
```

**Schema 约束 (由不同 LLM provider 的限制决定)**:

| 规则                                   | 原因                                   |
| -------------------------------------- | -------------------------------------- |
| 禁止 `Type.Union`                      | 编译为 `anyOf`，Google provider 拒绝   |
| 用 `stringEnum` 代替                   | `Type.Unsafe` 包装，输出为 `enum` 数组 |
| 禁止 `format`/`pattern`/`minLength` 等 | Gemini 会 strip 掉                     |
| 顶层必须 `Type.Object`                 | OpenAI 拒绝非 object 顶层 schema       |
| 避免嵌套 `anyOf`/`oneOf`               | 多 provider 兼容问题                   |

### 1.3 参数读取辅助

`src/agents/tools/common.ts` 提供安全的参数提取：

```typescript
readStringParam(params, "key", { required: true }); // string, 自动 trim
readStringParam(params, "key"); // string | undefined
readNumberParam(params, "count", { integer: true }); // 截断为整数
readStringArrayParam(params, "tags"); // string[] | undefined
readStringOrNumberParam(params, "id", { required: true }); // string | number
```

### 1.4 结果格式化辅助

```typescript
// JSON 对象结果 (最常用)
return jsonResult({ success: true, data: result });

// 图片结果
return imageResult({ label: "screenshot", path, base64, mimeType: "image/png" });

// 从文件读取图片
return imageResultFromFile({ label: "diagram", path: absolutePath });

// 复合结果 (文本 + 图片)
return {
  content: [
    { type: "text", text: "Here's the result:" },
    { type: "image", data: base64, mimeType: "image/png" },
  ],
  details: { exitCode: 0, durationMs: 1234 },
};
```

### 1.5 工具工厂模式

每个工具通过工厂函数创建，闭包捕获运行时上下文：

```typescript
export function createMyTool(options?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  // null = 条件不满足时不创建

  if (!isFeatureEnabled(options?.config)) return null;

  return {
    name: "my_tool",
    label: "My Tool",
    description: "...",
    parameters: MyToolSchema,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const result = await doWork(params, options?.config);
      return jsonResult(result);
    },
  };
}
```

---

## 2. 注册层 (Registry)

### 2.1 四大工具来源

```
createOpenClawCodingTools()
  |
  |-- 1. 编码工具 (pi-coding-agent SDK)
  |   read, write, edit, image
  |   经过 Claude Code 参数兼容包装 (file_path -> path 等)
  |
  |-- 2. 运行时工具 (OpenClaw 自建)
  |   exec   - 命令执行 (审批/PTY/沙箱/背景执行)
  |   process - 进程管理 (list/poll/kill/stdin)
  |   apply_patch - OpenAI 模型专用
  |
  |-- 3. Channel 工具 (消息通道提供)
  |   listChannelAgentTools() 遍历所有注册的 channel plugin
  |   如 whatsapp_login, slack_*, discord_* 等
  |
  |-- 4. 平台工具 + 插件工具
      createOpenClawTools() 创建:
        message, sessions_*, memory_*, web_*,
        browser, canvas, cron, gateway, nodes
      resolvePluginTools() 发现扩展插件工具:
        遍历 openclaw.plugin.json 声明的工具
        WeakMap 追踪 pluginId 归属
```

### 2.2 工具分组索引

`src/agents/tool-policy.ts` 定义语义分组，避免配置中逐个列举：

```typescript
const TOOL_GROUPS = {
  "group:fs": ["read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process"],
  "group:memory": ["memory_search", "memory_get"],
  "group:web": ["web_search", "web_fetch"],
  "group:sessions": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
  ],
  "group:messaging": ["message"],
  "group:ui": ["browser", "canvas"],
  "group:automation": ["cron", "gateway"],
  "group:nodes": ["nodes"],
  "group:openclaw": [
    /* 所有原生工具 */
  ],
};
```

运行时还构建动态插件分组：

```typescript
type PluginToolGroups = {
  all: string[]; // 所有插件工具名
  byPlugin: Map<string, string[]>; // pluginId -> 工具名列表
};

// 配置中引用方式:
// tools.allow: ["msteams"]          -> 允许 msteams 插件的所有工具
// tools.allow: ["group:plugins"]    -> 允许所有插件工具
```

### 2.3 插件工具安全兜底

如果 allowlist 只包含插件工具名 (没有核心工具)，所有核心工具会被意外禁用。
`stripPluginOnlyAllowlist` 检测此情况并自动移除 allowlist，回退为全放行：

```typescript
if (!hasCoreEntry) {
  // allowlist 只有 plugin 条目 -> strip 掉，防止误禁核心工具
  return { ...policy, allow: undefined };
}
// 日志: "Use tools.alsoAllow for additive plugin tool enablement."
```

---

## 3. 策略层 (Policy)

### 3.1 策略数据结构

```typescript
type ToolPolicy = {
  allow?: string[]; // 白名单 (精确名/分组名/通配符)
  deny?: string[]; // 黑名单 (优先级高于 allow)
};
```

### 3.2 单策略匹配算法

`src/agents/pi-tools.policy.ts` — `makeToolPolicyMatcher()`:

```
输入: 工具名 + { allow[], deny[] }

  deny 命中? --- YES --> 拒绝
       |
      NO
       |
  allow 为空? -- YES --> 放行 (无白名单 = 不限制)
       |
      NO
       |
  allow 命中? -- YES --> 放行
       |
      NO
       |
  ----------------------> 拒绝 (有白名单但未命中)
```

匹配模式编译 (`compilePattern`):

| 模式           | 示例           | 匹配                                     |
| -------------- | -------------- | ---------------------------------------- |
| `*` (wildcard) | `"*"`          | 匹配一切                                 |
| 精确匹配       | `"exec"`       | 只匹配 `exec`                            |
| 通配符正则     | `"sessions_*"` | 匹配 `sessions_list`, `sessions_send` 等 |

匹配前先展开分组：`"group:fs"` -> `["read", "write", "edit", "apply_patch"]`

### 3.3 多层 AND 过滤链

核心设计：每层都是限制，工具必须通过**全部层**才保留。

```
全部工具
  |
  v  1. Profile Policy        <-- tools.profile: "minimal"|"coding"|"messaging"|"full"
  v  2. Provider Profile      <-- tools.byProvider.{provider}.profile
  v  3. Global Policy         <-- tools.allow / tools.deny
  v  4. Global Provider       <-- tools.byProvider.{provider}.allow / deny
  v  5. Agent Policy          <-- agents.{id}.tools.allow / deny
  v  6. Agent Provider        <-- agents.{id}.tools.byProvider.{provider}.allow / deny
  v  7. Group Policy          <-- channels.{ch}.groups.{id}.tools / toolsBySender
  v  8. Sandbox Policy        <-- sandbox 容器配置
  v  9. Subagent Policy       <-- 硬编码 deny list
  |
  v 最终可用工具
```

源码实现 (`pi-tools.ts:409-435`) 是直线串行过滤：

```typescript
const a = filterToolsByPolicy(allTools, profilePolicy);
const b = filterToolsByPolicy(a, providerProfilePolicy);
const c = filterToolsByPolicy(b, globalPolicy);
const d = filterToolsByPolicy(c, globalProviderPolicy);
const e = filterToolsByPolicy(d, agentPolicy);
const f = filterToolsByPolicy(e, agentProviderPolicy);
const g = filterToolsByPolicy(f, groupPolicy);
const h = filterToolsByPolicy(g, sandboxPolicy);
const i = filterToolsByPolicy(h, subagentPolicy);
```

### 3.4 各层策略配置来源

#### Profile 预设 (4 档)

```typescript
minimal: {
  allow: ["session_status"];
}
coding: {
  allow: ["group:fs", "group:runtime", "group:sessions", "group:memory", "image"];
}
messaging: {
  allow: ["group:messaging", "sessions_list", "sessions_send", "session_status"];
}
full: {
} // allow 为空 = 不限制
```

#### Provider 策略 (按 model provider 差异化)

```yaml
tools:
  byProvider:
    openai: # 宽泛 provider 级
      deny: ["browser"]
    "anthropic/claude-opus-4": # 精确 provider/model 级 (优先)
      allow: ["*"]
```

解析优先级：`provider/model` 精确匹配 -> `provider` 宽泛匹配

#### Agent 策略 (per-agent 隔离)

```yaml
agents:
  support-bot:
    tools:
      profile: "messaging"
      allow: ["group:messaging", "group:web"]
      deny: ["exec"]
```

#### Group 策略 (群组/频道级 + per-sender)

```yaml
channels:
  telegram:
    groups:
      "-100123456": # 特定群组
        tools: { allow: ["group:fs"] }
        toolsBySender:
          "admin_user": # 管理员
            allow: ["*"]
          "*": # 其他人
            deny: ["exec"]
      "*": # 默认策略
        tools: { deny: ["gateway"] }
```

发送者匹配优先级：`senderId -> senderE164 -> senderUsername -> senderName -> "*"`

#### Subagent 策略 (硬编码 deny-list)

```typescript
const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn", // 主代理编排
  "gateway",
  "agents_list", // 系统管理
  "whatsapp_login", // 交互式设置
  "session_status",
  "cron", // 主代理协调
  "memory_search",
  "memory_get", // 通过 prompt 传递
];
```

通过 `isSubagentSessionKey()` 检测 session key 中的 `subagent` 段自动触发。

### 3.5 alsoAllow 增量授权

`profile: "coding"` 想额外加 `web_search`，不想切到 `full`:

```yaml
tools:
  profile: "coding"
  alsoAllow: ["web_search", "web_fetch"]
```

实现：将 `alsoAllow` 合并到 profile 的 allow 列表中。

### 3.6 Owner-Only 门控

某些工具只对 owner 可用，对非 owner **完全不可见** (从工具列表移除):

```typescript
const OWNER_ONLY_TOOL_NAMES = new Set(["whatsapp_login"]);
// 非 owner -> filter 掉 (LLM 完全看不到)
```

---

## 4. 适配层 (Adapter)

工具通过策略过滤后，进入最后的适配/包装阶段。

### 4.1 Schema 标准化

`src/agents/pi-tools.schema.ts` — `normalizeToolParameters()`:

```
原始 TypeBox Schema
  |
  |-- 有 anyOf/oneOf? --> 合并所有 variant 的 properties
  |                       重新计算 required (必须所有 variant 都要求才保留)
  |                       展平为单个 type: "object"
  |
  |-- 缺少 type? -------> 推断并添加 type: "object"
  |
  |-- Google provider? --> cleanForGemini()
                           strip: $ref, format, pattern, minLength, maxLength,
                                  examples, patternProperties, additionalProperties
                           convert: const -> enum, null unions -> strip null
```

### 4.2 Before-Tool-Call Hook 包装

`src/agents/pi-tools.before-tool-call.ts` — 每个工具的 `execute` 被包装一层拦截逻辑：

```
调用工具
  |
  |-- 运行 before_tool_call 插件 hook
  |   |
  |   |-- hook 返回 { block: true, reason } -> 抛出错误，工具不执行
  |   |-- hook 返回 { params: {...} }       -> 修改参数后继续执行
  |   |-- hook 返回空                        -> 正常执行
  |
  |-- 调用原始 tool.execute(toolCallId, params, signal, onUpdate)
```

### 4.3 Abort Signal 包装

`src/agents/pi-tools.abort.ts` — 将外部取消信号与工具自身的 signal 合并：

```typescript
const combined = AbortSignal.any
  ? AbortSignal.any([externalSignal, toolSignal]) // 现代 API
  : manualCombine(externalSignal, toolSignal); // 兼容实现
// 任一 signal abort -> 工具执行被中止
```

### 4.4 Claude Code 参数兼容

`src/agents/pi-tools.read.ts` — 解决不同 model 训练时参数命名差异：

```
Schema 阶段:
  原始 Schema { path: string }
    -> 添加 { file_path: string }  (alias)
    -> 从 required 中移除 path

Execute 阶段:
  收到 { file_path: "/foo" }
    -> 转换为 { path: "/foo" }
    -> 传给原始工具
```

同理：`old_string -> oldText`, `new_string -> newText`

### 4.5 Tool Definition Adapter

`src/agents/pi-tool-definition-adapter.ts` — 最后一步，转为 PI SDK / LLM provider 可用格式：

```typescript
function toToolDefinitions(tools: AnyAgentTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label ?? tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    execute: async (args) => {
      try {
        return await tool.execute(args.toolCallId, args.params, args.signal, args.onUpdate);
      } catch (err) {
        if (err instanceof AbortError) throw err; // 不吞掉 abort
        return jsonResult({ error: err.message }); // 其他错误包装返回
      }
    },
  }));
}
```

---

## 5. 完整初始化时序

```
createOpenClawCodingTools(runtimeContext)
  |
  |  +------------ 1. 策略解析 ----------------+
  |-- resolveEffectiveToolPolicy()              | 从 config 解析
  |   -> { profile, globalPolicy,               | profile/global/agent/provider
  |        agentPolicy, providerPolicy }        | 各层策略
  |-- resolveGroupToolPolicy()                  | 从 session key 解析
  |   -> groupPolicy                            | channel/group/sender 策略
  |-- resolveSubagentToolPolicy()               | 从 session key 判断
  |   -> subagentPolicy (如果是子代理)           | 是否子代理
  |  +------------------------------------------+
  |
  |  +------------ 2. 工具创建 ----------------+
  |-- codingTools (SDK 原生)                    | read/write/edit/image
  |   -> 包装 Claude Code 参数兼容              |
  |   -> 包装沙箱路径保护 (如需)                |
  |-- createExecTool(defaults)                  | 命令执行
  |-- createProcessTool(defaults)               | 进程管理
  |-- listChannelAgentTools()                   | 通道工具
  |-- createOpenClawTools()                     | 平台工具
  |   -> resolvePluginTools()                   | 插件工具
  |  +------------------------------------------+
  |
  |  +------------ 3. 授权门控 ----------------+
  |-- applyOwnerOnlyToolPolicy()                | 非 owner -> 移除敏感工具
  |  +------------------------------------------+
  |
  |  +------------ 4. 分组构建 ----------------+
  |-- buildPluginToolGroups()                   | 构建 pluginId -> 工具名索引
  |-- stripPluginOnlyAllowlist()                | 防止 plugin-only allow 误禁核心
  |-- expandPolicyWithPluginGroups()            | 展开 group:plugins / pluginId
  |  +------------------------------------------+
  |
  |  +------------ 5. 串行过滤 ----------------+
  |-- filterToolsByPolicy(profile)              |
  |-- filterToolsByPolicy(providerProfile)      |  9 层 AND 过滤
  |-- filterToolsByPolicy(global)               |  每层: deny 优先 -> allow 匹配
  |-- filterToolsByPolicy(globalProvider)       |
  |-- filterToolsByPolicy(agent)                |
  |-- filterToolsByPolicy(agentProvider)        |
  |-- filterToolsByPolicy(group)                |
  |-- filterToolsByPolicy(sandbox)              |
  |-- filterToolsByPolicy(subagent)             |
  |  +------------------------------------------+
  |
  |  +------------ 6. 适配包装 ----------------+
  |-- normalizeToolParameters()                 | Schema 标准化 (OpenAI/Gemini)
  |-- wrapToolWithBeforeToolCallHook()          | 插件 hook 拦截
  |-- wrapToolWithAbortSignal()                 | 取消信号组合
  |  +------------------------------------------+
  |
  v
最终工具列表 -> createAgentSession() -> LLM 只能看到这些工具
```

---

## 6. 策略层解决的问题

| 场景                     | 风险                            | 策略需求                                    |
| ------------------------ | ------------------------------- | ------------------------------------------- |
| 用户在 Discord 群里 @bot | 群里任何人都能触发              | 不暴露 `exec`/`gateway` 等危险工具          |
| 子代理执行子任务         | 子代理不应绕过主代理            | 禁止 `sessions_send`/`memory_search`/`cron` |
| 沙箱容器内执行           | 容器内应隔离                    | 只允许沙箱内文件操作                        |
| 使用特定 model provider  | 某些 provider 不支持特定 schema | 按 provider 过滤不兼容工具                  |
| 特定群组/频道            | 不同群有不同用途                | 运维群给 `exec`，客服群只给 `message`       |
| 特定发送者               | 不同人不同权限                  | Owner 给全部工具，普通用户限制              |

---

## 7. 可复用设计模式

| 模式                | 解决的问题                  | 关键点                                                  |
| ------------------- | --------------------------- | ------------------------------------------------------- |
| 工厂函数 + 闭包     | 工具需要运行时上下文        | 返回 `AnyAgentTool \| null`，null 表示条件不满足        |
| TypeBox Schema      | 类型安全的 JSON Schema 生成 | 用 `stringEnum` 不用 `Type.Union`                       |
| 参数读取辅助        | 防御性参数提取              | `readStringParam` 等统一 trim/类型转换/required         |
| 结果格式化辅助      | 统一工具返回格式            | `jsonResult`/`imageResult` 确保 content block 正确      |
| 语义分组            | 避免配置逐个列举            | `group:fs` 代替 `["read","write","edit","apply_patch"]` |
| Profile 预设        | 常见场景一键配置            | 4 档覆盖 minimal/coding/messaging/full                  |
| alsoAllow 增量      | 在 profile 基础上追加       | 不用切 profile 就能扩展能力                             |
| 串行 AND 过滤       | 多维度权限组合              | 越往后越窄，低层无法绕过高层                            |
| Deny 优先           | 黑名单不可绕过              | 每层内部 deny 先于 allow 检查                           |
| 通配符编译          | 灵活的匹配规则              | `*` / 精确 / `sessions_*` 三种模式                      |
| Plugin-only 兜底    | 防止插件配置误禁核心        | 检测 allowlist 只含插件 -> 自动 strip                   |
| Owner-Only 不可见   | 敏感工具对非 owner 隐藏     | 直接从列表移除，LLM 无感知                              |
| Subagent 隐式限制   | 子代理自动受限              | session key 含 `subagent` -> 自动加 deny                |
| Per-sender 精细控制 | 同群不同人不同权限          | 多标识符匹配 + wildcard 兜底                            |
| Decorator 包装链    | 横切关注点分离              | hook -> abort -> param normalize -> schema normalize    |
| Schema 标准化       | 多 provider 兼容            | anyOf 展平、Gemini strip、type 补全                     |
| 参数兼容层          | 不同 model 的参数命名差异   | 双 Schema alias + 运行时 param 映射                     |

### 其他项目复用建议

核心可提取的抽象：

```
1. ToolDefinition interface     -- 统一的工具描述格式
2. ToolFactory pattern          -- 工厂 + 闭包注入上下文
3. ToolGroup registry           -- 语义分组索引
4. ToolPolicy { allow, deny }   -- 单层策略数据结构
5. PolicyMatcher                -- deny 优先 + allow 匹配 + 通配符编译
6. PolicyChain                  -- 多层串行 AND 过滤
7. SchemaAdapter                -- per-provider schema 标准化
8. ToolWrapper decorators       -- hook/abort/param 包装链
```

最关键的可复用模块是 **PolicyChain** (多层 AND 过滤) 和 **SchemaAdapter** (多 provider 兼容)。这两个在任何需要「同一套工具适配多种 LLM + 多种权限场景」的项目中都会遇到。
