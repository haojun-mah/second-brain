// sync-vault.mjs — pull OneDrive/Obsidian wiki + assets into sync/cache/ (ETag-delta).
// Uses item-ID based Graph traversal (path addressing is unreliable on this drive).
import fs from "node:fs";
import path from "node:path";
import { graphGet, fetchContent } from "./token.mjs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const CACHE = path.join(__dirname, "cache");
const ETAGS_FILE = path.join(CACHE, "etags.json");

// ---- which paths are user-visible (everything else is agent-internal) ----
const HIDDEN_PREFIXES = ["wiki/questions/"];
// Files that are agent-internal and should not appear on the public dashboard.
// Add your own here (e.g. a private index or scratch page).
const HIDDEN_EXACT = new Set(["wiki/log.md"]);
const INDEX_FILE = "wiki/index.md"; // fetched for descriptions, never rendered

function isHidden(rel) {
  return HIDDEN_PREFIXES.some((p) => rel.startsWith(p)) || HIDDEN_EXACT.has(rel);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reqCount = 0;
async function throttled(fn) {
  if (reqCount % 10 === 0) await sleep(120);
  reqCount++;
  return fn();
}

// Recursively walk a drive item, returning files with relPath = path under the Obsidian root.
async function walk(parentId, relDir) {
  const all = [];
  let url = `${GRAPH}/me/drive/items/${encodeURIComponent(parentId)}/children?$top=200`;
  while (url) {
    const res = await throttled(() => graphGet(url));
    if (!res.ok) throw new Error(`List ${relDir} failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    for (const item of data.value) {
      if (item.folder) {
        all.push(...(await walk(item.id, (relDir ? relDir + "/" : "") + item.name)));
      } else {
        all.push({ id: item.id, name: item.name, etag: item.eTag, rel: (relDir ? relDir + "/" : "") + item.name });
      }
    }
    url = data["@odata.nextLink"] || null;
  }
  return all;
}

function loadEtags() {
  try { return JSON.parse(fs.readFileSync(ETAGS_FILE, "utf8")); } catch { return {}; }
}
function saveEtags(e) {
  fs.writeFileSync(ETAGS_FILE, JSON.stringify(e, null, 2));
}

async function findRootItemId() {
  const res = await graphGet(`${GRAPH}/me/drive/root/children?$top=100&$select=id,name,folder`);
  if (!res.ok) throw new Error(`Root listing failed (${res.status})`);
  const data = await res.json();
  const obs = data.value.find((i) => i.name === "Obsidian");
  if (!obs) throw new Error("Obsidian folder not found at drive root");
  return obs.id;
}

async function main() {
  fs.mkdirSync(path.join(CACHE, "wiki"), { recursive: true });
  fs.mkdirSync(path.join(CACHE, "assets"), { recursive: true });
  const etags = loadEtags();
  let downloaded = 0, unchanged = 0, failed = 0;

  const rootId = await findRootItemId();
  const files = await walk(rootId, "");
  console.log(`walk complete: ${files.length} files in Obsidian root`);

  const jobs = [];
  for (const f of files) {
    const rel = f.rel;
    // wiki notes
    if (rel.startsWith("wiki/") && rel.endsWith(".md")) {
      if (isHidden(rel)) { console.log(`skip(hidden)  ${rel}`); continue; }
      jobs.push({
        ...f,
        dest: rel === INDEX_FILE ? path.join(CACHE, "index.md") : path.join(CACHE, "wiki", rel.replace(/^wiki\//, "")),
        key: rel,
      });
    }
    // images under sources/assets
    if (rel.startsWith("sources/assets/") && /\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
      jobs.push({ ...f, dest: path.join(CACHE, "assets", path.basename(rel)), key: rel });
    }
  }

  console.log(`sync: ${jobs.length} files to check`);
  for (const job of jobs) {
    try {
      const res = await fetchContent(job.id, etags[job.key]);
      if (res.status === 304) { unchanged++; continue; }
      if (!res.ok) throw new Error(`content fetch ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      fs.writeFileSync(job.dest, buf);
      etags[job.key] = res.headers.get("etag") || "";
      downloaded++;
    } catch (e) {
      failed++;
      console.error(`FAIL ${job.key}: ${e.message}`);
    }
  }

  saveEtags(etags);
  console.log(`sync done: ${downloaded} downloaded, ${unchanged} unchanged, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error("sync-vault fatal:", e); process.exit(1); });
