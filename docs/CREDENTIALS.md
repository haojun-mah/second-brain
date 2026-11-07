# Credentials

Every credential this system needs, how to obtain it, and how to keep it safe.

**Read this before putting the system on a server.** The default setup assumes a machine you
control. Running it on a shared or public host changes the threat model, and the last section
covers what to change.

---

## Summary

| Credential | Required | Grants | Where it lives | Rotation |
|---|---|---|---|---|
| `MS_CLIENT_ID` | Yes | Identifies your app | `.env`, `~/.hermes/.env` | Not secret; rotate only if you delete the app |
| `MS_TENANT_ID` | Yes | Which directory to authenticate against | `.env` | Not secret |
| `MS_REFRESH_TOKEN` | Yes | **Read/write to your entire OneDrive** | `.env`, `~/.hermes/.env` | **Yes — treat as a password** |
| `BRAIN_PASSWORD` | Dashboard only | Access to the read-only web view | `.env` → `auth.json` | Yes, periodically |
| `GROQ_API_KEY` | Voice notes only | Transcription API calls | `.env` | Yes |
| `TELEGRAM_OWNER_ID` | Telegram only | Not a secret — an allowlist | `.env` | n/a |

Only `MS_REFRESH_TOKEN` and `BRAIN_PASSWORD` are genuine secrets. The client and tenant IDs
appear in every OAuth URL and are not sensitive on their own — but keep them out of public
repos anyway, because knowing them narrows an attacker's search.

---

## Microsoft Graph credentials

### `MS_CLIENT_ID` and `MS_TENANT_ID`

