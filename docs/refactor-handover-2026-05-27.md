# Refactor Handover — 2026-05-27

This document is a handover brief for a local refactoring pass. It captures every issue
encountered during the initial VPS deployment of the second-brain system, the bandaid fix
applied in each case, and the proper structural fix required. The fixes applied on
2026-05-27 were the minimum to get the system running; they did not address the
underlying design gaps.

---

## Issue 1 — OneCLI Proxy Unreachable from Docker Containers

### What happened

All agent containers failed to make any Claude API call. The container poll loop printed
endless `API retry (retryable: true)` lines and never produced a response. Telegram
messages arrived and were routed correctly, but no reply was ever delivered.

### Root cause

OneCLI's credential proxy (port 10255) and UI (port 10254) default to binding on
`127.0.0.1` via the `ONECLI_BIND_HOST` variable in `~/.onecli/docker-compose.yml`.
Docker containers on Linux reach the host via `host.docker.internal` → `172.17.0.1`
(the Docker bridge gateway). Since the proxy was not listening on that interface, every
proxied API call from inside a container was connection-refused.

### Bandaid fix applied

Manually created `~/.onecli/.env` with:

```
ONECLI_BIND_HOST=0.0.0.0
```

Then restarted OneCLI: `docker compose down && docker compose up -d` from `~/.onecli/`.

### Why this is a bandaid

The fix lives entirely outside the NanoClaw repo in a file the setup scripts never read,
write, or verify. Any fresh VPS deploy will hit the exact same failure with no diagnostic
pointing at `ONECLI_BIND_HOST`. The setup scripts do not know this file exists.

### Proper refactor

**Primary: automated detection and write in `setup/`.**

In `setup/onecli.ts` (or the step that starts OneCLI), after OneCLI is up, detect
whether the runtime is Linux with Docker (as opposed to macOS with its `host-gateway`
alias):

```ts
// Pseudocode — add to setup/onecli.ts
const isLinuxDocker = process.platform === 'linux';
const onecliEnvPath = path.join(os.homedir(), '.onecli', '.env');
if (isLinuxDocker) {
  const current = fs.existsSync(onecliEnvPath) ? fs.readFileSync(onecliEnvPath, 'utf-8') : '';
  if (!current.includes('ONECLI_BIND_HOST=')) {
    fs.appendFileSync(onecliEnvPath, '\nONECLI_BIND_HOST=0.0.0.0\n');
    // restart onecli compose
  }
}
```

**Secondary: preflight connectivity check in `setup/verify.ts`.**

After the service is running, launch a throwaway Docker container and attempt a TCP
connection to `host.docker.internal:10255`. Fail early with a human-readable diagnostic
if unreachable. This catches the case even if the auto-write above is skipped or
partially effective.

```bash
docker run --rm --add-host=host.docker.internal:host-gateway alpine \
  nc -z host.docker.internal 10255 && echo ok || echo "FAIL: OneCLI proxy unreachable from containers"
```

**Tertiary: documentation.**

Add a "Linux Docker gotcha" callout to `docs/setup-wiring.md` and the `/setup` skill,
noting that `ONECLI_BIND_HOST=0.0.0.0` must be set in `~/.onecli/.env` on any Linux
host.

**Files to touch:**
- `setup/onecli.ts` — write the `.env` entry when on Linux
- `setup/verify.ts` — add container connectivity probe
- `docs/setup-wiring.md` — document the Linux requirement
- `.claude/skills/setup/SKILL.md` (or equivalent) — add a step to the walkthrough

---

## Issue 2 — OneDrive MCP Credentials Not Injected into Containers

### What happened

The Ingester, Linter, and Query agents all failed to access OneDrive on every run.
Error: `OneDrive is still returning a token refresh error (404)`. The agents diagnosed
the problem correctly but could not self-heal.

### Root cause

`container/mcp-servers/onedrive/src/graph-client.ts` reads `MS_CLIENT_ID`, `MS_TENANT_ID`,
and `MS_REFRESH_TOKEN` directly from `process.env`. These are set in the host `.env`
file but are **never forwarded into containers**. The MCP server entry in
`container_configs.mcp_servers` (stored in `data/v2.db`) had `"env": {}` for all three
affected agent groups.

With `MS_TENANT_ID` being an empty string, the token endpoint URL became:

```
https://login.microsoftonline.com//oauth2/v2.0/token   ← double-slash → 404
```

### Bandaid fix applied

