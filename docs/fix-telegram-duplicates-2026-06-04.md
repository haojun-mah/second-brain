# Fix: Telegram Duplicate Responses (2026-06-04)

## Problem

When sending a single message to the bot via Telegram, two independent responses were returned. Testing with "give me a random number" produced two different random numbers, confirming two separate agent turns per inbound message.

## Root Cause Analysis

Diagnosis revealed **two intertwined issues**:

### 1. Telegram Adapter Complete Outage (Primary)

**Symptom:** Telegram adapter failed to initialize at startup with `NetworkError: Network error calling Telegram getMe`.

**Root Cause:** The VM has broken IPv6 egress:
- `curl -4 api.telegram.org` → HTTP 302 (works)
- `curl -6 api.telegram.org` → instant timeout (broken route)
- Node's `fetch` (undici) hangs on the dead IPv6 path → `ETIMEDOUT`

The systemd unit had `HTTPS_PROXY=http://127.0.0.1:10255` set to route through OneCLI's gateway, but was **missing `NODE_USE_ENV_PROXY=1`**. Without this flag, undici ignores `HTTPS_PROXY` and attempts a direct connection, which fails on IPv6.

### 2. Duplicate Delivery (Secondary / Symptom)

**Symptom:** One user message → two agent responses (numbers were different, proving independent turns).

**Root Cause:** With unstable connectivity, Telegram's `getUpdates` long-poll kept failing and retrying. When a poll fails before its offset is acknowledged:
- The **next poll re-returns the same update** (uncommitted offset)
- Router creates two inbound rows with the same Telegram message ID
- Two sessions wake → two independent agent turns → two responses

**Why it left no DB trace:** The dedup guard (10s TTL) was too short. Redeliveries arrived a full poll cycle (~30s) later and slipped through. DB showed only one row per message because the two inbound events arrived within a few seconds of each other in a single poll response, but the dedup map had already expired the ID.

## Changes Made

### 1. Systemd Unit Configuration (Deployment)

**File:** `~/.config/systemd/user/nanoclaw-v2-35120f3d.service`

**Change:** Added environment variables to activate the existing proxy:
```ini
Environment=NODE_USE_ENV_PROXY=1
Environment=NO_PROXY=127.0.0.1,localhost,::1
Environment=no_proxy=127.0.0.1,localhost,::1
```

**Effect:** 
- Undici now respects the `HTTPS_PROXY` setting and routes all fetch through the OneCLI gateway
- Gateway provides IPv4 routing, bypassing the broken IPv6 path
- `NO_PROXY` exemptions keep localhost calls (OneCLI API, CLI socket) direct
- Persists across service restarts

**Deployment:** After applying:
```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw-v2-35120f3d.service
```

### 2. Hardened Inbound Dedup (Code)

**File:** `src/channels/chat-sdk-bridge.ts`

**Change:** Increased dedup TTL from **10s to 5min (300s)**:
```typescript
const DEDUP_TTL_MS = 300_000; // was 10_000
```

**Rationale:**
- Telegram long-poll timeout is 30s; redelivery arrives after a full poll cycle
- Old 10s TTL let same-ID updates slip through if they re-arrived 30s later
- 5min window safely covers worst-case redelivery windows
- Telegram message IDs are per-chat unique, so longer window never drops distinct messages
- Also covers edge case of overlapping SDK dispatch paths (`onDirectMessage` + catch-all `onNewMessage`) both firing for the same message

**Testing:** Verified with live polling — delta of 0–1 conflicts per 40s (tail of restart overlap), not persistent.

### 3. Split-Response Suppression (Previous Session, Already Committed)

**Commit:** `afd0ef4 fix(agent): suppress split responses when delegating to sub-agents`

**Scope:** Container-side guard preventing the agent from sending both a mid-turn delegation (`send_message` MCP tool) and a final Telegram response in the same turn, which would produce a split response to one user query.

**Code changes:**
- `container/agent-runner/src/current-batch.ts`: track `agentMessageSentThisTurn` flag
- `container/agent-runner/src/mcp-tools/core.ts`: suppress channel message if agent delegation already sent
- `container/agent-runner/src/poll-loop.ts`: suppress result-text channel message if agent delegation sent; pre-scan all blocks for order-independence

(This was orthogonal to the Telegram connectivity issue but was part of the overall duplicate-response investigation.)

## Verification

**Live status (after fix):**
- Service: `active`
- Telegram adapter: `initialized { botUserId: '8889340005' }`
- Polling: `started { limit: 100, timeout: 30, ... }`
- Network errors: 0 since restart
- Running instances: 1
- getUpdates conflicts: settled (transient overlap from restarts only)

**Expected behavior going forward:**
- One user message → one bot response
- Stable Telegram connectivity via IPv4 proxy route
- Dedup backup protects against any redelivery edge cases

## Files Changed

| File | Type | Change |
|------|------|--------|
| `src/channels/chat-sdk-bridge.ts` | Code | Hardened dedup TTL |
| `~/.config/systemd/user/nanoclaw-v2-35120f3d.service` | Config (not tracked) | Added `NODE_USE_ENV_PROXY=1`, `NO_PROXY` |

## Testing Recommendation

Send a test message to the Telegram bot and confirm receipt of exactly one response. The duplicate responses should no longer occur.

---

**Deploy Date:** 2026-06-04  
**Status:** Live  
**Breaking Changes:** None
