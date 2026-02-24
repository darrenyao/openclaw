# Personal Assistant System Plan (Mac Mini Deployment)

## Three-Phase Roadmap

- Phase 1: News discovery (RSS, HN, GitHub trending, WeChat RSS bridge)
- Phase 2: Task mgmt (OmniFocus), knowledge mgmt (file-based), learning recommendations
- Phase 3: Creative generator, health/training data, 2-person support

## 5 Best Practices

### 1. Supervisor-Worker Agent Architecture

- Coordinator Agent (default) → spawns specialized workers
- Agents: `coordinator`, `news-scout` (haiku, low cost), `knowledge-librarian`, `task-manager`, `creative-generator`
- Config: `agents.list[]` with per-agent model/workspace/identity/subagents
- `maxSpawnDepth: 2`, `maxChildrenPerAgent: 6`
- 2-person: each user binds via `bindings` to own Coordinator session

### 2. Cron-Driven Proactive News Pipeline

- Cron tasks: `morning-brief` (06:30), `midday-digest` (12:00), `evening-summary` (18:00), `news-monitor` (\*/30m), `weekly-review` (Sunday)
- Cron runs in `cron lane`, non-blocking with `main lane`
- News sources: RSS via `web_fetch`, HN API, GitHub trending page, WeChat via RSS bridge
- Model strategy: haiku for fetching, sonnet for summarization

### 3. File-System Knowledge Base + Layered Memory

- Workspace structure: `~/assistant/{coordinator,knowledge,tasks,news}/`
- Knowledge files: `index.md` (master index), `tech/`, `career/`, `daily-digest/`
- Memory layers: L1 session context → L2 transcript (24h) → L3 MEMORY.md (permanent) → L4 knowledge files (permanent)
- `memorySearch: { enabled: true }` for semantic search
- Auto-sedimentation: score >= 3 content → knowledge-librarian writes to files

### 4. Channel Layering + Push Strategy Matrix

- Primary interaction: DingTalk (work) / Telegram (personal) — bidirectional
- Push channel: DingTalk group / Telegram Channel — broadcast summaries
- Urgent: DingTalk @DM / Telegram DM — importance >= 4
- Web UI: localhost:18789 — debug/config
- Push matrix: importance (1-5) x time-of-day (work/evening/night)
- 2-person: `session.dmScope: "per-channel-peer"`, shared knowledge base, independent tasks

### 5. Mac Mini Deployment Blueprint

- Gateway as launchd daemon (`openclaw daemon install`)
- Tailscale for remote access
- Ollama for local model (zero-cost simple tasks)
- Playwright for browser automation (news scraping)
- Model cost optimization: haiku (fetching) < sonnet (summarization) < opus (deep analysis)
- Resilience: delivery queue persistence, subagent registry disk recovery, Time Machine backup
- Storage: `~/.openclaw/` (config/session/cron) + `~/assistant/` (workspace/knowledge)

## Implementation Timeline

- Phase 1 (2-3 weeks): Mac Mini deploy + Coordinator + Scout + Cron pipeline
- Phase 2 (3-4 weeks): Knowledge base + memorySearch + channel layering + 2-person
- Phase 3 (ongoing): Creative agent, health agent, push A/B testing, OmniFocus integration
