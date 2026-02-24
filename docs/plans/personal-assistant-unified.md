# Jarvis — 个人助理系统落地方案 (v1.0)

> 部署：Mac Mini (Apple Silicon)，24/7 launchd daemon
> 用户：1 人
> 渠道：DingTalk DM（文字推送）+ Voice Call（用户主动拨入）
> 语音模式：Pull（你打给 Jarvis）

---

## 一、使用场景定义

### 场景 A：晨间健康 + 资讯播报（每日核心）

**触发**：`morning-brief` cron 06:30 生成简报 → DingTalk DM 通知"已就绪" → 你起床后 Siri 拨入

**完整交互流程**：

```
[06:30 Cron 自动]
  Coordinator → 并行 spawn:
    Health-Analyst: node.invoke health.query (HRV/心率/睡眠) → 分析 → 训练决策
    Scout: browser 抓 Twitter AI+投资账号 → 评分/去重 → 返回摘要
  → Coordinator 汇总 → 缓存到 session → DingTalk DM "晨间简报已就绪"

[07:xx 你拨入]
  Jarvis: "早上好。昨晚睡眠 7.2 小时，HRV 58，静息心率 52，状态良好。
           按计划今天是间歇跑日，建议标准强度，6 组 2 分钟快跑，心率 155-160。"
  你: "心率上限 158"
  Jarvis: "好的。需要创建训练日程吗？"
  你: "创建，下午 5 点"
  Jarvis: "已在钉钉创建日程 17:00 间歇跑，16:45 提醒。接下来播报资讯..."
  你: "展开第一条" / "记到 Obsidian" / "跳过" / ...
```

### 场景 B：通勤语音（上下班开车）

**触发**：你 Siri 拨入 Twilio 号码

```
你: "有什么重要消息？"
Jarvis: 播报高优资讯 + 支持打断
你: "这个记到 Obsidian，标签 AI-agent"
Jarvis: "已保存。继续第二条？"
你: "记一下训练数据，间歇跑完成 6 组，最高心率 162"
Jarvis: "已记录。平均心率偏高，建议明天降级慢跑。要调整吗？"
你: "调整"
Jarvis: "明日计划更新为慢跑 30 分钟，钉钉日程已更新。"
```

### 场景 C：实时监控 + 推送

**触发**：`news-monitor` cron 每 30 分钟扫描

```
Scout 发现：美联储降息 → 评分 5 → Coordinator → DingTalk DM 即时推送
  "[紧急] 美联储意外降息 50bp
   利好科技股，纳指期货涨 1.2%。
   回复'详细'查看分析 | 回复'忽略'降低此类权重"
```

### 场景 D：每日自动整理

**触发**：cron 定时

```
12:00 午间精选 → DingTalk DM (资讯摘要 + OmniFocus 待办提醒)
18:00 晚间总结 → DingTalk DM (全天汇总 + 训练情况 + 明日预览 + 睡眠建议)
```

### 场景 E：周回顾

**触发**：周六 14:00 cron 准备初稿

```
DingTalk DM: "周回顾初稿已备好（资讯 18 条沉淀、VO₂max +0.5、任务完成 80%）。
              你方便时回复'开始'，或告诉我一个时间。"
你: "明天上午 10 点"
→ 创建钉钉日程，周日 10:00 拨入语音逐项过回顾
```

---

## 二、系统架构

