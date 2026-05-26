# Second Brain — VPS Deployment and First-Run Guide

Step-by-step checklist for setting up the complete second-brain system on a fresh VPS. Follow steps in order. Each step includes an estimated time.

---

## Prerequisites

Before starting, confirm you have:

- **VPS**: 4 GB RAM, 2 vCPU, Ubuntu 22.04 — Hetzner CX22 or equivalent (~$7/month)
- **Docker + Docker Compose** installed (`docker --version`, `docker compose version`)
- **Git** installed (`git --version`)
- **Tailscale** installed (optional but recommended for secure remote access without exposing ports)
- **Anthropic API key** (`sk-ant-...`)
- **Microsoft account** with OneDrive (personal or Microsoft 365)
- **Telegram account** (for the query interface)

---

## Step 1: Azure App Registration (5 min)

The ingester reads and writes OneDrive files via the Microsoft Graph API. You need an app registration to get OAuth credentials.

1. Go to https://portal.azure.com and sign in with your Microsoft account.
2. Navigate to **Azure Active Directory** → **App registrations** → **New registration**.
3. Fill in:
   - Name: `nanoclaw-second-brain`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**
   - Redirect URI: choose **Public client/native (mobile & desktop)** and enter `http://localhost`
4. Click **Register**.
5. In the app overview, note down:
   - **Application (client) ID** — you will need this as `MS_CLIENT_ID`
   - **Directory (tenant) ID** — you will need this as `MS_TENANT_ID`
6. Navigate to **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**.
7. Search and add both:
   - `Files.ReadWrite`
   - `offline_access`
8. Click **Grant admin consent** (required for `offline_access` to work with personal accounts).

---

## Step 2: Create Vault Structure in OneDrive (5 min)

Do this from your desktop using Obsidian or the OneDrive web interface.

1. Copy `docs/second-brain-vault-claude.md` from this repo to `Obsidian/CLAUDE.md` in OneDrive. This is the instruction file all agents read.
2. Create the following folders inside `Obsidian/`:
   ```
   sources/_inbox/
   sources/articles/
   sources/voice-notes/
   sources/conversations/
   sources/books/
   sources/drafts/
   wiki/concepts/
   wiki/people/
   wiki/projects/
   wiki/questions/
   wiki/syntheses/
   .meta/
   ```
3. Create `wiki/index.md` with this content:
   ```markdown
   # Knowledge Index

   (populated by ingester)
   ```
4. Create `wiki/log.md` with this content:
   ```markdown
   # Change Log

   (populated by ingester)
   ```
5. Create `.meta/processed.json` with this content:
   ```json
   {"processed":[]}
   ```

OneDrive syncs automatically. The VPS will access these files via the Graph API — no sync client needed on the server.

---

## Step 3: Clone and Configure (10 min)

SSH into your VPS and run:

```bash
git clone https://github.com/YOUR_USERNAME/nanoclaw.git /home/user/nanoclaw
cd /home/user/nanoclaw
cp .env.example .env
```

Edit `.env` and fill in the required values:

```bash
ANTHROPIC_API_KEY=sk-ant-...
MS_CLIENT_ID=<Application (client) ID from Step 1>
MS_TENANT_ID=<Directory (tenant) ID from Step 1>
```

Leave other values at their defaults for now. You will return to `.env` during `/setup` if additional configuration is needed.

---

## Step 4: Build the Container Image (3-5 min)

```bash
./container/build.sh
```

This builds the `nanoclaw-agent:latest` Docker image. The build installs the OneDrive MCP server and other dependencies into the image. First build takes 3-5 minutes; subsequent builds use the layer cache and are faster.

If the build fails, check that Docker is running (`docker info`) and that you have internet access from the VPS.

---

## Step 5: Run NanoClaw Setup

Start the NanoClaw host service:

```bash
systemctl --user start nanoclaw
```

Then, inside Claude Code on the VPS, run the setup skill:

```
/setup
```

Follow the interactive prompts. The `/setup` skill will:
- Install and configure OneCLI (the credential vault)
- Verify Docker is working
- Create the first admin user record in the central DB
- Confirm the service is healthy

If you are running Claude Code remotely over SSH, make sure your terminal is attached (not detached via tmux/screen) when you run `/setup` — some steps require interactive input.

---

## Step 6: Authenticate with OneDrive (5 min)

```bash
pnpm exec tsx scripts/setup-onedrive-auth.ts
```

This script initiates a device code flow:
1. It prints a URL and a short code.
2. Open the URL in your browser (any device — it does not need to be the VPS).
3. Enter the code and sign in with the Microsoft account from Step 1.
4. Grant the permissions listed (`Files.ReadWrite`, `offline_access`).
5. Return to the terminal — the script will print `Authentication successful` and store the refresh token in OneCLI.