Manually ran SQL to update `container_configs.mcp_servers` in `data/v2.db` for agent
groups `ag-1779871773441-r9ai7p` (Ingester), `ag-1779871773601-2glcic` (Linter), and
`ag-1779871773600-4yhmvn` (Query), setting the `onedrive.env` field to:

```json
{
  "MS_CLIENT_ID": "...",
  "MS_TENANT_ID": "common",
  "MS_REFRESH_TOKEN": "..."
}
```

### Why this is a bandaid

1. The refresh token stored in the DB will silently become stale after 90 days (Microsoft
   default). When it rotates there is no alert; all three agents will stop working with
   a 404 error, indistinguishable from the original incident.
2. The credentials are now duplicated in two places: `.env` (source of truth for OAuth
   auth flow) and `data/v2.db` (injected copy). Any token rotation must be applied in
   both places manually.
3. `scripts/setup-second-brain.ts` creates the three agent groups but does not write the
   `onedrive.env` block. Any re-run of setup will re-create the groups with empty env,
   breaking them again.
4. The setup flow in `scripts/setup-full.sh` runs `setup-second-brain.ts` *before*
   `setup-onedrive-auth.ts`, so even if the script were fixed to write the env vars, the
   token would not yet exist when the groups are created. The ordering is wrong.

### Proper refactor

**1. Fix the setup ordering and write env vars at group-creation time.**

In `scripts/setup-second-brain.ts`, after the OneDrive auth step (`MS_REFRESH_TOKEN` is
known), write the three MS credentials into `mcp_servers.onedrive.env` for each group
that uses OneDrive. This should be a single helper:

```ts
function writeOneDriveEnv(agGroupId: string): void {
  const current = getContainerConfig(agGroupId);
  const mcpServers = JSON.parse(current.mcp_servers ?? '{}');
  mcpServers.onedrive ??= {};
  mcpServers.onedrive.env = {
    MS_CLIENT_ID: process.env.MS_CLIENT_ID!,
    MS_TENANT_ID: process.env.MS_TENANT_ID!,
    MS_REFRESH_TOKEN: process.env.MS_REFRESH_TOKEN!,
  };
  updateContainerConfig(agGroupId, { mcp_servers: JSON.stringify(mcpServers) });
}
```

Call this from `main()` after the auth script completes. Re-order the stages in
`scripts/setup-full.sh` so OneDrive auth (Stage 2b) runs **before** agent group creation
(Stage 2a).

**2. Token rotation mechanism.**

When `scripts/setup-onedrive-auth.ts` obtains a new refresh token and writes it to
`.env`, it should also call `writeOneDriveEnv` for all three agent groups. The two
storage locations must be kept in sync by the same write path, not maintained separately.

Alternatively (higher quality): remove the DB duplication entirely and instead have
`src/container-runner.ts` forward a configurable allowlist of env vars from the host
process into containers at spawn time:

```ts
// In container-runner.ts buildEnv()
const forwardVars = (process.env.NANOCLAW_FORWARD_ENV ?? '').split(',').filter(Boolean);
for (const key of forwardVars) {
  if (process.env[key]) env[key] = process.env[key]!;
}
```

With `NANOCLAW_FORWARD_ENV=MS_CLIENT_ID,MS_TENANT_ID,MS_REFRESH_TOKEN` in `.env`,
the credentials are forwarded live from the host process — never stored in the DB —
and any token rotation takes effect without a DB update.

**3. Health check at container wake.**

Add a startup probe in the ingester/linter/query agent container instructions: on each
wake, verify the OneDrive MCP server responds to a trivial call (`list_directory /`).
If it fails with a token error, emit a message to the operator's DM via the `hj`
destination: "OneDrive auth expired — run `pnpm exec tsx scripts/setup-onedrive-auth.ts`
to re-authenticate."

**4. Fail loudly on empty MS_TENANT_ID.**

In `graph-client.ts`, add a guard at module load time:

```ts
if (!CLIENT_ID || !TENANT_ID || !REFRESH_TOKEN) {
  throw new Error(
    'OneDrive MCP server: MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN must be set. ' +
    'Run scripts/setup-onedrive-auth.ts to authenticate.'
  );
}
```

An empty tenant ID silently producing a double-slash URL and a 404 is a confusing
failure mode. A hard throw at startup makes the misconfiguration immediately obvious.