```
         iPhone/Watch                       你 (手机/电脑)
              │                                  │
         OpenClaw iOS                    ┌───────┼───────┐
         (Apple Health                   │       │       │
          auto-sync)                 DingTalk  Voice   Obsidian
              │                       DM     (Twilio)  (Mac本地)
              │ node.invoke /                  │
              │ node.event                     │
              └──────────┬─────────────────────┘
                         ↓
┌─── Mac Mini (launchd daemon) ──────────────────────────────────┐
│                                                                 │
│  OpenClaw Gateway (:18789)                                      │
│  ├─ Channels: DingTalk                                          │
│  ├─ Plugins: voice-call (Twilio inbound)                        │
│  ├─ Cron Service                                                │
│  ├─ Tailscale Funnel (Twilio webhook)                           │
│  ├─ Node: iOS client (health data)                              │
│  │                                                              │
│  ├─ Agents ────────────────────────────────────────────────┐    │
│  │  coordinator (sonnet, default)                          │    │
│  │    ├─ spawn scout (haiku)      — Twitter 抓取/评分      │    │
│  │    ├─ spawn health-analyst (sonnet) — 健康分析/训练决策  │    │
│  │    └─ spawn librarian (haiku)  — Obsidian 写入          │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                 │
│  Skills: obsidian, apple-reminders                              │
│  Tools: browser (Playwright), web_fetch, web_search, nodes,     │
│         cron, tts, bash (JXA for OmniFocus)                     │
│                                                                 │
│  Storage ───────────────────────────────────────────────────    │
│  ~/.openclaw/          config, sessions, cron, delivery-queue   │
│  ~/jarvis/             agent workspace                          │
│  ~/ObsidianVault/      知识沉淀 (Obsidian vault, 路径待确认)     │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、OpenClaw 配置（`openclaw.json`）

### 3.1 Agent 配置

```jsonc
{
  "agents": {
    "defaults": {
      "workspace": "~/jarvis",
      "subagents": {
        "maxSpawnDepth": 2,
        "maxChildrenPerAgent": 6,
      },
    },
    "list": [
      {
        "id": "coordinator",
        "default": true,
        "name": "Jarvis",
        "workspace": "~/jarvis/coordinator",
        "model": {
          "primary": "anthropic/claude-sonnet-4",
          "fallbacks": ["anthropic/claude-haiku-4-5"],
        },
        "identity": {
          "name": "Jarvis",
          "emoji": "🤖",
        },
        "subagents": {
          "allowAgents": ["scout", "health-analyst", "librarian"],
        },
        "skills": ["obsidian"],
        "tools": {
          "profile": "full",
        },
      },
      {
        "id": "scout",
        "name": "Scout",
        "workspace": "~/jarvis/news",
        "model": "anthropic/claude-haiku-4-5",
        "identity": { "name": "Scout", "emoji": "🔍" },
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["browser", "web_fetch", "web_search"],
        },
      },
      {
        "id": "health-analyst",
        "name": "Health Analyst",
        "workspace": "~/jarvis/health",
        "model": "anthropic/claude-sonnet-4",
        "identity": { "name": "Health Analyst", "emoji": "💪" },
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["nodes"],
        },
      },
      {
        "id": "librarian",
        "name": "Librarian",
        "workspace": "~/jarvis",
        "model": "anthropic/claude-haiku-4-5",
        "identity": { "name": "Librarian", "emoji": "📚" },
        "skills": ["obsidian"],
        "tools": {
          "profile": "minimal",
          "alsoAllow": ["bash"], // obsidian-cli + 文件写入
        },
      },
    ],
  },
}
```

### 3.2 DingTalk 渠道配置

```jsonc
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "${DINGTALK_CLIENT_ID}",
      "clientSecret": "${DINGTALK_CLIENT_SECRET}",
      "dmPolicy": "allowlist",
      "allowFrom": ["你的钉钉 staffId"],
      "groupPolicy": "disabled",
    },
  },
}
```

### 3.3 Voice-Call 插件配置

```jsonc
{
  "plugins": {
    "entries": {
      "voice-call": {
        "enabled": true,
        "provider": "twilio",
        "twilio": {
          "accountSid": "${TWILIO_ACCOUNT_SID}",
          "authToken": "${TWILIO_AUTH_TOKEN}",
        },
        "fromNumber": "+1xxxxxxxxxx",
        "inboundPolicy": "allowlist",
        "allowFrom": ["+86xxxxxxxxxxx"], // 你的手机号
        "inboundGreeting": "", // 由 agent 动态生成 greeting
        "outbound": { "defaultMode": "conversation" },
        "maxDurationSeconds": 600,
        "maxConcurrentCalls": 1,
        "silenceTimeoutMs": 1000,
        "transcriptTimeoutMs": 300000,
        "serve": {
          "port": 3334,
          "bind": "127.0.0.1",
          "path": "/voice/webhook",
        },
        "tunnel": {
          "provider": "tailscale-funnel",
        },
        "streaming": {
          "enabled": true,
          "sttProvider": "openai-realtime",
          "sttModel": "gpt-4o-transcribe",
          "silenceDurationMs": 800,
          "vadThreshold": 0.5,
        },
        "responseModel": "anthropic/claude-sonnet-4",
        "responseSystemPrompt": "", // 见 3.5 语音 system prompt
      },
    },
  },
}
```

### 3.4 TTS 配置

```jsonc
{
  "tts": {
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-tts",
      "voice": "marin",
    },
    "maxTextLength": 3000,
  },
}
```

### 3.5 Agent Identity Prompt（Coordinator）

文件：`~/jarvis/coordinator/BOOTSTRAP.md`

```markdown
# Jarvis — 个人助理