Both come from the app registration in [SETUP.md step 1](SETUP.md#1-azure-app-registration).

- **Application (client) ID** → `MS_CLIENT_ID`. A GUID like
  `00000000-0000-0000-0000-000000000000`.
- **Directory (tenant) ID** → `MS_TENANT_ID`. A GUID, or one of the aliases:
  - `common` — any work, school, or personal account (multi-tenant + personal)
  - `consumers` — personal Microsoft accounts only
  - `organizations` — work/school accounts only

If you're unsure which to use, `common` works in almost every case. It costs one extra
redirect during login and resolves to your actual tenant automatically.

**These are not secrets in the cryptographic sense.** A client ID for a public/native app is
visible to anyone who inspects the traffic. What protects your data is the combination of the
refresh token and the fact that your app registration has no client secret — there's nothing
for an attacker to brute-force. Still, don't publish them: a leaked client ID plus a leaked
refresh token is a full compromise, and publishing one half makes the other half more
valuable.

### `MS_REFRESH_TOKEN`

**This is the crown jewel.** It is a bearer credential that grants read and write access to
every file in your OneDrive, for as long as it remains valid. Anyone who has it can read,
modify, or delete your entire drive without any further authentication. Treat it exactly like
a password to your Microsoft account, because functionally it is one — scoped to files, but
with no second factor.

Obtain it via `python3 scripts/get_refresh_token.py` as described in
[SETUP.md step 2](SETUP.md#2-capture-a-refresh-token).

#### Lifetime and rotation

<a name="rotation"></a>

Refresh tokens for personal Microsoft accounts are long-lived — commonly around 90 days of
inactivity, and they're replaced (rolled) each time one is used. Because the MCP server
exchanges the token for a new access token on a regular basis, an actively-used token keeps
rolling forward indefinitely.

You'll know it's dead when every Graph call returns:

```
Token refresh failed (400): {"error":"invalid_grant","error_description":"AADSTS700082: The refresh token has expired..."}
```

The fix is to re-run `scripts/get_refresh_token.py` and update `.env`. Plan for this
occasionally; it's not a bug.

**Rotate deliberately when:**

- You suspect the token was exposed (committed to git, pasted into a chat, included in a
  screenshot or log).
- A machine that held it is lost, sold, or decommissioned.
- Someone else had access to the machine.
- You're changing hosting providers.

**How to rotate:** re-run the device-code flow to get a new token, replace `MS_REFRESH_TOKEN`
everywhere it appears (`.env`, `~/.hermes/.env`, any server's environment), restart the MCP
server and any scheduled jobs. The old token becomes useless as soon as Microsoft issues a
new one for the same client — the old one is invalidated by the roll.

**If a token leaks, do this now, in this order:**

1. **Revoke the app's access.** Go to <https://account.live.com/consent/Manage> (personal
   accounts) or your organisation's
   [Enterprise applications](https://portal.azure.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AppAppsPreview)
   page (work accounts), find your app, and remove it. This kills every token issued to it,
   immediately.
2. **Check for damage.** Look at your OneDrive's version history and recent activity.
   Deleted files sit in the recycle bin for 30 days by default.
3. **Rotate.** Re-register or re-consent, capture a fresh token, replace it everywhere.
4. **Find the leak.** `git log -S "MS_REFRESH_TOKEN" --all` in every repo that touched it. If
   it was ever committed, assume it's public — GitHub indexes history aggressively, and forks
   and caches outlive the deletion.

Step 1 is the one that actually stops the bleeding. Rotating alone doesn't help if the
attacker already has a valid token and you haven't revoked it — Microsoft's roll may leave
both valid until one expires.

#### Least privilege

The app requests `Files.ReadWrite`, which is the whole drive. Microsoft Graph does not offer
a narrower delegated scope that covers "one folder" — `Files.ReadWrite.AppFolder` exists but
restricts you to a special app folder that Obsidian can't see. So the practical mitigation
isn't a narrower scope, it's a narrower *account*:

**Use a dedicated Microsoft account for your brain.** A free outlook.com account with nothing
else in it. Then a leaked token exposes your notes (bad) rather than your notes, your email,
your calendar, and your saved payment methods (much worse). This is the single highest-value
security decision in the whole setup, and it costs nothing.

If you already use a personal account and don't want to split, at minimum verify that the app
registration has **no client secret** configured (Authentication → Certificates & secrets
should be empty). A public client with no secret can't be impersonated by someone who only
knows the client ID.

#### Where the token must never go

- **Not in git.** `.gitignore` covers `.env`, `auth.json`, and `shares.json`. Verify with
  `git status --ignored` before your first push.
- **Not in `config.yaml`.** Use `"${MS_REFRESH_TOKEN}"` and let Hermes expand it from the
  environment. The block in [SETUP.md step 4](SETUP.md#4-wire-it-into-hermes) does this.
- **Not in a shell history.** `export MS_REFRESH_TOKEN=...` on the command line writes it to
  `~/.bash_history`. Use `.env` and `set -a && source .env && set +a`.
- **Not in logs.** The helper scripts print `UPLOAD_OK <etag>` and `DELTA_TOKEN_SAVED <etag>`
  — never the token. If you write your own script, don't print the token, and don't pass it
  as a command-line argument (it's visible in `ps` to every user on the box).
- **Not in a prompt.** Don't paste it into a chat with an agent. The agents read it from the
  environment via the MCP server; they never need to see the value.

#### File permissions

```bash
chmod 600 .env
chmod 700 ~/.hermes
chmod 600 ~/.hermes/.env
```

`600` means owner-read-write only. On a single-user machine that's sufficient. On a shared
host, also check that your home directory isn't world-readable (`chmod 750 ~`).

---

## Dashboard credentials

### `BRAIN_PASSWORD`

The web dashboard serves your entire wiki. It sits behind a password gate with:

- HMAC-SHA256 signed session cookies (7-day expiry)
- Per-IP rate limiting (5 failures → 15-minute lockout)
- Constant-time password comparison

It is a **read-only** view — there's no write path, no upload, no API that mutates the vault.
That reduces the blast radius of a compromise from "attacker edits your notes" to "attacker
reads your notes", which is still bad but recoverable.

Generate a strong one:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(24))"
```

Then create the auth file:

```bash
cd webpage && python3 sync/make_auth.py "$BRAIN_PASSWORD"
```

This writes `auth.json` containing the password and a random session-signing secret, with
mode `600`. **`auth.json` is gitignored and must never be committed.**

Changing the password invalidates all existing sessions, because the signing secret is
regenerated. That's the intended way to log everyone out.

### Exposure

The default bind is `::` on port 8741 — reachable from your network. Two acceptable
postures:

**Local only.** Set `BRAIN_BIND=127.0.0.1` and access it over an SSH tunnel or Tailscale.
No public exposure, no TLS to worry about.

**Public, behind a reverse proxy.** Put Caddy or nginx in front, terminate TLS there, and
forward to `127.0.0.1:8741`. Set `BRAIN_PUBLIC_URL=https://your.domain` so share links are
minted with the right host. The built-in server speaks plain HTTP — do not expose it directly
to the internet.

If you do expose it publicly:

- Use a long random password (24+ chars). There's no username, no 2FA, no account recovery.
- Consider putting the whole thing behind your proxy's basic auth as a second layer.
- Set `BRAIN_BIND=127.0.0.1` so the only path in is through the proxy.
- Watch the logs for repeated 401s — that's someone guessing.

### Share links

The dashboard can mint per-note share links (`/s/<token>`) that expose exactly one page,
read-only, with no session cookie — the recipient can't browse anything else. Tokens are
32-byte URL-safe random strings, stored in `shares.json`, and revocation is immediate
(the file is read fresh on each request).

`shares.json` is gitignored. It contains no secrets beyond the tokens themselves, but a valid
token *is* access to that note, so treat the file as sensitive and delete stale entries.

---

## Optional credentials

### `GROQ_API_KEY`

Used only by `scripts/audio_transcriber.js` to turn voice memos into text via Whisper. Get
one at <https://console.groq.com/keys>. Free tier is generous enough for personal use.

Skip it entirely if you don't send voice notes. Nothing else depends on it.

The transcriber sends audio to Groq's API. If your voice notes contain anything you wouldn't
send to a third party, don't enable this — type the note instead, or run a local Whisper
model and swap the transcription call.

### `TELEGRAM_OWNER_ID`

Not a credential — an allowlist. If you drive the orchestrator from Telegram, set this to
your numeric Telegram user ID so the bot only responds to you. Without it, anyone who finds
your bot can talk to your brain.

Get your ID by messaging [@userinfobot](https://t.me/userinfobot). It's a number, not a
username — usernames change and can be squatted.

---

## Pre-commit checklist

Run this before your first push, and after any config change:

```bash
# 1. Nothing sensitive is staged
git status --short
git diff --cached | grep -iE "refresh_token|password|api_key|secret|bearer" || echo "clean"

# 2. The ignore rules actually catch your local files
git check-ignore -v .env auth.json shares.json node_modules

# 3. No secrets anywhere in tracked files
git grep -InE "clsk_|gho_|ghp_|sk-[A-Za-z0-9]{20}|M\.C5[A-Za-z0-9]|Bearer [A-Za-z0-9]{20}" \
  -- . ':!*.md' || echo "clean"

# 4. No personal data in tracked files
# Adjust the patterns to your own name, employers, and module codes.
git grep -InE "<your-name>|<your-employer>|<COURSE-CODE>@nus\.edu" -- . || echo "clean"

# 5. File modes are locked down
ls -l .env auth.json 2>/dev/null
```

If step 3 or 4 finds anything, fix it *before* committing. Once a secret is in git history,
removing it from the working tree is not enough — you need `git filter-repo` or BFG, and you
must still revoke the credential, because you can't know who already cloned it.

---

## If you think you've been compromised

1. **Revoke first, investigate second.** Remove the app's consent
   (<https://account.live.com/consent/Manage>). This is instant and reversible — you can
   re-consent in two minutes once you understand what happened.
2. **Change `BRAIN_PASSWORD`** and delete `shares.json` if the dashboard was exposed.
3. **Check OneDrive's recycle bin and version history.** Nothing in this system hard-deletes
   sources, but an attacker with a token isn't bound by the discipline rules.
4. **Read `wiki/log.md`.** Every legitimate change is there with a timestamp. Changes that
   aren't in the log are suspect.
5. **Rotate everything**, then re-run the pre-commit checklist above.

The design helps here: because all agent writes go through one MCP server with one token, and
every change is logged, the audit trail is unusually clean. You can usually tell exactly which
files were touched and when.
