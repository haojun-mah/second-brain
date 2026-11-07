#!/usr/bin/env bash
# healthcheck.sh — verify a second-brain installation.
#
# Checks: env credentials, Microsoft Graph token validity, vault layout,
# MCP server build, installed skills, and dashboard presence.
#
# Usage:
#   ./scripts/healthcheck.sh
#   ./scripts/healthcheck.sh --vault-dir DIR
#
# Exit code 0 = all required checks passed.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SKILLS_DIR="$HERMES_HOME/skills"
VAULT_DIR="${VAULT_DIR:-$HOME/SecondBrainVault}"

for arg in "$@"; do
  case "$arg" in
    --vault-dir=*) VAULT_DIR="${arg#*=}" ;;
    --help|-h) sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; D=""; N=""
fi

PASS=0; FAIL=0; WARN=0
pass() { printf '  %s✓%s %s\n' "$G" "$N" "$1"; PASS=$((PASS+1)); }
bad()  { printf '  %s✗%s %s\n' "$R" "$N" "$1"; FAIL=$((FAIL+1)); }
soft() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; WARN=$((WARN+1)); }
head_() { printf '\n%s▶ %s%s\n' "$B" "$1" "$N"; }

printf '%s\n' "════════════════════════════════════════════════════════════════"
printf '%s\n' "  Second Brain — healthcheck"
printf '%s\n' "════════════════════════════════════════════════════════════════"

# ── 1. environment ───────────────────────────────────────────────────────────
head_ "1/6  Environment"

ENV_FILE="$REPO_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  pass ".env present"
  set -a; . "$ENV_FILE" >/dev/null 2>&1; set +a
else
  bad ".env missing — copy .env.example and fill it in"
fi

need_env() {
  local name="$1" val="${!1:-}"
  if [ -z "$val" ]; then
    bad "$name not set"
  elif printf '%s' "$val" | grep -qiE 'your[-_]|placeholder|changeme|xxx'; then
    bad "$name still holds a placeholder value"
  else
    pass "$name set (${#val} chars)"
  fi
}

need_env MS_CLIENT_ID
need_env MS_TENANT_ID
need_env MS_REFRESH_TOKEN

# ── 2. Microsoft Graph ───────────────────────────────────────────────────────
head_ "2/6  Microsoft Graph access"

if [ -n "${MS_CLIENT_ID:-}" ] && [ -n "${MS_REFRESH_TOKEN:-}" ]; then
  GRAPH_RESULT=$(python3 - "$REPO_DIR" <<'PY' 2>&1
import sys, json, pathlib, urllib.request, urllib.parse, urllib.error

repo = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(repo / "scripts"))
try:
    from _graph import get_access_token  # noqa
    token = get_access_token()
except Exception:
    # Fall back to a direct refresh-token exchange.
    cid = __import__("os").environ["MS_CLIENT_ID"]
    tid = __import__("os").environ.get("MS_TENANT_ID", "common")
    rt  = __import__("os").environ["MS_REFRESH_TOKEN"]
    data = urllib.parse.urlencode({
        "client_id": cid, "grant_type": "refresh_token",
        "refresh_token": rt, "scope": "https://graph.microsoft.com/.default",
    }).encode()
    url = f"https://login.microsoftonline.com/{tid}/oauth2/v2.0/token"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=30) as r:
            token = json.load(r)["access_token"]
    except urllib.error.HTTPError as e:
        print("TOKEN_FAIL " + e.read().decode()[:180]); sys.exit(1)

try:
    req = urllib.request.Request(
        "https://graph.microsoft.com/v1.0/me/drive/root/children?$top=1",
        headers={"Authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=30) as r:
        json.load(r)
    print("GRAPH_OK")
except urllib.error.HTTPError as e:
    print("GRAPH_FAIL " + str(e.code) + " " + e.read().decode()[:150])
    sys.exit(1)
except Exception as e:
    print("GRAPH_FAIL " + str(e)[:150]); sys.exit(1)
PY
)
  case "$GRAPH_RESULT" in
    GRAPH_OK)  pass "token valid, OneDrive reachable" ;;
    TOKEN_FAIL*) bad "token refresh failed: ${GRAPH_RESULT#TOKEN_FAIL }" ;;
    *)            bad "${GRAPH_RESULT}" ;;
  esac
else
  soft "skipped — credentials incomplete"
fi

# ── 3. vault layout ──────────────────────────────────────────────────────────
head_ "3/6  Vault layout"

if [ -d "$VAULT_DIR" ]; then
  pass "vault directory exists ($VAULT_DIR)"
  for d in sources/_inbox sources/written sources/articles wiki/concepts .meta; do
    if [ -d "$VAULT_DIR/$d" ]; then
      pass "has $d/"
    else
      bad "missing $d/"
    fi
  done
  if [ -f "$VAULT_DIR/AGENTS.md" ]; then
    pass "AGENTS.md contract present"
  else
    bad "AGENTS.md missing — agents need it"
  fi
  if [ -f "$VAULT_DIR/wiki/index.md" ]; then
    pass "wiki/index.md present"
  else
    soft "wiki/index.md missing (linter will flag orphans)"
  fi
else
  bad "vault not found: $VAULT_DIR (run scripts/bootstrap.sh)"
fi

# ── 4. MCP server build ──────────────────────────────────────────────────────
head_ "4/6  OneDrive MCP server"

MCP_DIR="$REPO_DIR/mcp-onedrive"
if [ -d "$MCP_DIR" ]; then
  if [ -d "$MCP_DIR/node_modules" ]; then
    pass "dependencies installed"
  else
    bad "node_modules missing — run 'cd mcp-onedrive && npm install'"
  fi
  if [ -f "$MCP_DIR/dist/index.js" ] || [ -f "$MCP_DIR/dist/server.js" ]; then
    pass "compiled output present (dist/)"
  else
    soft "no dist/ — run 'cd mcp-onedrive && npm run build' (or use bun)"
  fi
else
  bad "mcp-onedrive/ missing"
fi

# ── 5. skills ────────────────────────────────────────────────────────────────
head_ "5/6  Agent skills"

if [ -d "$SKILLS_DIR" ]; then
  for s in second-brain-hj second-brain-query second-brain-ingester second-brain-linter; do
    if [ -f "$SKILLS_DIR/$s/SKILL.md" ]; then
      pass "skill installed: $s"
    else
      bad "skill missing: $s (copy from skills/ into $SKILLS_DIR)"
    fi
  done
else
  bad "skills dir not found: $SKILLS_DIR"
fi

# ── 6. dashboard ─────────────────────────────────────────────────────────────
head_ "6/6  Web dashboard (optional)"

if [ -d "$REPO_DIR/webpage" ]; then
  if [ -d "$REPO_DIR/webpage/node_modules" ]; then
    pass "dashboard dependencies installed"
  else
    soft "dashboard deps not installed (optional: cd webpage && npm install)"
  fi
else
  soft "no webpage/ directory"
fi

# ── summary ──────────────────────────────────────────────────────────────────
printf '\n%s\n' "════════════════════════════════════════════════════════════════"
printf '  %spassed: %d%s   %swarnings: %d%s   %sfailed: %d%s\n' \
  "$G" "$PASS" "$N" "$Y" "$WARN" "$N" "$R" "$FAIL" "$N"
printf '%s\n' "════════════════════════════════════════════════════════════════"

if [ "$FAIL" -eq 0 ]; then
  printf '  %sAll required checks passed.%s\n\n' "$G" "$N"
  exit 0
else
  printf '  %s%d required check(s) failed — see ✗ above.%s\n\n' "$R" "$FAIL" "$N"
  exit 1
fi