你是 Jarvis，一位高效、简洁的个人助理。服务于一位软件工程师。

## 核心职责

1. **资讯管理**：通过 Scout 抓取 Twitter AI/投资资讯，评分过滤，按重要度推送
2. **健康管理**：通过 Health-Analyst 分析 Apple Health 数据，做训练决策
3. **知识沉淀**：通过 Librarian 将有价值内容保存到 Obsidian
4. **任务协调**：整合 OmniFocus 待办，生成提醒

## 投递规则

- 重要度 5：DingTalk DM 即时推送
- 重要度 4：DingTalk DM 即时推送
- 重要度 3：汇入午间精选或晚间摘要
- 重要度 1-2：仅沉淀 Obsidian
- 深夜 (22:00-8:00)：全部静默，汇入晨间简报

## 语音交互原则（通过 Voice Call 拨入时）

1. 中文为主，技术术语保留英文（HRV、VO₂max、GPT-5）
2. 健康播报：先结论再数据（"状态良好" → "HRV 58, 心率 52"）
3. 资讯播报：每条 2-3 句，约 15 秒
4. 播报结构："第 N 条，[领域]，[标题]。[摘要]。"
5. 被打断后简短确认，不重复已说内容
6. 操作确认一句话，不展开解释

## 可执行操作

- "记到 Obsidian" → spawn Librarian，写入 Obsidian vault
- "创建日程 X 点" → 钉钉 MCP 创建日程 + 提醒
- "记录训练数据" → Health-Analyst 更新 health/history/
- "调整训练计划" → Health-Analyst 修改 training-plan.md + 更新钉钉日程
- "加到任务" → bash osascript OmniFocus JXA 创建任务

## 上下文文件

- ~/jarvis/coordinator/current-focus.md — 当前阶段目标
- ~/jarvis/coordinator/weekly-goals.md — 本周目标
- ~/jarvis/health/training-plan.md — 当前训练计划
- ~/jarvis/news/scoring-rules.md — 资讯评分规则
```

### 3.6 Scout Identity Prompt

文件：`~/jarvis/news/BOOTSTRAP.md`

````markdown
# Scout — 资讯抓取 Agent

你是资讯抓取专家。任务是从指定来源获取最新信息并结构化返回。

## 工作流程

1. 读取 ~/jarvis/news/sources.md 获取 Twitter 账号列表
2. 使用 browser 工具逐个访问 Twitter 账号页面
3. 提取最近 24h 内的推文（标题、链接、摘要）
4. 读取 ~/jarvis/news/cache/seen-ids.json 去重
5. 按 ~/jarvis/news/scoring-rules.md 评分（1-5）
6. 分类打标：AI / 投资 / 开源 / 行业
7. 更新 seen-ids.json
8. 返回结构化结果（JSON 格式）

## 输出格式

```json
{
  "items": [
    {
      "id": "tweet_xxx",
      "source": "@karpathy",
      "title": "...",
      "summary": "...",
      "url": "https://x.com/...",
      "category": "AI",
      "importance": 4,
      "tags": ["LLM", "training"]
    }
  ],
  "stats": { "fetched": 20, "new": 8, "filtered": 4 }
}
```
````

## 注意

- 不要评论或分析，只抓取和评分
- 评分严格按 scoring-rules.md，不要主观加分
- 抓取失败时记录错误但不中断其他源

````

### 3.7 Health-Analyst Identity Prompt

文件：`~/jarvis/health/BOOTSTRAP.md`

```markdown
# Health Analyst — 健康数据分析 Agent

你是运动科学专家。基于 Apple Health 数据和训练计划，做每日训练决策。