**Files to touch:**
- `scripts/setup-second-brain.ts` — write OneDrive env vars after auth completes
- `scripts/setup-full.sh` — reorder: auth (2b) before group creation (2a)
- `scripts/setup-onedrive-auth.ts` — also update DB on token write
- `container/mcp-servers/onedrive/src/graph-client.ts` — fail fast on empty vars
- `src/container-runner.ts` — optionally add `NANOCLAW_FORWARD_ENV` passthrough

---

## Issue 3 — Query Agent Had No Reply Destination

### What happened

The Query agent received messages forwarded from `hj` and processed them correctly, but
every reply was silently dropped. The container log showed:

```
[poll-loop] Unknown destination in <message to="hj">, dropping block
[poll-loop] WARNING: agent output had no <message to="..."> blocks — nothing was sent
```

### Root cause

`agent_destinations` had no row for the Query agent group. The `hj` agent had a
destination pointing *to* Query (so it could forward questions), but no return path
was configured from Query back to `hj`. The wiring was unidirectional.

### Bandaid fix applied

Manually ran `ncl destinations add` to add a `hj` destination on the Query agent group
pointing back to the `hj` agent group.

### Why this is a bandaid

1. `scripts/setup-second-brain.ts` creates the agent groups and the wiring, but does
   not create any `agent_destinations` rows. The return path for Query → hj is entirely
   missing from the setup script. Any fresh setup will recreate the broken state.
2. The setup script for `hj` (the operator agent, created by `/init-first-agent`) also
   does not automatically configure a destination to `query` — that was added manually
   during initial wiring. So the forward path `hj → query` is equally fragile.
3. There is no startup or sweep check that detects agent groups that can receive a2a
   messages but have no outbound destination.

### Proper refactor

**1. Create bidirectional destinations in the setup script.**

In `scripts/setup-second-brain.ts`, after agent groups are created, explicitly create
destinations for each a2a relationship:

```ts
// hj → query (forward)
createDestination({
  agent_group_id: hjAgentGroupId,
  local_name: 'query',
  target_type: 'agent',
  target_id: queryAgentGroupId,
});

// query → hj (reply path)
createDestination({
  agent_group_id: queryAgentGroupId,
  local_name: 'hj',
  target_type: 'agent',
  target_id: hjAgentGroupId,
});
```

The setup script knows the IDs for both groups at the time of creation, so there is no
reason to defer this to a manual `ncl destinations add` call.

**2. Bidirectional enforcement in `ncl destinations add` / the wiring flow.**

When `ncl destinations add` creates an agent-to-agent destination, it should offer (or
optionally auto-create) the reverse destination. Precedent: most graph databases and
messaging systems surface a "create reverse edge?" prompt. A `--bidirectional` flag
would cover this cleanly without forcing it on every use case.

**3. Sweep check for orphaned a2a receivers.**

In `src/host-sweep.ts`, add a check: for every agent group that appears as `target_id`
in the `agent_destinations` table with `target_type = 'agent'`, verify it has at least
one outbound `agent_destinations` row of its own. If not, log a warning:

```
[sweep] WARNING: agent group 'query' (ag-xxx) receives a2a messages but has no outbound
destinations — replies will be silently dropped.
```

This would have surfaced the problem the first time the sweep ran, before a single
user message was affected.

**Files to touch:**
- `scripts/setup-second-brain.ts` — add bidirectional destination creation
- `src/host-sweep.ts` — add orphaned-receiver check
- `src/cli/resources/destinations.ts` — consider `--bidirectional` flag
- `src/cli/dispatch.ts` — drop message with a clear error log rather than silently

---

## Issue 4 — TypeScript Build Errors Silently Swallowed During Service Setup

### What happened

During VPS setup, the `pnpm run setup:auto` step invoked `setup/service.ts` which ran
`pnpm run build` internally via `execSync` with `stdio: 'pipe'`. When the build failed
(due to TypeScript errors introduced by new code), the error output was captured but not
logged to the terminal. The setup step reported a generic "Build failed" with no
compiler output, making diagnosis impossible without manually running `pnpm run build`.

### Bandaid fix applied

Two targeted patches:

1. `scripts/deploy-vps.sh` — added an explicit `pnpm run build` step *before*
   `setup:auto`, so compiler errors appear directly in the terminal.
2. `setup/service.ts` — capture `stdout`/`stderr` from the failed build and write them
   to `log.error`, and prefer `./node_modules/.bin/tsc` directly to avoid PATH issues
   in subprocess contexts.

### Why this is a bandaid

