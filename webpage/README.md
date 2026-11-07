# Web dashboard

An optional read-only web view of your second brain: a force-directed graph of
every wiki note, category filters, full-text-ish search, and rendered Markdown
with `[[wikilinks]]` resolved.

It reads **only** from `sync/cache/` — a local mirror pulled from OneDrive. Your
vault is never written to by the dashboard.

---

## How it works

```
OneDrive/Obsidian/  ──sync-vault.mjs──▶  sync/cache/  ──build.mjs──▶  dist/  ──▶  browser
   (source of truth)                     (local mirror)   (bundler)             (static)
```

1. **`sync/sync-vault.mjs`** walks the OneDrive vault via the Graph API using
   item IDs (path addressing is unreliable on some drives), writes notes and
   assets into `sync/cache/`, and records ETags so repeat runs only fetch what
   changed.
2. **`sync/build.mjs`** parses the mirrored Markdown, extracts `[[wikilinks]]`
   into graph edges, and emits a static bundle into `dist/`.
3. **`server/serve.py`** serves `dist/` (or `public/`) with an optional
   password gate.

Some paths are deliberately excluded from the dashboard — see
`HIDDEN_PREFIXES` / `HIDDEN_EXACT` at the top of `sync-vault.mjs`. By default
`wiki/log.md` and `wiki/questions/` never reach the browser.

---

## Setup

```bash
cd webpage
npm install
```

The sync step reuses the same credentials as the MCP server. Put them in the
repo's `.env` (created by `scripts/bootstrap.sh`), or export them:

```bash
export MS_CLIENT_ID=...
export MS_TENANT_ID=...
export MS_REFRESH_TOKEN=...
```

`sync/token.mjs` looks for `.env` in this order:
`$SECOND_BRAIN_ENV` → `<repo>/.env` → `~/.second-brain/.env` → `process.env`.

---

## Run it

```bash
npm run sync     # pull the vault into sync/cache/
npm run build    # bundle into dist/
python3 server/serve.py          # http://127.0.0.1:8741
```

Optional password gate:

```bash
python3 sync/make_auth.py 'your-password'   # writes auth.json (chmod 600)
python3 server/serve.py                     # now requires login
```

`auth.json` is gitignored. Never commit it.

---

## Exposing it beyond localhost

`serve.py` is a single-user tool, not a hardened web app. If you want it
reachable from your phone:

```bash
python3 server/serve.py --host 0.0.0.0 --port 8741
```

and put it behind a reverse proxy that terminates TLS (Caddy, nginx, or a
Cloudflare Tunnel). Do **not** bind `0.0.0.0` without a password — `serve.py`
prints a warning if you do.

---

## Keeping it fresh

`ops/` is where your own scheduling scripts belong. A typical cron entry:

```cron
*/30 * * * * cd /path/to/second-brain/webpage && npm run sync && npm run build
```

On a multi-agent host, keep the port inside whatever range you've allocated to
this project to avoid colliding with other services.
