// Shared MS Graph access-token helper.
// Reads MS_CLIENT_ID / MS_TENANT_ID / MS_REFRESH_TOKEN from the repo's .env
// (falls back to process.env, then ~/.second-brain/.env for legacy installs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ENV = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), ".env");
const LEGACY_ENV = path.join(os.homedir(), ".second-brain", ".env");
const ENV_PATH = process.env.SECOND_BRAIN_ENV || (fs.existsSync(REPO_ENV) ? REPO_ENV : LEGACY_ENV);
const GRAPH = "https://graph.microsoft.com/v1.0";

function loadEnv() {
  // process.env always wins so CI / shell exports work without a file.
  const out = { ...process.env };
  if (!fs.existsSync(ENV_PATH)) return out;
  const raw = fs.readFileSync(ENV_PATH, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !out[m[1]]) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

let cached = { token: null, expiresAt: 0 };

export async function getAccessToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  const { MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN } = loadEnv();
  if (!MS_CLIENT_ID || !MS_TENANT_ID || !MS_REFRESH_TOKEN) {
    throw new Error("Missing MS_* creds in " + ENV_PATH);
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: MS_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: MS_REFRESH_TOKEN,
        scope: "Files.ReadWrite offline_access",
      }),
    }
  );
  if (!res.ok) throw new Error(`Token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  cached = {
    token: data.access_token,
    // expire 10 min before actual expiry
    expiresAt: Date.now() + (data.expires_in - 600) * 1000,
  };
  return cached.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET with bounded retries on 429/5xx. Returns Response.
export async function graphGet(url, { retries = 4, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const token = await getAccessToken();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: "Bearer " + token, ...headers }, signal: ctrl.signal });
    } catch (e) {
      // network error / timeout → retry like 429/5xx
      lastErr = new Error(`fetch ${url} (attempt ${attempt + 1}): ${e.message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000 * 2 ** attempt;
      lastErr = new Error(`Graph ${res.status} on ${url} (attempt ${attempt + 1})`);
      await sleep(wait);
      continue;
    }
    return res;
  }
  throw lastErr;
}

// Fetch a drive item's content. If-None-Match → returns 304 on no change.
export async function fetchContent(itemId, etag) {
  const headers = etag ? { "If-None-Match": etag } : {};
  const res = await graphGet(`${GRAPH}/me/drive/items/${itemId}/content`, { headers });
  return res;
}

export const GRAPH_ROOT = GRAPH + "/me/drive/root:/Obsidian";