The refresh token is stored encrypted in the OneCLI vault and injected into agent containers at request time. Raw credentials are never written to `.env` or the central DB.

If authentication fails, verify that the `MS_CLIENT_ID` and `MS_TENANT_ID` values in `.env` match what you noted in Step 1, and that admin consent was granted in the Azure portal.

---

## Step 7: Create the Second-Brain Agent Groups (5 min)

```bash
pnpm exec tsx scripts/setup-second-brain.ts
```

This script creates three agent groups in the central DB:

| Group | Model | Purpose |
|---|---|---|
| `ingester` | claude-sonnet-4-5 | Polls inbox, processes source files, writes wiki |
| `query` | claude-opus-4-5 | Answers user questions via Telegram |
| `linter` | claude-haiku-4-5 | Checks vault integrity on a daily schedule |

It also wires the OneDrive MCP server into the ingester and query containers, and sets the `CLAUDE.md` path for each group to point to the vault's `CLAUDE.md`.

After this step, verify the groups were created:

```bash
ncl groups list
```

You should see `ingester`, `query`, and `linter` in the output.

---

## Step 8: Add Telegram

In Claude Code:

```
/add-telegram
```

Follow the prompts to:
- Create a Telegram bot via BotFather and paste the token.
- Wire the bot credentials into OneCLI.

Then wire the Telegram channel to the query agent:

```
/manage-channels
```

When prompted, select the Telegram messaging group and wire it to the `query` agent group. Use `shared` isolation (one session per user).

---

## Step 9: Bootstrap the Ingester

The ingester uses NanoClaw's recurrence system to self-schedule. It needs one initial trigger to start the loop.

```bash
pnpm exec tsx scripts/trigger-internal.ts --group ingester
```

The ingester will wake, poll `sources/_inbox/`, process any files found, and then schedule itself to run again in 10 minutes.

Note: this bootstrap step will be replaced by an automatic first-run trigger in a future update. For now the manual trigger is required once after initial setup.

---

## Step 10: Verify

1. From Obsidian on your desktop, create a test file at `sources/_inbox/test-note.md`:
   ```markdown
   # Test Note

   This is a test source file dropped into the inbox.
   The concept of note-taking as a second brain is explored by Tiago Forte in Building a Second Brain.
   ```
2. Wait up to 10 minutes for the ingester to poll OneDrive.
3. Open `wiki/log.md` in Obsidian — you should see a new log entry recording the processed file and any wiki pages created.
4. Open `wiki/index.md` — the ingester should have added an entry for any concept it extracted.
5. Send a message to your Telegram bot:
   ```
   What do you know about note-taking?
   ```
   The query agent should respond with a summary and cite the wiki page and source file.

If step 3 shows no log entry after 15 minutes, proceed to the Troubleshooting section.

---

## Troubleshooting

| Symptom | What to check |
|---|---|
| Ingester not running after 10 min | Check `logs/nanoclaw.log` — is the ingester session being woken? Check `logs/nanoclaw.error.log` for delivery failures. |
| OneDrive auth fails at Step 6 | Confirm `MS_CLIENT_ID` and `MS_TENANT_ID` are correct in `.env`. Re-run `pnpm exec tsx scripts/setup-onedrive-auth.ts`. |
| Telegram bot not responding | Run `/debug` in Claude Code. Check that the Telegram messaging group is wired to the `query` agent group via `ncl wirings list`. |
| Wiki not updating despite inbox file | Check `.meta/processed.json` — was the file already marked as processed from a previous partial run? If so, remove the entry and re-trigger. |
| Agent gets 401 from OneDrive | The OneCLI agent may be in `selective` secret mode with no secrets assigned. Run `onecli agents list` to find the agent ID, then `onecli agents set-secret-mode --id <id> --mode all`. |
| Container starts but crashes immediately | Check `logs/nanoclaw.error.log`. If the error mentions `CLAUDE.md not found`, verify the vault path is correctly set in the agent group config: `ncl groups get --id ingester`. |

---

## Cost Reference

| Item | Estimated cost |
|---|---|
| VPS (Hetzner CX22, 4 GB / 2 vCPU) | ~$7/month |
| VPS (Hetzner CX32, 8 GB / 4 vCPU, if needed) | ~$14/month |
| Anthropic API (personal usage, light) | ~$5-15/month |
| Anthropic API (personal usage, heavy) | ~$15-30/month |
| OneDrive storage | Included in existing Microsoft 365 subscription |
| Tailscale | Free tier sufficient for personal use |
| Azure App Registration | Free |

Total typical cost: **$12-25/month** for VPS + API combined.

The ingester uses `claude-haiku-4-5` for classification steps and `claude-sonnet-4-5` for wiki writing to balance cost and quality. You can adjust the model per agent group via `ncl groups config update`.
