# Dashboard

This dashboard was migrated from a Python PM2 sidecar (port 8766/8767) to a native OpenClaw gateway HTTP route at `/orchestrator`. The dashboard handler lives in `src/dashboard-handler.ts`. The dashboard frontend is at `dashboard/index.html` (single-file SPA using Tailwind). For active development, see `src/dashboard-handler.ts` for the HTTP handler and `dashboard/index.html` for the frontend.
