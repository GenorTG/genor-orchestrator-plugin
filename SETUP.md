# Setup Instructions for AI Agents

> **Tell your agent:** *"Install Genor's Orchestrator from [this repo](https://github.com/GenorTG/genor-orchestrator-plugin.git)."*

## Agent: execute these steps

### 1. Clone
```bash
git clone --recurse-submodules https://github.com/GenorTG/genor-orchestrator-plugin.git
cd genor-orchestrator-plugin
```

### 2. Build and install the plugin
```bash
npm install
npm run build
openclaw plugins install --force .
openclaw plugins enable genor-orchestrator
```

### 3. Install the companion skill
```bash
clawhub install ./skill/
```

### 4. Populate models
```bash
npx tsx skill/scripts/auto-populate-models.ts
```

### 5. Restart gateway
```bash
openclaw gateway restart
```

### 6. Verify
```bash
openclaw plugins list | grep orchestrator
openclaw plugins inspect genor-orchestrator
```

The dashboard is available at the `/orchestrator` route after gateway restart (e.g. `http://localhost:18789/orchestrator`). No separate server process needed — the dashboard handler is bundled into the plugin via `src/dashboard-handler.ts`.

---

**The plugin handles everything else automatically:**
- Data directories created on startup
- Nightly model sync scheduled via cron (3 AM)
- Log rotation and maintenance on 30-min interval
- Session auto-logging, routing enforcement, context injection via hooks
- **21 tools** for model management, project tracking, and agent orchestration

## Or install from ClawHub (plugin only)
```bash
openclaw plugins install genor-orchestrator-plugin
openclaw plugins enable genor-orchestrator
```
Then follow steps 3-6 for the skill.
