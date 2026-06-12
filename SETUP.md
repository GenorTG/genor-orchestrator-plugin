# 🚀 Genor's Orchestrator — Setup Instructions

> **Give your AI agent this file and say: "Install and set up Genor's Orchestrator."**
> The agent should read this file and execute every step.

## Overview

This package installs a complete project orchestration system for OpenClaw:

| Component | What it is | How it runs |
|-----------|-----------|-------------|
| **Plugin** (this repo) | 12 tools + 8 lifecycle hooks | Inside OpenClaw (no separate process) |
| **Skill** (companion) | Dashboard Web UI + docs + scripts | PM2 sidecar (Python server on port 8766) |
| **Data** | orchestrator-data/ directory | On filesystem, survives OpenClaw wipes |

**ClawHub pages:**
- Plugin: `clawhub.com/packages/genor-orchestrator-plugin`
- Skill: `clawhub.com/packages/genor-orchestrator`

---

## Step-by-Step Setup

An AI agent or human should execute these steps in order.

### Step 1: Prerequisites

Ensure the system has:
- OpenClaw running (v2026.5.17+)
- `openclaw` CLI available
- Node.js with npm
- Python 3
- PM2 (`npm install -g pm2`)

### Step 2: Clone or Install

**Option A — From ClawHub (quickest, plugin only):**
```bash
openclaw plugins install genor-orchestrator-plugin
```

Then clone the companion skill repo separately:
```bash
git clone --depth 1 https://github.com/GenorTG/genor-orchestrator-skill.git
cd genor-orchestrator-skill
clawhub install .
```

**Option B — From GitHub (full setup, recommended):**
```bash
git clone --recurse-submodules https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
```

> `--recurse-submodules` is important — it also clones the `skill/` subdirectory which contains the dashboard and scripts. If you already cloned without it, run `git submodule update --init --recursive`.

### Step 3: Build and Install Plugin

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Install the plugin into OpenClaw
openclaw plugins install --force .
```

### Step 4: Enable the Plugin

```bash
openclaw plugins enable genor-orchestrator
```

### Step 5: Install the Companion Skill

```bash
# From the skill/ submodule (if you used --recurse-submodules)
clawhub install ./skill/
# OR if you cloned skill separately
clawhub install ./genor-orchestrator-skill/
# OR from ClawHub directly
clawhub install genor-orchestrator
```

Verify skill installed:
```bash
ls ~/.openclaw/workspace/skills/genor-orchestrator/SKILL.md
```

### Step 6: Create Data Directory & Populate Models

```bash
PLUGIN_DIR=$(pwd)
SKILL_DIR="$PLUGIN_DIR/skill"

# Create orchestrator-data directory
mkdir -p "$PLUGIN_DIR/orchestrator-data/projects"
mkdir -p "$PLUGIN_DIR/orchestrator-data/logs"
mkdir -p "$PLUGIN_DIR/orchestrator-data/sessions"
mkdir -p "$PLUGIN_DIR/orchestrator-data/adrs"

# Auto-populate model inventory from OpenClaw's own config
python3 "$SKILL_DIR/scripts/auto-populate-models.py"
```

### Step 7: Start the Dashboard Web UI

```bash
# Start with PM2
pm2 start "$SKILL_DIR/dashboard/server.py" \
  --name orchestration-dashboard \
  --interpreter python3 \
  -- 8766

# Save PM2 process list (survives reboot)
pm2 save
```

### Step 8: Schedule Nightly Model Sync

```bash
PLUGIN_DIR=$(pwd)
(crontab -l 2>/dev/null; echo "0 3 * * * cd $PLUGIN_DIR && python3 $SKILL_DIR/scripts/auto-populate-models.py >> $PLUGIN_DIR/orchestrator-data/logs/auto-populate.log 2>&1") | crontab -
```

### Step 9: Restart Gateway

```bash
# The plugin loads into OpenClaw's runtime on restart.
# Use the restart method available in your environment.
openclaw gateway restart
```

> After restart, session management will show a brief "Plugin loaded" session for the restart itself.

### Step 10: Verify Everything

**Check plugin is loaded:**
```bash
openclaw plugins list | grep genor-orchestrator
# Expected: "genor-orchestrator" line with status "enabled"
```

**Check all 12 tools are available:**
```bash
# From inside an OpenClaw session, these tools should appear in your tool list:
# - orchestrator_set_context
# - orchestrator_clear_context
# - orchestrator_get_status
# - orchestrator_get_config
# - orchestrator_get_models
# - orchestrator_check_models
# - orchestrator_auto_populate
# - orchestrator_log_session
# - orchestrator_log_decision
# - orchestrator_get_logs
# - orchestrator_sync_project
# - orchestrator_get_project_docs
```

**Check dashboard is running:**
```bash
curl -s http://localhost:8766/api/status | python3 -m json.tool
# Expected: JSON with nightly_price_check, data_dir, projects_configured, etc.
```

**Check models were populated:**
```bash
curl -s http://localhost:8766/api/models?all=1 | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"total\"]} models loaded')"
# Expected: Some number > 0
```

**Check cron scheduled:**
```bash
crontab -l | grep auto-populate
# Expected: A line with auto-populate-models.py
```

### Step 11: Create a Test Session

```bash
# From inside OpenClaw, call:
# orchestrator_set_context(project="test", task="verify-setup")
#
# This should return context data. Then end the session.
# Check that it appears in:
curl -s http://localhost:8766/api/sessions | python3 -c "import json,sys; d=json.load(sys.stdin); print(f'{d[\"count\"]} sessions recorded')"
```

---

## Usage (After Setup)

### Start a Work Session

```typescript
// Inside your OpenClaw session:
orchestrator_set_context(project="my-project", task="fix-bug")