The `deploy-vps.sh` fix works but it means the build now runs twice (once explicitly,
once inside `setup/service.ts`). The underlying problem — `setup/service.ts` hiding
build output — is partially addressed by the `log.error` change, but those log lines go
to the log file, not the terminal, so they are still invisible during interactive setup.

### Proper refactor

**`setup/service.ts` should pipe build output directly to the terminal.**

The `stdio: 'pipe'` was almost certainly set to suppress noise during happy-path runs.
A better approach:

```ts
execSync(buildCmd, {
  cwd: projectRoot,
  stdio: 'inherit',   // <— pipes stdout/stderr directly to terminal
});
```

If suppressing output on success is desired, use `stdio: 'pipe'` but *always* print
stdout/stderr on failure — not just write to a log file. The current patch only writes
to `log.error`, which on a fresh VPS install goes to `logs/nanoclaw.error.log`, a file
the operator has not yet opened.

Remove the redundant explicit build step from `scripts/deploy-vps.sh` once
`setup/service.ts` properly surfaces errors inline.

**Files to touch:**
- `setup/service.ts` — change `stdio` to `'inherit'` or conditionally print on failure
- `scripts/deploy-vps.sh` — remove the redundant pre-build step once the above is fixed

---

## Cross-Cutting: Missing Post-Setup Validation

All four issues share a common root: the setup flow has no end-to-end validation pass
after all components are started. The system can appear to complete setup successfully
while leaving several components silently broken. A final validation step would have
caught all of these before the first real user message.

### Proposed validation step in `setup/verify.ts`

The existing `verify.ts` checks service status and DB schema but does not exercise the
live data path. Extend it with:

| Check | How |
|---|---|
| OneCLI proxy reachable from Docker | `docker run --rm alpine nc -z host.docker.internal 10255` |
| Each agent group has ≥1 outbound destination | Query `agent_destinations` in `data/v2.db` |
| OneDrive MCP env vars non-empty for each group that uses it | Inspect `container_configs.mcp_servers[*].env` |
| OneDrive token valid | Call `GET /me/drive` with the stored token, expect 200 |
| Recurring task seeded for Ingester | Query `messages_in` in the Ingester session DB |

Run this as a final step in both `setup/verify.ts` and `scripts/deploy-vps.sh`. Any
failure should block the setup completion message and print an actionable remediation
step.

---

## Summary Table

| # | Issue | Bandaid | Root Cause | Proper Fix |
|---|---|---|---|---|
| 1 | OneCLI proxy unreachable from Docker on Linux | Manually set `ONECLI_BIND_HOST=0.0.0.0` outside repo | Setup never configures `ONECLI_BIND_HOST` on Linux | Auto-write in `setup/onecli.ts`; preflight connectivity probe in `setup/verify.ts` |
| 2 | OneDrive MCP env vars empty → 404 token URL | Manually updated DB for 3 agent groups | Setup creates groups before auth; never writes env vars to DB | Fix stage ordering in `setup-full.sh`; write env at group creation; add `NANOCLAW_FORWARD_ENV` passthrough option |
| 3 | Query agent has no reply destination → silent drops | Manually ran `ncl destinations add` | Setup script creates no a2a destinations; no sweep check | Create bidirectional destinations in setup script; add orphan check to sweep |
| 4 | TypeScript build errors hidden during `setup:auto` | Explicit pre-build in `deploy-vps.sh`; log errors in `service.ts` | `stdio: 'pipe'` without surface-on-failure | Change `service.ts` to `stdio: 'inherit'`; remove duplicate build step |
| x | No end-to-end validation after setup | — | `setup/verify.ts` does not test the live data path | Add live preflight checks to `verify.ts` and `deploy-vps.sh` |

---

## Priority Order

1. **Issue 2 (OneDrive env / stage ordering)** — highest risk. The refresh token will
   silently expire. Any full re-deploy will recreate broken state. Fix the setup ordering
   and write path first.

2. **Issue 3 (missing destinations)** — second highest. A re-run of `setup-second-brain.ts`
   recreates the broken wiring. The sweep check is a cheap safety net with high value.

3. **Cross-cutting validation** — addresses all four issues defensively. Once implemented,
   future breaks in this class surface in seconds, not after an hour of debugging.

4. **Issue 1 (OneCLI bind host)** — addressed for this deployment but a trap for any
   fresh VPS install. Auto-write in setup is the clean fix.

5. **Issue 4 (build output)** — cosmetic but meaningful for developer experience. One-line
   `stdio` change.
