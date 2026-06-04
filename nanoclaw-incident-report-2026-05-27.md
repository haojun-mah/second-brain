# NanoClaw Incident Report: 2026-05-27 Setup Fixes

This document records all bugs encountered and fixed during the initial NanoClaw v2 VPS
setup on 2026-05-27. It is intended as a brief to a refactoring agent so the same
class of issues cannot recur.

---

## Incident 1 — OneCLI Proxy Not Reachable from Docker Containers

### Symptom
Agent containers started successfully but every Claude API call failed with
`Unable to connect. Is the computer able to access the url?` (Bun's network error).
The container poll loop emitted endless `API retry (retryable: true)` lines and never
produced a response. Telegram messages arrived and were routed, but no reply was ever
delivered.

### Root Cause
OneCLI's credential proxy (port 10255) and UI (port 10254) were bound to
`127.0.0.1` by default via the `ONECLI_BIND_HOST` variable in `~/.onecli/docker-compose.yml`.
Docker containers resolve the host as `host.docker.internal` → `172.17.0.1` (the Docker
bridge gateway). Since the proxy was not listening on that interface, every proxied API
call from inside a container was refused.

### Fix Applied
Created `~/.onecli/.env` (the Docker Compose variable file — distinct from the
`env_file:` reference in the compose YAML) with:

```
ONECLI_BIND_HOST=0.0.0.0
```

Then restarted OneCLI via `docker compose down && docker compose up -d` from
`~/.onecli/`. Ports 10254 and 10255 now bind on `0.0.0.0`.

### What the Refactor Should Do
- The NanoClaw setup script (`setup/`) should detect whether it is running on a host
  where Docker containers need to reach OneCLI (i.e. any Linux Docker install), and
  automatically write `ONECLI_BIND_HOST=0.0.0.0` to `~/.onecli/.env` if not already
  set.
- Alternatively, add a preflight check in `setup/verify.ts` that connects to
  `http://host.docker.internal:10255` from a throwaway container and fails early with
  a clear diagnostic if unreachable.
- Document the requirement explicitly in `docs/setup-wiring.md` and the `/setup` skill.

---

## Incident 2 — OneDrive MCP Credentials Not Injected into Containers

### Symptom
The Ingester, Linter, and Query agents all failed to access OneDrive. Every run
produced: `OneDrive is still returning a token refresh error (404)`. The agents
correctly reported the problem but could not self-heal.

### Root Cause
The OneDrive MCP server (`container/mcp-servers/onedrive/src/graph-client.ts`) reads
`MS_CLIENT_ID`, `MS_TENANT_ID`, and `MS_REFRESH_TOKEN` from `process.env`. These
variables are set in the host `.env` file (`~/.env`) but were **never passed to the
containers**.

The MCP server entry in `container_configs.mcp_servers` (stored in `data/v2.db`) had
`"env": {}` for all three affected agent groups. With an empty `MS_TENANT_ID`, the
OAuth token endpoint URL became:

```
https://login.microsoftonline.com//oauth2/v2.0/token   ← double-slash → 404
```

### Fix Applied
Updated `container_configs.mcp_servers` directly in `data/v2.db` for agent groups
`ag-1779871773441-r9ai7p` (Ingester), `ag-1779871773601-2glcic` (Linter), and
`ag-1779871773600-4yhmvn` (Query) to inject the three credentials into the
`onedrive.env` field:

```json
{
  "onedrive": {
    "env": {
      "MS_CLIENT_ID": "...",
      "MS_TENANT_ID": "common",
      "MS_REFRESH_TOKEN": "..."
    }
  }
}
```

### What the Refactor Should Do
- The `/add-onedrive` or OneDrive setup path should write these three env vars into
  the `mcp_servers.onedrive.env` field via `ncl groups config update` (or a dedicated
  helper) at setup time — not rely on the operator doing it manually.
- Alternatively, the container runner (`src/container-runner.ts`) should have a
  mechanism to forward a configurable allowlist of host env vars (e.g.
  `NANOCLAW_FORWARD_ENV=MS_CLIENT_ID,MS_TENANT_ID,MS_REFRESH_TOKEN`) into every
  container at spawn time, so credentials do not need to be duplicated into the DB.
- Either way, the setup skill should validate after wiring that the MCP env vars are
  populated and warn if they are empty.
- Consider rotating the refresh token: a stale token in the DB will silently break
  all vault agents. A health-check tool that tests `mcp__onedrive__list_directory`
  on each wake and surfaces a clear "re-auth needed" message (with a reconnect URL)
  would improve observability.

---

## Incident 3 — Query Agent Had No Reply Destination

### Symptom
The Query agent received messages (forwarded from hj via agent-to-agent routing) and
processed them successfully, but every reply was silently dropped. The container log
showed:

```
[poll-loop] Unknown destination in <message to="hj">, dropping block
[poll-loop] WARNING: agent output had no <message to="..."> blocks — nothing was sent
```

The agent itself diagnosed the problem accurately: "I have zero configured destinations."

### Root Cause
The `agent_destinations` table had no row for the Query agent group
(`ag-1779871773600-4yhmvn`). The hj agent had a destination pointing *to* Query
(so it could forward questions), but no return path was configured from Query *back*
to hj.

### Fix Applied
Added a destination via `ncl destinations add`:

```
agent_group_id : ag-1779871773600-4yhmvn  (Query)
local_name     : hj
target_type    : agent
target_id      : ag-1779872373454-o4e9in  (hj)
```

### What the Refactor Should Do
- The `/manage-channels` skill and any agent wiring flow should always create
  **bidirectional** destinations when wiring an agent-to-agent relationship. If A
  has a destination to B, B should automatically get a destination back to A
  (unless explicitly suppressed).
- Add a startup or sweep check: for any agent group that receives a2a messages
  (i.e. appears as `target_id` in another group's `agent_destinations`), verify it
  has at least one outbound destination. Warn in the host log if not.
- The `/init-first-agent` skill and group creation flow should include destination
  setup as a required step, not an optional one.

---

## Summary Table

| # | Agent(s) Affected | Problem | Fix | Refactor Target |
|---|---|---|---|---|
| 1 | All containers | OneCLI proxy on `127.0.0.1`; unreachable from Docker bridge | `ONECLI_BIND_HOST=0.0.0.0` in `~/.onecli/.env` | Setup preflight / setup skill docs |
| 2 | Ingester, Linter, Query | OneDrive MCP env empty; OAuth URL double-slash → 404 | Injected `MS_*` into `mcp_servers.onedrive.env` in DB | OneDrive setup flow; env forward mechanism |
| 3 | Query | No reply destination; all outbound messages silently dropped | Added `hj` as agent destination for Query | Bidirectional wiring enforcement |