// The plugin hooks will now:
// - Auto-log when this session ends
// - Enforce project routing rules
// - Inject project context into every prompt
// - Track sub-agent depth
```

### Open the Dashboard

Browse http://localhost:8766 to:
- View and edit the model inventory
- Configure routing (free-only, disabled, allowlists)
- Browse session history
- Manage projects

### Check Model Routing

```bash
cd /path/to/genor-orchestrator-plugin
bash skill/scripts/check-models.sh my-project
```

---

## Architecture (for context)

```
Plugin (runtime in OpenClaw)
├── 12 tools
│   ├── set_context        → Declare project + task
│   ├── get_status         → Quick overview
│   ├── get_models         → List with filters
│   ├── check_models       → Routing filter inspection
│   ├── get_config         → Read routing config
│   ├── auto_populate      → Sync models from gateway config
│   ├── log_session        → Manual/retro session log
│   ├── log_decision       → ADR creation
│   ├── get_logs           → Query JSONL logs
│   ├── sync_project       → Sync project to orchestrator
│   ├── get_project_docs   → List project documents
│   └── clear_context      → Disable context hooks
├── 8 hooks (auto-registered)
│   ├── session_start      → Track time, reset depth
│   ├── session_end        → Auto-log session
│   ├── subagent_spawned   → Increment depth
│   ├── subagent_ended     → Decrement depth
│   ├── before_model_resolve → Apply routing filters
│   ├── before_prompt_build  → Inject context
│   ├── agent_end          → Observe quality
│   └── gateway_stop       → Clean timers

Skill (collateral on disk)
├── Dashboard (Python, PM2)
│   ├── server.py          → HTTP server
│   ├── index.html         → Web UI
│   └── port 8766
├── SKILL.md               → Workflow instructions
├── scripting/             → Operational scripts
│   ├── auto-populate-models.py
│   ├── check-models.sh
│   ├── check-prices.sh
│   └── ...
└── references/            → Documentation

Data (on filesystem)
└── orchestrator-data/
    ├── models.json
    ├── dashboard-config.json
    ├── session_log.md
    ├── logs/orchestrator.jsonl
    ├── adrs/0001-*.md
    ├── sessions/*.md
    └── projects/*/
        ├── CONTEXT.md
        ├── RECOVERY.md
        ├── BACKLOG.json
        └── sessions.json
```

---

## Configuration

Plugin settings go in `openclaw.json` under `plugins.genor-orchestrator`:

```json
{
  "plugins": {
    "genor-orchestrator": {
      "orchestratorDataDir": "/custom/path",
      "logLevel": "info",
      "logRetentionDays": 30,
      "maintenanceIntervalMs": 1800000
    }
  }
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `orchestratorDataDir` | string | workspace/orchestrator-data/ | Override data dir |
| `logLevel` | debug\|info\|warn\|error | info | Logging level |
| `logRetentionDays` | number | 30 | Log retention |
| `maintenanceIntervalMs` | number | 1800000 | Background interval (30min) |

---

## Troubleshooting

### "openclaw plugins install fails with dependency error"
```bash
openclaw plugins install --force /path/to/genor-orchestrator-plugin
```

### "Plugin not found after gateway restart"
```bash
openclaw plugins enable genor-orchestrator
openclaw gateway restart
```

### "Port 8766 already in use"
```bash
fuser -k 8766/tcp 2>/dev/null
pm2 start skill/dashboard/server.py --name orchestration-dashboard --interpreter python3 -- 8766
```

### "No models showing in dashboard"
```bash
cd /path/to/genor-orchestrator-plugin
python3 skill/scripts/auto-populate-models.py
```

---

## Clean Uninstall

```bash
openclaw plugins disable genor-orchestrator
openclaw plugins uninstall genor-orchestrator
pm2 stop orchestration-dashboard && pm2 delete orchestration-dashboard
pm2 save
crontab -l | grep -v auto-populate | crontab -
clawhub uninstall genor-orchestrator 2>/dev/null || true
rm -rf orchestrator-data
```

---

## Related

- [Plugin source](https://github.com/GenorTG/genor-orchestrator-plugin)
- [Skill source](https://github.com/GenorTG/genor-orchestrator-skill)
- [ClawHub Plugin Package](https://clawhub.com/packages/genor-orchestrator-plugin)
- [ClawHub Skill Package](https://clawhub.com/packages/genor-orchestrator)
