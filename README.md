# Second Brain — Setup Guide

A personal knowledge system built on NanoClaw v2. Three AI agents run on your VPS, connected to an Obsidian vault in OneDrive and accessible via Telegram:

- **Ingester** — polls `OneDrive/Obsidian/sources/_inbox/` every 10 minutes, processes new files, and writes structured wiki pages with citations
- **Query** — answers questions about your vault via Telegram; also accepts voice notes and raw text captures
- **Linter** — runs a daily audit at 3am checking for broken links, orphaned pages, and missing citations

---

## Requirements

- VPS running Ubuntu 22.04+ or Debian (Node 20, Docker, pnpm installed automatically)
- Personal Microsoft account with OneDrive (free 5 GB is enough)
- Telegram account

---

## Step 1 — Register an Azure App

This gives the agents access to your OneDrive. Takes about 10 minutes.

1. Go to [portal.azure.com](https://portal.azure.com) → **App registrations** → **New registration**
2. Name it anything (e.g. `second-brain`)
3. Under **Supported account types**, select:
   > Accounts in any organizational directory AND personal Microsoft accounts
4. Click **Register**
5. Go to **Authentication** → **Add a platform** → **Mobile and desktop applications**
6. Set redirect URI to: `https://login.microsoftonline.com/common/oauth2/nativeclient`
7. Under **Advanced settings**, set **Allow public client flows** to **Yes**
8. Click **Save**
9. Go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated** → add `Files.ReadWrite` and `offline_access`
10. Click **Grant admin consent**

Note down:
- **Application (client) ID** → this is your `MS_CLIENT_ID`
- **Directory (tenant) ID** → use `common` (not the GUID, which locks you to a corporate tenant)

> **Manifest fix (if you get "requestedAccessTokenVersion is invalid"):** Go to **Manifest**, set `"requestedAccessTokenVersion": 2` inside the `"api": {}` block and `"signInAudience": "AzureADandPersonalMicrosoftAccount"` at the top level. Save, then retry.

---

## Step 2 — Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. Copy the **bot token** (looks like `123456789:ABCdef...`) → this is your `TELEGRAM_BOT_TOKEN`

---

## Step 3 — Deploy

SSH into your VPS and run:

```bash
git clone https://github.com/nanocoai/nanoclaw.git second-brain
cd second-brain
bash scripts/deploy-vps.sh
```

The script will:
1. Install Node 20, pnpm, and Docker if missing
2. Add 2 GB swap if RAM < 3 GB (prevents OOM during container build)
3. Prompt for `MS_CLIENT_ID`, `MS_TENANT_ID` (use `common`), and `TELEGRAM_BOT_TOKEN`
4. Build the agent container image (~3–5 min first time)
5. Run NanoClaw base setup (interactive — sets up the service and credentials)
6. Create the ingester, query, and linter agent groups
7. Run OneDrive OAuth — prints a URL and code, open it in any browser and sign in with your **personal** Microsoft account
8. Automatically create the vault folder structure in `OneDrive/Obsidian/`

---

## Step 4 — Fix Docker Networking (required on Linux)

Agent containers reach the OneCLI proxy via `host.docker.internal:10255`, but on Linux that address routes to `172.17.0.1` (Docker bridge) while the proxy only binds to `127.0.0.1`. Without this fix the bot will not respond to any messages.

Run once after deploy:

```bash
sudo sysctl -w net.ipv4.conf.docker0.route_localnet=1
sudo iptables -t nat -I PREROUTING -i docker0 -p tcp --dport 10255 -j DNAT --to-destination 127.0.0.1:10255
```

Make it persistent across reboots:

```bash
echo "net.ipv4.conf.docker0.route_localnet=1" | sudo tee /etc/sysctl.d/99-docker-onecli.conf
sudo apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

Restart the service:

```bash
systemctl --user restart nanoclaw-v2-$(systemctl --user list-units --type=service | grep nanoclaw | awk '{print $1}' | sed 's/nanoclaw-v2-//;s/\.service//')
```

---

## Step 5 — Verify

1. Message your Telegram bot — it should respond within a few seconds
2. Open Obsidian, point it at `OneDrive/Obsidian/` — you should see the full folder structure
3. Drop a file into `sources/_inbox/` in Obsidian
4. Wait up to 10 minutes — check `wiki/log.md` for a new entry

---

## Service Management

Find your service name (includes a unique install ID):

```bash
systemctl --user list-units --type=service | grep nanoclaw
# e.g. nanoclaw-v2-4c2acb66.service
```

```bash
systemctl --user start   nanoclaw-v2-<id>   # start
systemctl --user stop    nanoclaw-v2-<id>   # stop all running instances
systemctl --user restart nanoclaw-v2-<id>   # restart
systemctl --user status  nanoclaw-v2-<id>   # check if running
```

List all running agent containers (one per active session):

```bash
docker ps --filter label=nanoclaw-install --format "table {{.Names}}\t{{.Status}}\t{{.RunningFor}}"
```

View logs:

```bash
journalctl --user -u nanoclaw-v2-<id> -f   # live service logs
tail -f logs/nanoclaw.log                   # full host log
tail -f logs/nanoclaw.error.log             # errors only
```

---

## Re-running Parts of Setup

If setup fails partway, re-run only what you need:

```bash
# Skip prerequisites and container build (already done):
bash scripts/deploy-vps.sh --skip-prereqs --skip-build

# Skip NanoClaw base setup too (already done, just redo OneDrive auth + vault):
SKIP_NANOCLAW_SETUP=1 bash scripts/setup-full.sh

# Just redo OneDrive auth:
set -a && source .env && set +a
pnpm exec tsx scripts/setup-onedrive-auth.ts

# Just redo vault structure creation:
set -a && source .env && set +a
pnpm exec tsx scripts/setup-vault.ts
```

---

## Troubleshooting

**Bot receives messages but never responds**
The Docker networking fix (Step 4) is missing. Apply the iptables rule and restart the service.

**`Device code request failed` during OneDrive auth**
- `AADSTS700016` — app not found in the tenant. Set `MS_TENANT_ID=common` in `.env`.
- `AADSTS50059` — app is single-tenant. In Azure Portal, change Supported account types to include personal Microsoft accounts (or fix via Manifest as described in Step 1).
- `AADSTS50194` — wrong redirect URI. Confirm it is set to `https://login.microsoftonline.com/common/oauth2/nativeclient`.

**`Tenant does not have a SPO license` during vault creation**
You authenticated with a work account that has no OneDrive for Business. Re-run the auth script and sign in with your personal Microsoft account.

**`Property api.requestedAccessTokenVersion is invalid` in Azure Portal**
Edit the app Manifest directly: set `"requestedAccessTokenVersion": 2` inside `"api": {}` and `"signInAudience": "AzureADandPersonalMicrosoftAccount"` at the top level. Save, then retry the portal change.

**Ingester not picking up files**
Check the ingester container logs:
```bash
docker logs $(docker ps --filter label=nanoclaw-install --format "{{.Names}}" | grep ingester) 2>&1 | tail -50
```

**Check what's currently running:**
```bash
systemctl --user list-units --type=service | grep nanoclaw
docker ps --filter label=nanoclaw-install
```