## 数据获取
通过 nodes 工具调用 iOS 设备：
- `node.invoke health.query { type: "heartRate", limit: 100 }` — 心率数据
- `node.invoke health.query { type: "sleepAnalysis" }` — 睡眠数据
- `node.invoke health.summary { type: "heartRate", interval: "day" }` — 心率统计
- `node.invoke health.query { type: "heartRateVariabilitySDNN" }` — HRV
- `node.invoke health.query { type: "vo2Max" }` — VO₂max
- `node.invoke health.query { type: "restingHeartRate" }` — 静息心率

## 决策规则
读取 ~/jarvis/health/decision-rules.md，核心逻辑：
- HRV < 基线 80% 或 静息心率 > 基线 +5 → 建议休息或降级
- 睡眠 < 6h 或深睡 < 1h → 降级训练强度
- 连续 3 天高强度 → 强制恢复日
- 一切正常 → 按 training-plan.md 执行

## 输出格式
```json
{
  "date": "2026-02-23",
  "metrics": {
    "sleep": { "total": 7.2, "deep": 1.5, "rem": 1.8 },
    "hrv": 58, "restingHR": 52, "vo2max": 46.8
  },
  "decision": "execute",  // execute | downgrade | rest
  "todayPlan": {
    "type": "interval_run",
    "duration": 35,
    "details": "2 分钟快跑 × 6 组，心率 155-160",
    "hrMax": 160
  },
  "sleepAdvice": "基于今日训练强度，建议 22:30 前上床"
}
````

## 训练数据记录

当用户通过语音报告训练完成情况时：

1. 将数据写入 ~/jarvis/health/history/YYYY-MM-DD.json
2. 评估实际 vs 计划的偏差
3. 如需调整明日计划，更新 training-plan.md

````

---

## 四、Cron 任务配置

通过 `openclaw cron add` CLI 或 config 配置：

### 4.1 晨间简报

```jsonc
{
  "name": "morning-brief",
  "schedule": { "kind": "cron", "expr": "30 6 * * *", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "执行晨间简报流程：\n1. spawn health-analyst 分析最新健康数据，生成今日训练方案\n2. spawn scout 抓取过夜资讯（Twitter AI + 投资）\n3. 汇总健康分析 + 资讯摘要为晨间简报\n4. 将简报缓存到 ~/jarvis/briefings/morning-today.md\n5. 通过 DingTalk DM 通知用户'晨间简报已就绪'\n\n注意：不要主动打电话，等用户拨入后播报。",
    "deliver": true,
    "channel": "dingtalk"
  },
  "delivery": { "mode": "announce", "channel": "dingtalk" },
  "enabled": true
}
````

### 4.2 资讯监控

```jsonc
{
  "name": "news-monitor",
  "schedule": { "kind": "cron", "expr": "*/30 8-22 * * *", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "执行资讯监控：\n1. spawn scout 抓取 Twitter 最新内容\n2. 对比已有缓存去重\n3. 评分，重要度 >= 4 的立即推送 DingTalk DM\n4. 重要度 3 的暂存等待汇总\n5. 重要度 <= 2 的仅标记沉淀\n6. 有值得沉淀的内容 spawn librarian 保存到 Obsidian",
  },
  "delivery": { "mode": "none" }, // Coordinator 自行决定投递
  "enabled": true,
}
```

### 4.3 午间精选

```jsonc
{
  "name": "midday-digest",
  "schedule": { "kind": "cron", "expr": "0 12 * * 1-5", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "生成午间精选：\n1. 汇总上午积累的重要度 3 的资讯\n2. 读取 OmniFocus 今日待办（osascript JXA）\n3. 组合为午间精选推送到 DingTalk DM\n格式：资讯摘要(3-5条) + 下午待办提醒",
    "deliver": true,
    "channel": "dingtalk",
  },
  "delivery": { "mode": "announce", "channel": "dingtalk" },
  "enabled": true,
}
```

### 4.4 晚间总结

```jsonc
{
  "name": "evening-summary",
  "schedule": { "kind": "cron", "expr": "0 18 * * *", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "生成晚间总结：\n1. 汇总全天资讯（按分类）\n2. 今日 Obsidian 沉淀条目\n3. 训练完成情况（如有记录）\n4. 明日待办预览\n5. 睡眠建议（基于今日训练强度）\n推送到 DingTalk DM",
    "deliver": true,
    "channel": "dingtalk",
  },
  "delivery": { "mode": "announce", "channel": "dingtalk" },
  "enabled": true,
}
```

