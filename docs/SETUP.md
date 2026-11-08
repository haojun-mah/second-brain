# Setup

Everything you need to go from a fresh clone to a working second brain. Budget about
**45 minutes** for the OneDrive track (most of it waiting on Azure's UI), **15 minutes**
for GitHub, or **5 minutes** for local.

There are seven steps. Do them in order — each one depends on the last.

## First: pick your storage backend

The vault lives in a *store*. The MCP server abstracts the store, so the same agents and
skills work against any of these. You choose once, via `VAULT_BACKEND` in `.env`.

| Backend | Store | Best for | Credentials | Setup |
|---|---|---|---|---|
| **`onedrive`** (default) | Your OneDrive, via Microsoft Graph | Syncing across devices with Obsidian mobile, editing from Excel/Word | `MS_CLIENT_ID`, `MS_TENANT_ID`, `MS_REFRESH_TOKEN` | ~45 min |
| **`github`** | A GitHub repo | Versioned history of every note, PR review, free, no Azure | `GITHUB_TOKEN`, `GITHUB_VAULT_REPO` | ~15 min |
| **`local`** | A folder on this machine | Trying it out, offline use, single machine, CI | `VAULT_LOCAL_PATH` | ~5 min |

All three support the same eight vault tools, the same `AGENTS.md` contract, and the same
agents. You can switch later by changing `VAULT_BACKEND` and moving your files.

Then follow the seven steps, substituting your backend's credential section for step 1–2:

| Step | What you get | Time |
|---|---|---|
| [1–2. Credentials](#credentials) | Backend credentials (pick one track) | 5–30 min |
| [3. Install the MCP server](#3-install-the-mcp-server) | A working bridge to your vault | 5 min |
| [4. Wire it into Hermes](#4-wire-it-into-hermes) | Agent can call vault tools | 5 min |
| [5. Install the skills](#5-install-the-skills) | The four agents | 2 min |
| [6. Create the vault](#6-create-the-vault) | Folder structure + `AGENTS.md` | 5 min |
| [7. Schedule the agents](#7-schedule-the-agents) | Ingester + linter on cron | 5 min |

---

## Prerequisites check

```bash
node --version      # need >= 18
python3 --version   # need >= 3.10
curl --version
git --version
hermes --version    # Hermes Agent CLI on PATH
```

If Hermes is missing, install it first: <https://hermes-agent.nousresearch.com/docs>

---

<a id="credentials"></a>
## 1–2. Credentials

Set `VAULT_BACKEND` first, then follow **only** the matching track.

```bash
# .env
VAULT_BACKEND=onedrive     # or: github | local
VAULT_ROOT=Obsidian        # folder inside the store that holds the vault
```

> **Local backend:** `VAULT_ROOT` is ignored — `VAULT_LOCAL_PATH` points straight at the
> vault folder.

---

### Track A — OneDrive (default)

#### 1. Azure app registration

The MCP server authenticates as *you* against Microsoft Graph. That requires an app
registration — a free, self-owned identity in Microsoft Entra ID. You are not registering
for a service or paying anyone; you're creating a client ID that Microsoft lets you use to
talk to your own drive.

> **Use a dedicated app.** Don't reuse an app registration from another project. If this
> one leaks you revoke it without breaking anything else.

### 1.1 Create the app

1. Go to <https://portal.azure.com> and sign in with the Microsoft account that owns your
   OneDrive.
2. Search for **Microsoft Entra ID** in the top bar and open it.
3. Left sidebar → **App registrations** → **+ New registration**.
4. Fill in:
   - **Name**: `second-brain-mcp` (anything you like)
   - **Supported account types**:
     - *"Accounts in this organizational directory only"* for a work/school account
     - *"Personal Microsoft accounts only"* if you use a personal outlook/hotmail/live account
     - *"Accounts in any organizational directory and personal Microsoft accounts"* if unsure
   - **Redirect URI**: choose **Public client/native (mobile & desktop)** from the dropdown,
     and enter exactly:
     ```
     http://localhost:8080/callback
     ```
5. Click **Register**.

### 1.2 Copy the two IDs

On the app's **Overview** page:

- **Application (client) ID** → this is `MS_CLIENT_ID`
- **Directory (tenant) ID** → this is `MS_TENANT_ID`

> If you chose "personal Microsoft accounts only", set `MS_TENANT_ID=consumers`.
> If you chose the multi-tenant option, `MS_TENANT_ID=common` is simplest.
> Otherwise paste the actual GUID.

### 1.3 Enable public client flows

Device-code login needs this, and it's off by default.

1. In your app, left sidebar → **Authentication**.
2. Scroll to **Advanced settings** → **Allow public client flows**.
3. Toggle to **Yes**.
4. **Save**.

### 1.4 Add the API permission

1. Left sidebar → **API permissions** → **+ Add a permission**.
2. Choose **Microsoft Graph**.
3. Choose **Delegated permissions**.
4. Search for and tick:
   - `Files.ReadWrite` — read and write files in your drive
   - `offline_access` — required to receive a refresh token
   - `User.Read` — read your basic profile (needed to resolve `/me`)
5. **Add permissions**.

These are *delegated* permissions, meaning the app acts as you and can only reach files you
can reach. It cannot see other people's drives. No admin consent is required for personal
accounts; some work tenants require an admin to click **Grant admin consent** — if the
device login later fails with `AADSTS65001`, that's what's missing.

---

## 2. Capture a refresh token

This is the part people get stuck on, so here is exactly what happens and why.

OAuth has two tokens. An **access token** is short-lived (about an hour) and is what you
actually send with each API call. A **refresh token** is long-lived and is what you exchange
for new access tokens. The MCP server stores only the refresh token and mints access tokens
on demand — that's why you only do this dance once.

The flow is *device code*: you ask Microsoft for a short code, type it into a browser page,
sign in, and Microsoft hands your terminal a refresh token. No redirect server, no copying
anything out of a URL bar.

### Run the helper

From the repository root, with your `.env` already containing the client ID:

```bash
python3 scripts/get_refresh_token.py
```

The script reads `MS_CLIENT_ID` and `MS_TENANT_ID` from `.env` (or from the environment),
prints:

```
To sign in, open https://microsoft.com/devicelogin and enter the code: F7GK2QPLM
Waiting for you to authenticate...
```

Open that URL in any browser — phone is fine — type the code, sign in with the account that
owns your OneDrive, and accept the consent screen (it will list "Read and write user files").

The script prints:

```
✓ Refresh token captured (1467 chars)

MS_REFRESH_TOKEN=0.AXoA...
```

### Save it

Copy that value into `.env`:

```bash
MS_REFRESH_TOKEN=0.AXoA...
```

Then lock the file down:

```bash
chmod 600 .env
```

### If it fails

| Error | Cause | Fix |
|---|---|---|
| `AADSTS7000218` | Public client flows disabled | Redo step 1.3 |
| `AADSTS65001` | Consent not granted | Re-run; on a work tenant ask an admin to grant consent |
| `AADSTS50020` | Signed in with the wrong account | Use the account that owns the drive |
| `authorization_pending` forever | You didn't finish the browser step | Re-run and complete it within 15 min |
| `invalid_grant` later, on every call | Refresh token expired or was revoked | Re-run step 2. See [docs/CREDENTIALS.md](CREDENTIALS.md#rotation) |

### Manual fallback

If you'd rather not run the script, the equivalent by hand is:

```bash
# 1. request a device code
curl -s -X POST \
  "https://login.microsoftonline.com/$MS_TENANT_ID/oauth2/v2.0/devicecode" \
  -d "client_id=$MS_CLIENT_ID" \
  -d "scope=Files.ReadWrite offline_access User.Read" | tee /tmp/dc.json

# 2. open the verification_uri from that JSON, enter the user_code, sign in
# 3. poll for the token (repeat every few seconds until it stops saying authorization_pending)
curl -s -X POST \
  "https://login.microsoftonline.com/$MS_TENANT_ID/oauth2/v2.0/token" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code" \
  -d "client_id=$MS_CLIENT_ID" \
  -d "device_code=$(python3 -c 'import json;print(json.load(open("/tmp/dc.json"))["device_code"])')"
```

The `refresh_token` field in the final response is your `MS_REFRESH_TOKEN`.

---

### Track B — GitHub (~15 min)

A GitHub repo is a perfectly good vault store: free, versioned, and every ingester run
becomes a commit you can review or revert. No Azure, no OAuth dance.

#### 1. Create the vault repo

Create a **private** repository (e.g. `yourname/second-brain-vault`). It can be empty —
the server creates files as the agents write them.

```bash
# optional, but gives you a local copy to browse in Obsidian
git clone git@github.com:yourname/second-brain-vault.git
```

#### 2. Mint a token

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens**
2. Use **Fine-grained tokens** → *Generate new token*
3. **Repository access:** *Only select repositories* → pick your vault repo
4. **Permissions:** *Contents* → **Read and write**
   (add *Metadata: read* — GitHub selects it automatically)
5. Generate and copy the token once — it is not shown again

> A classic token with the single `repo` scope also works, but is broader than needed.
> Fine-grained scoped to one repo is the safer choice.

#### 3. Set the env

```bash
# .env
VAULT_BACKEND=github
GITHUB_TOKEN=github_pat_...           # the token from step 2
GITHUB_VAULT_REPO=yourname/second-brain-vault
GITHUB_VAULT_BRANCH=main              # optional, defaults to main
VAULT_ROOT=                           # leave empty to use the repo root as the vault
```

> Unlike OneDrive, the GitHub backend treats the **repo root as the vault root** when
> `VAULT_ROOT` is empty. Set `VAULT_ROOT=Obsidian` only if your vault lives in a
> subfolder of the repo.

#### Notes and limits

- **Every write is one API call and one commit.** The ingester writing 5 notes = 5 commits.
  That is a feature (auditable history) but worth knowing before a large backfill.
- **Rate limits:** 5,000 requests/hour authenticated — ample for a personal vault.
- **`search` is a grep over the tree**, capped at ~200 files / 2 MB per file per call. On a
  very large vault prefer `list_directory` plus targeted `read_note`.
- **`get_changes`** returns a commit SHA; passing it back reports what changed since.

---

### Track C — Local folder (~5 min)

Simplest option, nothing to authenticate. Great for evaluating the system, for offline use,
or for CI.

```bash
# .env
VAULT_BACKEND=local
VAULT_LOCAL_PATH=/home/you/SecondBrainVault
```

That's it — create the folder (step 6 does it for you) and skip to
[3. Install the MCP server](#3-install-the-mcp-server).

**Trade-offs:** no automatic sync between machines and no off-device backup. Point
`VAULT_LOCAL_PATH` at a Dropbox/iCloud/Syncthing folder if you want sync, or at a git
working copy if you want history.

---

## 3. Install the MCP server

The MCP server is a small TypeScript program. It reads JSON-RPC over stdin/stdout, so it
has no port, no daemon, and no network listener — Hermes spawns it as a child process.

```bash
cd mcp-vault
npm install --no-audit --no-fund
npm run build          # tsc → dist/
```

Verify it compiled:

```bash
node dist/index.js
```

It will print to stderr and then wait for input:

```
[onedrive] MCP server started with 8 tools: read_note, write_note, append_note, ...
```

Press `Ctrl+C`. That's a healthy server.

> **Using bun instead?** `bun install && bun run src/index.ts` works too. The TypeScript
> source has no Node-specific dependencies beyond `fetch`, which bun provides.

### Quick smoke test of your credentials

Before involving Hermes, prove the token works:

```bash
./scripts/healthcheck.sh
```

It exchanges the refresh token for an access token, resolves the vault root folder, lists
your top-level directories, and reports what it found. If this passes, everything
downstream will work.

---

## 4. Wire it into Hermes

Hermes finds MCP servers in its `config.yaml`. The default location is
`~/.hermes/config.yaml`.

Add this block (merge it into the existing `mcp_servers:` key if you already have one):

```yaml
mcp_servers:
  vault:
    command: node
    args:
      - /absolute/path/to/second-brain/mcp-vault/dist/index.js
    env:
      VAULT_BACKEND: "onedrive"        # onedrive | github | local
      VAULT_ROOT: "Obsidian"
      MS_CLIENT_ID: "${MS_CLIENT_ID}"
      MS_TENANT_ID: "${MS_TENANT_ID}"
      MS_REFRESH_TOKEN: "${MS_REFRESH_TOKEN}"
    timeout: 60
```

Replace the path with the real absolute path on your machine (`pwd` inside `mcp-vault`,
then append `/dist/index.js`).

**Only the keys for your backend are needed.** The three variants:

```yaml
# GitHub
    env:
      VAULT_BACKEND: "github"
      VAULT_ROOT: ""                   # repo root is the vault
      GITHUB_TOKEN: "${GITHUB_TOKEN}"
      GITHUB_VAULT_REPO: "yourname/second-brain-vault"
      GITHUB_VAULT_BRANCH: "main"
```

```yaml
# Local
    env:
      VAULT_BACKEND: "local"
      VAULT_LOCAL_PATH: "/home/you/SecondBrainVault"
```

> Values are read from the environment, so keep the real secrets in
> `~/.hermes/.env` (or export them) rather than pasting them into `config.yaml`.
> The server fails fast at startup naming the exact variable that is missing.

### About the env block

`"${VAR}"` is expanded by Hermes from its own environment. That means the secrets live in
`.env`, not in `config.yaml` — so `config.yaml` stays safe to commit or share.

Make sure `.env` is actually loaded into Hermes's environment. The simplest way is to put
the three variables in `~/.hermes/.env`, which Hermes sources at startup:

```bash
grep '^MS_' .env >> ~/.hermes/.env
chmod 600 ~/.hermes/.env
```

### Verify the wiring

```bash
hermes mcp list          # should show "onedrive" with 8 tools
```

Or just start Hermes and ask:

```
list the contents of sources/_inbox
```

The agent should call `mcp_vault_list_directory`. If it says it has no such tool, the
`mcp_servers` block didn't parse — check your YAML indentation. If it errors with
`Token refresh failed (400)`, your refresh token is bad; redo step 2.

Full Hermes MCP documentation: <https://hermes-agent.nousresearch.com/docs>

---

## 5. Install the skills

Skills are how Hermes agents get their behaviour. Four directories, copied into your
skills folder:

```bash
mkdir -p ~/.hermes/skills/second-brain
cp -r skills/second-brain-* ~/.hermes/skills/second-brain/
```

Confirm Hermes sees them:

```bash
hermes skills list
```

Expected:

```
second-brain-hj          HJ orchestrator agent for the second-brain system...
second-brain-ingester    Ingester agent for the second-brain vault...
second-brain-linter      Linter agent for the second-brain vault...
second-brain-query       Query agent for the second-brain Obsidian vault...
```

### Optional: OCR support

The ingester reads screenshots by downloading them from the vault and running RapidOCR
locally. That needs its own virtualenv:

```bash
python3 -m venv "$HOME/.second-brain/ocrvenv"
"$HOME/.second-brain/ocrvenv/bin/pip" install rapidocr-onnxruntime
```

Then set in `.env`:

```bash
SECOND_BRAIN_OCR_VENV=$HOME/.second-brain/ocrvenv
```

Skip this if you never drop images. The ingester degrades gracefully — it logs the failure
and keeps the `![[...]]` embed intact.

---

## 6. Create the vault

The vault is a folder in your OneDrive. Two ways to make it; pick one.

### Option A — Obsidian (recommended)

1. Open Obsidian → **Create new vault**.
2. Name it `Obsidian`.
3. Set the location to the **root of your OneDrive folder** on disk, so the path is:
   - macOS: `~/Library/CloudStorage/OneDrive-Personal/Obsidian`
   - Windows: `C:\Users\you\OneDrive\Obsidian`
   - Linux: wherever your OneDrive client mounts
4. Once created, copy the scaffold in:

```bash
cp -r vault-template/* "/path/to/your/OneDrive/Obsidian/"
```

5. In Obsidian settings → **Files & Links**, set:
   - **Default location for new attachments** → *In the folder specified below* →
     `sources/assets`
   - **New link format** → *Shortest path when possible*

That attachment setting matters: the agents expect pasted images to land in
`sources/assets/` so they can resolve `![[Pasted image ...png]]` embeds. If yours land
elsewhere, rewrite the path to `sources/assets/` in the image handling section of the
ingester skill.

### Option B — upload through Graph

If you don't want a local OneDrive client at all:

```bash
python3 scripts/init_vault.py --upload
```

This walks `vault-template/` and creates every folder and file in your drive via the Graph
API, including empty directories (Graph can't create empty folders, so it writes a
`.gitkeep` placeholder into each and leaves it there — harmless).

### What you should end up with

```
OneDrive/Obsidian/
├── AGENTS.md
├── sources/
│   ├── _inbox/          ← the drop zone
│   ├── written/         ← paper trail of everything you typed
│   ├── articles/  concepts/  coding/  conversations/
│   ├── voice-notes/  books/  drafts/
│   └── assets/          ← images
├── wiki/
│   ├── index.md         ← master catalog
│   ├── log.md           ← append-only history
│   └── concepts/ people/ projects/ questions/ syntheses/ articles/ coding-interview/
└── .meta/               ← agent bookkeeping
```

### Verify

```bash
./scripts/healthcheck.sh
```

It checks that every required folder exists, that `AGENTS.md` is present, and that the
wiki index and log have the expected shape.

> **Important:** the template folders ship with `.gitkeep` files so git can track them.
> Graph will list those as files. Delete them once your vault is set up if they bother you —
> nothing depends on them.

---

## 7. Schedule the agents

Two recurring jobs. The ingester is the important one; the linter is housekeeping.

### Ingester — every 30 minutes

```bash
hermes cron add \
  --name "second-brain-ingest" \
  --schedule "*/30 * * * *" \
  --skill second-brain-ingester \
  --prompt "Run the ingest cycle. Follow the polling flow in the skill: check the inbox listing and the delta feed, short-circuit to IDLE if both are empty, otherwise read AGENTS.md and process every unprocessed file through the full procedure. End with a one-line summary of what was ingested, or the word IDLE."
```

### Linter — weekly, Sunday 03:00

```bash
hermes cron add \
  --name "second-brain-lint" \
  --schedule "0 3 * * 0" \
  --skill second-brain-linter \
  --prompt "Run the weekly lint. Read AGENTS.md first, then .meta/last_lint.json and the most recent file in wiki/questions/ for the carry-forward baseline. Run all ten checks, apply only the unambiguous auto-fixes, file questions for everything else, append the log entry, and write .meta/last_lint.json."
```

Adjust `--schedule` if you want a different cadence. Cron uses the host's local timezone.

### Verify

```bash
hermes cron list
```

You should see both jobs with `enabled: true` and a `next_run` in the future.

> **Watch `last_status`, not `enabled`.** A job can show `enabled: true, state: scheduled`
> while failing on every run — an expired provider key or a drained account balance does
> exactly this. Check `last_status` after the first couple of runs.

### Manual test run

Don't wait 30 minutes to find out it's broken:

```bash
hermes cron run second-brain-ingest
```

Then drop a file in `sources/_inbox/` and run it again. You should see a new wiki page, a
new `wiki/log.md` entry, and an entry in `.meta/processed.json`.

---

## Troubleshooting

**`Error 401` / `InvalidAuthenticationToken` on every Graph call**
The access token is bad. 99% of the time the refresh token is stale or was issued for a
different client ID. Re-run step 2. If you recently changed `MS_CLIENT_ID`, the old refresh
token is invalid — tokens are bound to the client that minted them.

**`Error 404` on a path you know exists**
Vault paths are relative to the *vault root*, not the drive root. `read_note("wiki/index.md")`
is correct; `read_note("Obsidian/wiki/index.md")` is not.

**`move_file` returns `400 invalidRequest`**
OneDrive's move API requires the destination folder to already exist. Create it first by
writing a placeholder file into it (`write_note("sources/newfolder/.keep", "x")`), then move,
then delete the placeholder.

**`get_changes` returns `400 Invalid version`**
Your delta token expired. Run
`python3 skills/second-brain-ingester/scripts/rotate_delta_token.py`. The ingester falls back
to directory listing on its own, so this is not urgent.

**Agent says it has no `mcp_vault_*` tools**
The `mcp_servers` block isn't being read. Check YAML indentation (two spaces, under the
top-level key), then `hermes mcp list`.

**Wiki pages write to the local filesystem instead of OneDrive**
Something used `write_file` on a vault path. Vault I/O must go through `mcp_vault_*`
tools only — the local tools resolve against your machine's filesystem. The skills call this
out explicitly; if you're writing your own skill, do the same.

**`tsc` errors about missing types**
Run `npm install` inside `mcp-vault/` first. The `@types/bun` package provides the
ambient types for `fetch` and the top-level `await` in `index.ts`.

---

## Next steps

- Read [ARCHITECTURE.md](ARCHITECTURE.md) to understand the agent contracts before you
  modify them.
- Read [CREDENTIALS.md](CREDENTIALS.md) before you put this on a server.
- Try the web dashboard: [webpage/README.md](../webpage/README.md).
