#!/bin/bash
# serve.sh — Start the Orchestration Dashboard (port 8767, definitive)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${ORCHESTRATOR_DATA_DIR:-$HOME/.openclaw/workspace/orchestrator-data}"

cd "$SCRIPT_DIR"
ORCHESTRATOR_DATA_DIR="$DATA_DIR" python3 server.py
