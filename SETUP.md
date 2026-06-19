# 🚀 Setup Guide — Genor's Orchestrator Plugin

> **Tell your agent:** *"Install Genor's Orchestrator from https://github.com/GenorTG/genor-orchestrator-plugin.git"*

---

## 📦 Quick Install

### Step 1 — Clone & Build

```bash
git clone --recurse-submodules https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
npm install
npm run build
```

### Step 2 — Install Plugin

```bash
openclaw plugins install --force .
openclaw plugins enable genor-orchestrator
```

### Step 3 — Populate Models

```bash
npx tsx scripts/auto-populate-models.ts
```

### Step 4 — Restart Gateway

```bash
openclaw gateway restart
```

### Step 5 — Verify

```bash
openclaw plugins list | grep orchestrator
openclaw plugins inspect genor-orchestrator
```

### Step 6 — Open Dashboard

The dashboard lives at your gateway's `/orchestrator` route — no separate server needed:

```bash
# Local:
open http://localhost:18789/orchestrator

# Or via your tailscale domain:
open https://genorbox1.tailxxx.ts.net/orchestrator
```

That's it. **9 dashboard tabs, 40 tools, 8 hooks** — all running inside your gateway as a native extension (installed at `~/.openclaw/extensions/genor-orchestrator/`).

---

## 🔄 What Happens Automatically

| What | When |
|------|------|
| 📁 Data dirs created | On first plugin load |
| 🌙 Nightly model sync | 3 AM via cron |
| 🔧 Maintenance tick | Every 30 min (log rotation, session normalization, recovery docs) |
| 📝 Session auto-logging | On every session_end hook |
| 🚦 Model routing | On every before_model_resolve (per-project allowlists & routing presets) |
| 📍 Context injection | On every before_prompt_build (STATE.md, ROADMAP.md) |
| ✅ Auto-QA | When workflow.include_qa is enabled |

---

## 🧪 Checking It Works

```bash
# Quick status
openclaw plugins inspect genor-orchestrator | grep -E "tools|hooks"

# Dashboard API
curl http://localhost:18789/orchestrator/api/status

# See all tools
curl http://localhost:18789/orchestrator/api/config | python3 -m json.tool
```

---

## 🐛 Common Issues

| Problem | Fix |
|---------|-----|
| Spawn fails — "Gateway token not found" | Gateway token missing in `~/.openclaw/openclaw.json` or `OPENCLAW_GATEWAY_TOKEN` env var |
| Plugin not found after install | Check `openclaw plugins list` — enable if disabled |
| Dashboard 404 | Plugin may need restart. Check `openclaw gateway status` |
| Auto-populate fails | Temp file rename issue. Run `orchestrator_auto_populate` manually |
| Stale sessions in dashboard | Doctor (`orchestrator_doctor check=data fix=true`) auto-fixes |
| Binding violation error | Call `orchestrator_release_project` first, then `set_context` to new project |

---

## 📦 ClawHub Install (Plugin Only)

```bash
clawhub package install genor-orchestrator-plugin
openclaw plugins enable genor-orchestrator
```

Then skip to Step 3 (model population). The dashboard is bundled — no extra steps needed.