### 4.5 周回顾准备

```jsonc
{
  "name": "weekly-prep",
  "schedule": { "kind": "cron", "expr": "0 14 * * 6", "tz": "Asia/Shanghai" },
  "sessionTarget": "isolated",
  "wakeMode": "now",
  "payload": {
    "kind": "agentTurn",
    "message": "准备周回顾初稿：\n1. 本周资讯沉淀总结（数量、分类、关键条目）\n2. 训练数据周报（VO₂max变化、心率趋势、睡眠统计）\n3. OmniFocus 任务完成率\n4. Obsidian 新增笔记统计\n5. 写入 ~/jarvis/briefings/weekly-draft.md\n6. DingTalk DM 通知用户初稿已备好，询问方便的回顾时间",
    "deliver": true,
    "channel": "dingtalk",
  },
  "delivery": { "mode": "announce", "channel": "dingtalk" },
  "enabled": true,
}
```

---

## 五、工作区文件结构

```
~/jarvis/
├── coordinator/
│   ├── BOOTSTRAP.md                # Coordinator identity prompt
│   ├── current-focus.md            # 当前阶段目标
│   └── weekly-goals.md             # 本周目标
│
├── health/
│   ├── BOOTSTRAP.md                # Health-Analyst identity prompt
│   ├── training-plan.md            # 当前训练计划（手动维护 + agent 微调）
│   ├── decision-rules.md           # 训练决策规则（HRV 阈值等）
│   ├── history/                    # 每日健康+训练数据
│   │   ├── 2026-02-23.json
│   │   └── ...
│   └── weekly-summary/             # 周训练总结
│       └── 2026-w08.md
│
├── news/
│   ├── BOOTSTRAP.md                # Scout identity prompt
│   ├── sources.md                  # Twitter 账号列表（分 AI/投资两组）
│   ├── scoring-rules.md            # 评分规则
│   └── cache/
│       └── seen-ids.json           # 去重缓存
│
├── briefings/                      # 简报缓存（被语音播报消费）
│   ├── morning-today.md
│   └── weekly-draft.md
│
└── MEMORY.md                       # 用户偏好/持仓/关注领域

~/ObsidianVault/                    # Obsidian 知识库（路径待确认）
├── AI/                             # Librarian 按分类写入
├── Investment/
├── Tech/
└── Daily/
    └── 2026-02-23.md               # 每日沉淀汇总
```

---

## 六、需要开发的组件

### 6.1 DingTalk 主动推送（关键缺口）

**现状**：`extensions/dingtalk/src/channel.ts` 的 `outbound.sendText` 直接跳过，因为 AI Assistant 模式需要 `conversationToken`。

**解决方案**：使用 `prepareCard()` API 实现主动推送。

**改动文件**：`extensions/dingtalk/src/channel.ts`、`extensions/dingtalk/src/send.ts`

**实现思路**：

```typescript
// channel.ts outbound.sendText 改造
sendText: async ({ text, to, account }) => {
  // to 格式: "unionId:xxx" 或 "openConversationId:xxx"
  const [kind, id] = to.split(":");
  const token = await prepareCard({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
    card: { templateId: account.cardTemplateId, cardData: {}, options: {} },
    ...(kind === "unionId" ? { unionId: id } : { openConversationId: id }),
  });
  if (!token) throw new Error("prepareCard failed");
  // 用 updateCard 发送内容 + finishCard
  await updateCard({ ..., card: { ..., cardData: { key: "result", value: text, isFinalize: true } } });
  await finishCard({ ..., conversationToken: token });
}
```

**前置条件**：获取用户的 DingTalk `unionId`（从 inbound message 的 `senderId` 映射）。

### 6.2 Apple Health 数据类型扩展

**现状**：MVP 仅支持 `stepCount`、`heartRate`、`sleepAnalysis`。

**缺少的类型（训练场景必需）**：

| 类型                       | HealthKit ID                                | 用途                      |
| -------------------------- | ------------------------------------------- | ------------------------- |
| `heartRateVariabilitySDNN` | `HKQuantityType(.heartRateVariabilitySDNN)` | HRV，训练恢复评估核心指标 |
| `restingHeartRate`         | `HKQuantityType(.restingHeartRate)`         | 静息心率基线              |
| `vo2Max`                   | `HKQuantityType(.vo2Max)`                   | 有氧能力指标              |
| `activeEnergyBurned`       | `HKQuantityType(.activeEnergyBurned)`       | 运动消耗                  |

