#!/usr/bin/env bash
# deploy-vps.sh — End-to-end VPS deployment for the second-brain system.
#
# Sets up NanoClaw v2 + three automated agents (ingester, query, linter)
# backed by an Obsidian vault in OneDrive, accessible via Telegram.
#
# Usage:
#   bash scripts/deploy-vps.sh [options]
#
# Options:
#   --skip-prereqs    Skip Node/pnpm/Docker installation checks
#   --skip-build      Skip container image build (use existing nanoclaw-agent:latest)
#   --skip-nanoclaw   Skip NanoClaw base setup (run second-brain parts only)
#
# The same options can be passed as env vars:
#   SKIP_PREREQS=1  SKIP_BUILD=1  SKIP_NANOCLAW_SETUP=1

set -euo pipefail

GREEN='\033[0;32m'
BOLD='\033[1m'
DIM='\033[2m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

step() { echo -e "\n${BOLD}▶ $*${RESET}"; }
ok()   { echo -e "${GREEN}✓ $*${RESET}"; }
warn() { echo -e "${YELLOW}⚠  $*${RESET}"; }
die()  { echo -e "${RED}✗  $*${RESET}"; exit 1; }
dim()  { echo -e "${DIM}  $*${RESET}"; }

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Flag parsing ──────────────────────────────────────────────────────────────
SKIP_PREREQS="${SKIP_PREREQS:-0}"
SKIP_BUILD="${SKIP_BUILD:-0}"
SKIP_NANOCLAW_SETUP="${SKIP_NANOCLAW_SETUP:-0}"

for arg in "$@"; do
  case $arg in
    --skip-prereqs)   SKIP_PREREQS=1 ;;
    --skip-build)     SKIP_BUILD=1 ;;
    --skip-nanoclaw)  SKIP_NANOCLAW_SETUP=1 ;;
    --help|-h)
      echo "Usage: bash scripts/deploy-vps.sh [--skip-prereqs] [--skip-build] [--skip-nanoclaw]"
      exit 0 ;;
  esac
done

