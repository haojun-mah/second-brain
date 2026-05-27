#!/usr/bin/env bash
# Full second-brain setup.
#
# Runs in two stages:
#   1. Standard NanoClaw setup (setup:auto) — interactive: creates service,
#      OneCLI vault, Claude auth, and optionally wires Telegram.
#   2. Second-brain extras — mostly non-interactive: creates the
#      ingester/query/linter agent groups, runs the OneDrive OAuth device
#      code flow, and bootstraps the ingester's self-scheduling loop.
#
# Usage:
#   bash scripts/setup-full.sh
#
# To skip stage 1 (e.g. NanoClaw already set up):
#   SKIP_NANOCLAW_SETUP=1 bash scripts/setup-full.sh

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

GREEN='\033[0;32m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

step() { echo -e "\n${BOLD}▶ $*${RESET}"; }
ok()   { echo -e "${GREEN}✓ $*${RESET}"; }
dim()  { echo -e "${DIM}  $*${RESET}"; }

# ── Load .env into environment ────────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  # shellcheck source=/dev/null
  source .env
  set +a
fi

# ── Stage 1: Standard NanoClaw setup ─────────────────────────────────────────
if [ "${SKIP_NANOCLAW_SETUP:-0}" != "1" ]; then
  step "Stage 1 — NanoClaw base setup"
  dim "This is interactive. Follow the prompts."
  dim "When asked about a messaging channel, choose Telegram and paste your bot token."
  echo ""
  pnpm run setup:auto
  echo ""
  ok "NanoClaw base setup complete."

  # Re-source .env — setup:auto may have written new values (e.g. TELEGRAM_BOT_TOKEN).
  if [ -f .env ]; then
    set -a
    source .env
    set +a
  fi
else
  dim "Skipping NanoClaw base setup (SKIP_NANOCLAW_SETUP=1)."
fi

# ── Stage 2a: Second-brain agent groups ───────────────────────────────────────
step "Stage 2a — Creating second-brain agent groups (ingester / query / linter)"
pnpm exec tsx scripts/setup-second-brain.ts
ok "Agent groups created."

# ── Stage 2b: OneDrive authentication ────────────────────────────────────────
step "Stage 2b — OneDrive authentication"

if [ -n "${MS_REFRESH_TOKEN:-}" ]; then
  dim "MS_REFRESH_TOKEN already set — skipping device code flow."
  ok "OneDrive auth already complete."
else
  if [ -z "${MS_CLIENT_ID:-}" ] || [ -z "${MS_TENANT_ID:-}" ]; then
    echo ""
    echo "  MS_CLIENT_ID and MS_TENANT_ID are not set in .env."
    echo "  Register an app in Azure Portal first (see docs/second-brain-setup.md Step 1)."
    echo "  Then re-run with SKIP_NANOCLAW_SETUP=1 bash scripts/setup-full.sh"
    echo ""
    exit 1
  fi

  dim "Starting Microsoft device code flow..."
  dim "A URL and code will be printed. Open the URL in any browser and enter the code."
  echo ""
  pnpm exec tsx scripts/setup-onedrive-auth.ts

  # Re-source so MS_REFRESH_TOKEN is visible for the bootstrap step.
  if [ -f .env ]; then
    set -a
    source .env
    set +a
  fi
  ok "OneDrive auth complete."
fi

# ── Stage 2c: Vault folder structure + initial files ─────────────────────────
step "Stage 2c — Initialising OneDrive vault"
dim "Creates OneDrive/Obsidian/ folder structure and seeds CLAUDE.md, wiki/index.md,"
dim "wiki/log.md, and .meta/ state files. Safe to re-run — skips existing items."
echo ""
pnpm exec tsx scripts/setup-vault.ts
ok "Vault initialised."

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Setup complete.${RESET}"
echo ""
echo "  Drop files into OneDrive/Obsidian/sources/_inbox/ and the ingester"
echo "  will be processed automatically (polls every 10 minutes)."
echo ""
echo "  Chat with the query agent via Telegram."
echo ""
echo "  To check status:  pnpm run chat /status"
echo "  To run a lint:    pnpm run chat /lint"
echo ""
