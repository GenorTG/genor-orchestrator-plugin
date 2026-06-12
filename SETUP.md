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

### 4. Start the dashboard
```bash
pm2 start skill/dashboard/server.py --name orchestration-dashboard --interpreter python3 -- 8766
pm2 save
```

### 5. Populate models
```bash
python3 skill/scripts/auto-populate-models.py
```

### 6. Restart gateway
```bash
openclaw gateway restart
```

### 7. Verify
```bash
curl http://localhost:8766/api/status
curl http://localhost:8766/api/models?all=1
```

---

**The plugin handles everything else automatically:**
- Data directories created on startup
- Nightly model sync scheduled via cron (3 AM)
- Log rotation and maintenance on 30-min interval
- Session auto-logging, routing enforcement, context injection via hooks

## Or install from ClawHub (plugin only)
```bash
openclaw plugins install genor-orchestrator-plugin
openclaw plugins enable genor-orchestrator
```
Then follow steps 3-7 for the skill and dashboard.