# ── Welcome + pre-flight checklist ───────────────────────────────────────────
echo ""
echo -e "${BOLD}Second Brain — VPS Deployment${RESET}"
echo ""
echo "  This script sets up the full second-brain system on this machine:"
echo "  • NanoClaw host service (agent orchestrator)"
echo "  • Ingester — polls OneDrive/Obsidian every 10 min, writes wiki"
echo "  • Query    — answers questions + captures via Telegram"
echo "  • Linter   — daily vault audit at 3am"
echo "  • OneDrive vault — folder structure + CLAUDE.md created automatically"
echo ""
echo -e "${YELLOW}Before continuing, confirm you have completed this manual step:${RESET}"
echo ""
echo "  Register an Azure app at portal.azure.com:"
echo "    App registrations → New registration"
echo "    → Platform: Mobile/desktop (Public client/native)"
echo "    → Redirect URI: https://login.microsoftonline.com/common/oauth2/nativeclient"
echo "    → API permissions: Files.ReadWrite + offline_access (delegated)"
echo "    → Authentication → Advanced → Allow public client flows: Yes"
echo "    → Copy the Application (client) ID and Directory (tenant) ID"
echo ""
echo "  See docs/second-brain-setup.md Step 1 for the full walkthrough."
echo ""
read -r -p "Have you registered the Azure app and noted the client + tenant IDs? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Register the Azure app first, then re-run."; exit 0; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
if [ "$SKIP_PREREQS" != "1" ]; then
  step "Checking prerequisites"

  # Node 20+
  if ! command -v node &>/dev/null; then
    dim "Node.js not found — installing Node 20 via NodeSource..."
    if command -v apt-get &>/dev/null; then
      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null 2>&1
      sudo apt-get install -y nodejs >/dev/null 2>&1
    else
      die "Cannot auto-install Node on this OS. Install Node 20+ manually and re-run with --skip-prereqs."
    fi
  fi
  NODE_MAJOR=$(node --version | cut -d. -f1 | tr -d 'v')
  [ "$NODE_MAJOR" -ge 20 ] || die "Node.js 20+ required (found $(node --version)). Upgrade and retry."
  ok "Node.js $(node --version)"

  # pnpm
  if ! command -v pnpm &>/dev/null; then
    dim "pnpm not found — enabling via corepack..."
    corepack enable
    corepack prepare pnpm@latest --activate
  fi
  ok "pnpm $(pnpm --version)"

  # Docker
  if ! command -v docker &>/dev/null; then
    dim "Docker not found — installing via get.docker.com..."
    curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
    sudo usermod -aG docker "$USER"
    warn "Docker installed. You must log out and back in for group membership to take effect."
    warn "After logging back in, re-run this script with --skip-prereqs."
    exit 0
  fi
  if ! docker info &>/dev/null; then
    die "Docker is installed but not running. Start it with: sudo systemctl start docker"
  fi
  ok "Docker $(docker --version | awk '{print $3}' | tr -d ',')"

  # Swap — bun install inside the container build OOMs on VPS with <3 GB RAM and no swap
  TOTAL_RAM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 9999)
  TOTAL_SWAP=$(awk '/SwapTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 9999)
  if [ "$TOTAL_SWAP" -eq 0 ] && [ "$TOTAL_RAM" -lt 3000 ]; then
    dim "RAM < 3 GB and no swap detected — adding 2 GB swap to prevent OOM during container build..."
    if [ ! -f /swapfile ]; then
      sudo fallocate -l 2G /swapfile
      sudo chmod 600 /swapfile
      sudo mkswap /swapfile >/dev/null
      sudo swapon /swapfile
      grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
    else
      sudo swapon /swapfile 2>/dev/null || true
    fi
    ok "Swap enabled (2 GB)"
  fi
else
  dim "Skipping prerequisite checks (--skip-prereqs)"
fi

# ── .env setup ────────────────────────────────────────────────────────────────
step "Configuring environment"

if [ ! -f .env ]; then
  cp .env.example .env
  dim "Created .env from .env.example"
fi

# Load existing .env values
set -a
# shellcheck source=/dev/null
source .env
set +a

prompt_if_missing() {
  local key="$1" label="$2"
  local current_val="${!key:-}"
  if [ -z "$current_val" ]; then
    echo -n "  ${label}: "
    read -r input_val
    if [ -z "$input_val" ]; then
      die "$key is required. Aborting."
    fi
    # Write to .env (update existing line or append)
    if grep -q "^${key}=" .env; then
      sed -i "s|^${key}=.*|${key}=${input_val}|" .env
    else
      echo "${key}=${input_val}" >> .env
    fi
    export "$key=$input_val"
  else
    dim "$key already set"
  fi
}

echo ""
prompt_if_missing MS_CLIENT_ID       "Azure Application (client) ID"
prompt_if_missing MS_TENANT_ID       "Azure Directory (tenant) ID"
prompt_if_missing TELEGRAM_BOT_TOKEN "Telegram bot token (from @BotFather)"

# Re-source to ensure all vars are in environment for child processes
set -a
source .env
set +a

ok "Environment configured"

# ── Install pnpm dependencies ─────────────────────────────────────────────────
step "Installing dependencies"
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ── Build TypeScript (host) ───────────────────────────────────────────────────
step "Building host TypeScript"
if ! pnpm run build 2>&1; then
  die "TypeScript build failed. See output above for the compiler error."
fi
ok "Host TypeScript built"

# ── Build container image ─────────────────────────────────────────────────────
if [ "$SKIP_BUILD" != "1" ]; then
  step "Building agent container image (nanoclaw-agent:latest)"
  dim "First build takes 3-5 min; subsequent builds use the layer cache..."
  ./container/build.sh
  ok "Container image built"
else
  dim "Skipping container build (--skip-build)"
fi

# ── Full second-brain setup ───────────────────────────────────────────────────
step "Running second-brain setup"
dim "This will:"
if [ "$SKIP_NANOCLAW_SETUP" != "1" ]; then
  dim "  Stage 1 — NanoClaw base setup (interactive: service, OneCLI, Telegram wiring)"
fi
dim "  Stage 2a — Create ingester / query / linter agent groups"
dim "  Stage 2b — OneDrive authentication (device code flow)"
echo ""

SKIP_NANOCLAW_SETUP="$SKIP_NANOCLAW_SETUP" bash scripts/setup-full.sh

# ── Post-deploy summary ───────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Deployment complete.${RESET}"
echo ""
echo "  Service status:"
echo "    systemctl --user status nanoclaw"
echo ""
echo "  Live logs:"
echo "    journalctl --user -u nanoclaw -f"
echo "    tail -f logs/nanoclaw.log"
echo ""
echo "  Verify the system is working:"
echo "    1. Open Obsidian, point it at OneDrive/Obsidian/ — you should see the folder structure"
echo "    2. Drop a test file into sources/_inbox/"
echo "    3. Wait up to 10 minutes"
echo "    4. Check wiki/log.md — a new entry should appear"
echo "    5. Send a message to your Telegram bot to test the query agent"
echo ""
echo "  To re-run just the second-brain parts (skipping NanoClaw base setup):"
echo "    SKIP_NANOCLAW_SETUP=1 bash scripts/setup-full.sh"
echo ""