**改动文件**：

- `apps/shared/OpenClawKit/Sources/OpenClawKit/HealthCommands.swift` — 扩展 `OpenClawHealthDataType` 枚举
- `apps/ios/Sources/Health/HealthService.swift` — 添加 HKUnit 映射和查询逻辑

**改动量**：约 50 行 Swift 代码（每个类型约 10 行：枚举 case + unit mapping + query handler）。

### 6.3 钉钉日程创建

**现状**：无钉钉日程 API 集成。

**方案**：直接在 Coordinator 的 bash tool 中调用钉钉日程 API。

**钉钉日历 API**：

```
POST https://api.dingtalk.com/v1.0/calendar/users/{unionId}/calendars/primary/events
Header: x-acs-dingtalk-access-token: {accessToken}
Body: {
  "summary": "间歇跑 35 分钟",
  "start": { "dateTime": "2026-02-23T17:00:00+08:00", "timeZone": "Asia/Shanghai" },
  "end": { "dateTime": "2026-02-23T17:35:00+08:00", "timeZone": "Asia/Shanghai" },
  "reminders": [{ "method": "dingtalk", "minutes": 15 }]
}
```

**实现方式**：

- 选项 A：写一个轻量 bash 脚本 `~/jarvis/scripts/dingtalk-calendar.sh`，Coordinator 通过 bash tool 调用
- 选项 B：开发钉钉 MCP server（`extensions/dingtalk-mcp/`），提供 `calendar.create`、`calendar.list` 等 tools
- **推荐选项 A 先行**（最快落地），后续迭代为选项 B

### 6.4 OmniFocus 集成

**方案**：JXA (JavaScript for Automation) 通过 `osascript`

**读取待办**：

```bash
osascript -l JavaScript -e '
  const of = Application("OmniFocus");
  const doc = of.defaultDocument;
  const today = new Date();
  const tasks = doc.flattenedTasks.whose({
    completed: false,
    effectiveDueDate: { _lessThanOrEqual: today }
  })();
  JSON.stringify(tasks.map(t => ({
    name: t.name(), due: t.effectiveDueDate(), project: t.containingProject()?.name()
  })));
'
```

**创建任务**：

```bash
osascript -l JavaScript -e '
  const of = Application("OmniFocus");
  const doc = of.defaultDocument;
  const inbox = doc.inboxTasks;
  const task = of.InboxTask({ name: "训练后拉伸", dueDate: new Date("2026-02-23T18:00") });
  inbox.push(task);
'
```

**实现方式**：Agent 通过 bash tool 执行上述 JXA 脚本。可封装为 `~/jarvis/scripts/omnifocus.sh` 提供 `list`/`create`/`complete` 子命令。

### 6.5 语音拨入时的简报加载

**现状**：Voice-Call 插件处理 inbound call 时使用 `responseModel` + `responseSystemPrompt` 生成回复。

**需要的行为**：拨入时，Agent 应检查是否有缓存的晨间简报（`~/jarvis/briefings/morning-today.md`），如果有，以语音播报模式逐段播报。

**实现方式**：在 Coordinator 的 identity prompt 中加入规则：

```
当检测到语音通话（Voice Call channel）且 briefings/morning-today.md 存在且未播报：
→ 自动进入晨间播报模式
→ 先健康分析，再资讯
→ 播报完毕后切换到自由对话模式
```

这不需要代码改动，通过 prompt engineering 实现。Coordinator 在语音 session 中会自动读取文件并播报。

---

## 七、开发任务清单（按依赖排序）

### Phase 1a — 资讯管线 MVP（第 1-2 周）

