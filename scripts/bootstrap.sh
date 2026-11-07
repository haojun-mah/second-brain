#!/usr/bin/env bash
# bootstrap.sh — one-command first-run setup for the second-brain system.
#
# Checks dependencies, builds the MCP server, installs the agent skills,
# scaffolds the vault, and prints the remaining manual steps.
#
# Usage:
#   ./scripts/bootstrap.sh                 # interactive, uses defaults
#   ./scripts/bootstrap.sh --yes           # non-interactive
#   ./scripts/bootstrap.sh --vault-dir DIR # custom vault location
#
# Safe to re-run: existing files are never overwritten without a prompt.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SKILLS_DIR="$HERMES_HOME/skills"
DEFAULT_VAULT="$HOME/SecondBrainVault"
VAULT_DIR="$DEFAULT_VAULT"
ASSUME_YES=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y)     ASSUME_YES=1 ;;
    --vault-dir=*) VAULT_DIR="${arg#*=}" ;;
    --help|-h)
      sed -n '2,14p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
  esac
done

# ── output helpers ───────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi
step()  { printf '\n%s▶ %s%s\n' "$B" "$1" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail()  { printf '  %s✗%s %s\n' "$R" "$N" "$1"; }
info()  { printf '  %s%s%s\n' "$D" "$1" "$N"; }

FAILED=0
MISSING_HARD=0

confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '  %s?%s %s [Y/n]: ' "$Y" "$N" "$1"
  read -r reply
  case "${reply:-Y}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

printf '%s\n' "════════════════════════════════════════════════════════════════"
printf '%s\n' "  Second Brain — bootstrap"
printf '%s\n' "════════════════════════════════════════════════════════════════"
info "repo:        $REPO_DIR"
info "hermes home: $HERMES_HOME"
info "vault:       $VAULT_DIR"

# ── 1. dependency checks ─────────────────────────────────────────────────────
step "1/6  Checking dependencies"

have() { command -v "$1" >/dev/null 2>&1; }

if have node; then
  NODE_V=$(node -v)
  NODE_MAJOR=${NODE_V#v}; NODE_MAJOR=${NODE_MAJOR%%.*}
  if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
    ok "node $NODE_V"
  else
    fail "node $NODE_V is too old (need >= 18)"
    MISSING_HARD=1
  fi
else
  fail "node not found — install Node.js >= 18 (https://nodejs.org)"
  MISSING_HARD=1
fi

have npm  && ok "npm $(npm -v)"  || { fail "npm not found"; MISSING_HARD=1; }

if have python3; then
  PY_V=$(python3 -c 'import sys; print("%d.%d"%sys.version_info[:2])')
  PY_MAJOR=${PY_V%%.*}; PY_MINOR=${PY_V#*.}
  if [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 10 ]; then
    ok "python $PY_V"
  else
    warn "python $PY_V found (3.10+ recommended)"
  fi
else
  warn "python3 not found — needed for vault init / token helper"
fi

have git && ok "git $(git --version | awk '{print $3}')" || { fail "git not found"; MISSING_HARD=1; }

# Hermes CLI — strongly recommended, not strictly required
if have hermes; then
  ok "hermes CLI present"
else
  warn "hermes CLI not found — the agent skills need it:"
  info "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash"
fi

if [ "$MISSING_HARD" -ne 0 ]; then
  printf '\n%sCannot continue without: node >= 18, npm, git.%s\n' "$R" "$N"
  exit 1
fi

# ── 2. .env ──────────────────────────────────────────────────────────────────
step "2/6  Environment file"

ENV_FILE="$REPO_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  ok ".env already exists (left untouched)"
else
  if [ -f "$REPO_DIR/.env.example" ]; then
    cp "$REPO_DIR/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "created .env from .env.example"
    warn "fill in your credentials — see docs/CREDENTIALS.md"
    info "    MS_CLIENT_ID / MS_TENANT_ID / MS_REFRESH_TOKEN"
    info "    ($ENV_FILE)"
  else
    fail ".env.example missing"
    FAILED=1
  fi
fi

# ── 3. build the MCP server ──────────────────────────────────────────────────
step "3/6  Building the OneDrive MCP server"

MCP_DIR="$REPO_DIR/mcp-onedrive"
if [ -d "$MCP_DIR" ]; then
  (
    cd "$MCP_DIR" || exit 1
    if [ -d node_modules ]; then
      ok "dependencies already installed"
    else
      info "installing npm dependencies (this takes ~30s)…"
      if npm install --no-audit --no-fund >/tmp/sb_npm.log 2>&1; then
        ok "npm install complete"
      else
        fail "npm install failed — see /tmp/sb_npm.log"
        exit 1
      fi
    fi
    info "compiling TypeScript…"
    if npm run build >/tmp/sb_build.log 2>&1; then
      ok "build complete -> mcp-onedrive/dist/"
    else
      fail "build failed — see /tmp/sb_build.log"
      exit 1
    fi
  ) || FAILED=1
else
  fail "mcp-onedrive/ directory missing"
  FAILED=1
fi

# ── 4. install the skills ────────────────────────────────────────────────────
step "4/6  Installing agent skills"

if [ -d "$REPO_DIR/skills" ]; then
  mkdir -p "$SKILLS_DIR"
  INSTALLED=0
  for s in "$REPO_DIR"/skills/*/; do
    name=$(basename "$s")
    if [ -d "$SKILLS_DIR/$name" ]; then
      warn "skill '$name' already installed — skipping (remove to reinstall)"
    else
      cp -r "$s" "$SKILLS_DIR/$name"
      find "$SKILLS_DIR/$name" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null
      ok "installed skill: $name"
      INSTALLED=$((INSTALLED+1))
    fi
  done
  [ "$INSTALLED" -eq 0 ] && info "no new skills installed"
else
  fail "skills/ directory missing"
  FAILED=1
fi

# ── 5. scaffold the vault ────────────────────────────────────────────────────
step "5/6  Scaffolding the vault"

if [ -d "$VAULT_DIR" ] && [ -n "$(ls -A "$VAULT_DIR" 2>/dev/null)" ]; then
  warn "vault already exists and is non-empty: $VAULT_DIR"
  info "leaving it untouched. To scaffold elsewhere: --vault-dir=DIR"
else
  if [ -f "$REPO_DIR/scripts/init_vault.py" ]; then
    if python3 "$REPO_DIR/scripts/init_vault.py" --dest "$VAULT_DIR" 2>/tmp/sb_vault.log; then
      ok "vault scaffolded at $VAULT_DIR"
    else
      # init_vault.py may expect a different flag; fall back to a plain copy
      if mkdir -p "$VAULT_DIR" && cp -r "$REPO_DIR/vault-template/." "$VAULT_DIR/" 2>/dev/null; then
        ok "vault scaffolded by direct copy (init_vault.py fallback)"
      else
        fail "vault scaffolding failed — see /tmp/sb_vault.log"
        FAILED=1
      fi
    fi
  elif [ -d "$REPO_DIR/vault-template" ]; then
    mkdir -p "$VAULT_DIR" && cp -r "$REPO_DIR/vault-template/." "$VAULT_DIR/"
    ok "vault scaffolded at $VAULT_DIR"
  else
    fail "no vault-template/ to copy"
    FAILED=1
  fi
fi

# ── 6. build the dashboard (optional) ────────────────────────────────────────
step "6/6  Web dashboard (optional)"

if [ -d "$REPO_DIR/webpage" ] && [ -f "$REPO_DIR/webpage/package.json" ]; then
  if confirm "Install dashboard dependencies now?"; then
    (
      cd "$REPO_DIR/webpage" || exit 1
      if npm install --no-audit --no-fund >/tmp/sb_web.log 2>&1; then
        ok "dashboard dependencies installed"
      else
        warn "dashboard install failed — see /tmp/sb_web.log (safe to skip)"
      fi
    )
  else
    info "skipped — run 'cd webpage && npm install' later"
  fi
else
  info "no webpage/ directory — skipping"
fi

# ── summary ──────────────────────────────────────────────────────────────────
printf '\n%s\n' "════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
  printf '  %sBootstrap complete%s\n' "$G" "$N"
else
  printf '  %sBootstrap finished with errors%s — review the ✗ lines above\n' "$R" "$N"
fi
printf '%s\n\n' "════════════════════════════════════════════════════════════════"

cat <<EOF
${B}Next steps${N}

  1. Fill in your credentials:
       ${D}${ENV_FILE}${N}
     Get them here → docs/CREDENTIALS.md

  2. Verify everything works:
       ${D}./scripts/healthcheck.sh${N}

  3. Register the MCP server with Hermes:
       add the mcp block from docs/SETUP.md (step 3) to
       ${D}${HERMES_HOME}/config.yaml${N}

  4. Point Obsidian at your vault:
       ${D}${VAULT_DIR}${N}

  5. Schedule the two cron jobs (ingester + linter):
       see docs/SETUP.md (step 6)

  Full guide: docs/SETUP.md
EOF

exit "$FAILED"