```
P1a-1. Mac Mini 部署 Gateway + launchd daemon
       - openclaw daemon install
       - Tailscale 安装 + 登录

P1a-2. DingTalk 主动推送修复 [开发]
       - 改造 outbound.sendText 使用 prepareCard API
       - 获取并存储用户 unionId
       - 测试：cron 任务 → DingTalk DM 推送

P1a-3. 创建工作区文件结构
       - ~/jarvis/ 完整目录
       - 初始化 sources.md（5 个 Twitter AI 账号）
       - 初始化 scoring-rules.md v1
       - 初始化 seen-ids.json

P1a-4. 配置 Coordinator + Scout agent
       - openclaw.json agent 配置
       - BOOTSTRAP.md 编写
       - 测试：手动触发 scout 抓取 → 返回结构化结果

P1a-5. 配置 news-monitor cron
       - openclaw cron add
       - 测试：每 30 分钟自动扫描 → 重要度 4+ 推送到 DingTalk

P1a-6. 配置 midday-digest + evening-summary cron
       - 测试：定时整合推送
```

### Phase 1b — 语音 + 健康（第 3-4 周）

```
P1b-1. Apple Health 数据类型扩展 [开发]
       - 添加 HRV, restingHeartRate, vo2Max, activeEnergyBurned
       - iOS 客户端构建测试

P1b-2. Twilio 部署
       - 购买 Twilio 号码
       - 配置 voice-call 插件
       - Tailscale Funnel 配置 webhook

P1b-3. 语音拨入测试
       - Siri 拨打 → Gateway 接听 → Coordinator 响应
       - 打断测试（VAD → STT → Agent → TTS）

P1b-4. Health-Analyst agent 配置
       - BOOTSTRAP.md + decision-rules.md + training-plan.md
       - 测试：node.invoke health.query → 分析结果

P1b-5. 晨间简报流程
       - morning-brief cron
       - 简报生成 → 缓存 → DingTalk 通知
       - 拨入后播报健康 + 资讯

P1b-6. 钉钉日程创建脚本
       - ~/jarvis/scripts/dingtalk-calendar.sh
       - 测试：语音中说"创建日程" → 钉钉日程创建成功
```

### Phase 1c — 知识沉淀（第 5-6 周）

```
P1c-1. Obsidian vault 确认 + obsidian-cli 安装
       - brew install obsidian-cli
       - obsidian-cli set-default

P1c-2. Librarian agent 配置
       - BOOTSTRAP.md（写入规范：YAML front matter, 标签, 来源链接）
       - 测试："记到 Obsidian" → obsidian-cli create 或直接写文件

P1c-3. OmniFocus JXA 脚本
       - ~/jarvis/scripts/omnifocus.sh
       - 测试：午间精选中显示今日待办

P1c-4. 投资资讯源接入
       - sources.md 添加 Twitter 财经账号
       - scoring-rules.md 添加投资类规则
       - 持仓信息写入 MEMORY.md

P1c-5. weekly-prep cron
       - 测试：周六生成初稿 → 通知 → 周日拨入回顾
```

---

## 八、风险与缓解

| 风险                                                    | 影响                   | 缓解                                                           |
| ------------------------------------------------------- | ---------------------- | -------------------------------------------------------------- |
| DingTalk AI Assistant 不支持主动推送                    | 核心功能阻塞           | 使用 prepareCard API；若不行，改用 DingTalk 企业机器人 webhook |
| Twitter 反爬 / 登录态失效                               | 资讯抓取中断           | Playwright 保持登录态 cookie；失败时 fallback 到 web_search    |
| Apple Health HRV/VO₂max 查询需要新 data type            | 健康分析不完整         | 优先用已有的 heartRate + sleepAnalysis 做基本决策              |
| Twilio 中国大陆延迟高                                   | 语音体验差             | 实测延迟，若 >2s 考虑 Telnyx 或本地 WebRTC 方案                |
| Voice-Call inbound 与 Coordinator agent 的 session 关联 | 语音中无法读取缓存简报 | 确认 voice-call 插件如何路由到 coordinator agent session       |

---

## 九、成本预估

| 项目                                         | 月成本      |
| -------------------------------------------- | ----------- |
| Claude Sonnet (Coordinator + Health-Analyst) | ~$9         |
| Claude Haiku (Scout + Librarian)             | ~$2         |
| OpenAI TTS (gpt-4o-mini-tts, ~80K chars/月)  | ~$1.2       |
| OpenAI Realtime STT (~40 min/月)             | ~$2.4       |
| Twilio 号码 + inbound 通话 (~40 min/月)      | ~$1.7       |
| **合计**                                     | **~$16/月** |
