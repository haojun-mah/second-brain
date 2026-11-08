/**
 * GitHub backend — the vault is a repo (or a folder inside one).
 *
 * Uses the Contents API for single-file read/write/delete, the Git Trees API for recursive
 * listing, and the Compare API for `changes()`.
 *
 * Notes that shaped this implementation:
 *
 *   - **The blob sha is the etag.** A `GET /contents/{path}` returns the blob `sha`; a `PUT`
 *     that names the *current* sha succeeds, and one that names a stale sha is rejected with
 *     409. That is exactly the conditional-write semantics `write(path, content, ifMatch)`
 *     needs, so `readFile()` hands the sha back and `write()` forwards it.
 *   - **A write is a commit.** Every mutation needs a commit message; they all carry the
 *     `[vault] ` prefix so `git log` on the vault repo is readable.
 *   - **The tree API is the only sane way to list.** `GET /git/trees/{sha}?recursive=1` is one
 *     request for the whole vault; walking `contents/` per folder is N requests and gets
 *     rate-limited on a real vault.
 *   - **Rename is delete + create.** There is no move in the Contents API. We read the blob,
 *     write it at the destination, then delete the old path. A failure between the two leaves
 *     a duplicate, never a lost file — the safer of the two orders.
 *   - **`changes()` is commit-range based.** The token is the branch HEAD commit sha at the
 *     time of the last poll; the next poll asks the Compare API what changed between then and
 *     now. Without a token you get an empty change set plus the current HEAD, which is the
 *     "start watching from here" behaviour the ingester expects.
 *   - **Search is a local grep over the tree**, because GitHub code search needs a separate
 *     index and does not exist for private repos on every plan. Capped at MAX_SEARCH_FILES
 *     files / MAX_FILE_BYTES per file: a personal vault is a few hundred notes, so a full
 *     grep is both affordable and far more predictable than an index that may or may not
 *     cover the repo.
 */

import type {
  ChangeSet,
  ListOptions,
  SearchHit,
  VaultBackend,
  VaultEntry,
  VaultFile,
} from './types.js';
import { EtagMismatchError, VaultNotFoundError } from './types.js';
import type { VaultConfig } from '../config.js';

const API = 'https://api.github.com';
const MAX_SEARCH_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_RADIUS = 100;

interface ContentsResponse {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface CommitResponse {
  sha: string;
  commit: { message: string; committer?: { date?: string } };
}

/** Join the vault root and a vault-relative path into a repo-relative path. */
function repoPath(vaultRoot: string, vaultPath: string): string {
  const rel = vaultPath.replace(/^\/+|\/+$/g, '');
  const root = vaultRoot.replace(/^\/+|\/+$/g, '');
  if (!root) return rel;
  return rel ? `${root}/${rel}` : root;
}

function snippetAround(text: string, index: number, needleLength: number): string {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + needleLength + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

export class GitHubBackend implements VaultBackend {
  readonly kind = 'github';
  readonly location: string;

  private readonly token: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly vaultRoot: string;

  constructor(config: VaultConfig) {
    this.token = config.githubToken;
    this.repo = config.githubVaultRepo;
    this.branch = config.githubVaultBranch || 'main';
    this.vaultRoot = config.vaultRoot.replace(/^\/+|\/+$/g, '');
    this.location = `GitHub ${this.repo}@${this.branch}${this.vaultRoot ? `/${this.vaultRoot}` : ''}`;
  }

  // ── transport ──────────────────────────────────────────────────────────────

  private async api(
    path: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: init.accept ?? 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vault-mcp-server',
    };
    const options: RequestInit = { method: init.method ?? 'GET', headers };
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(init.body);
    }

    let res = await fetch(`${API}${path}`, options);

    // Secondary rate limits answer 403 with a retry-after hint; primary limits answer 429.
    if (res.status === 429 || res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (res.status === 429 || remaining === '0') {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '1', 10);
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 10) * 1000));
        res = await fetch(`${API}${path}`, options);
      }
    }

    if (res.status >= 500) {
      let delay = 1000;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((r) => setTimeout(r, delay));
        res = await fetch(`${API}${path}`, options);
        if (res.status < 500) break;
        delay *= 2;
      }
    }

    return res;
  }

  private async errorText(res: Response): Promise<string> {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) return `Error ${res.status}: ${parsed.message}`;
    } catch {
      /* not JSON — fall through to the raw body */
    }
    return `Error ${res.status}: ${body.slice(0, 300)}`;
  }

  private encodeApiPath(path: string): string {
    return path
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
  }

  /** HEAD commit sha of the branch — used as the `changes()` cursor and the write base. */
  private async headSha(): Promise<string> {
    const res = await this.api(`/repos/${this.repo}/commits/${encodeURIComponent(this.branch)}`);
    if (res.status === 404) {
      throw new Error(
        `GitHub repo or branch not found: ${this.repo}@${this.branch}. ` +
          `Check GITHUB_VAULT_REPO ("owner/repo") and GITHUB_VAULT_BRANCH.`,
      );
    }
    if (!res.ok) throw new Error(await this.errorText(res));
    const data = (await res.json()) as CommitResponse;
    return data.sha;
  }

  // ── metadata ───────────────────────────────────────────────────────────────

  /** Contents API metadata for one path. Returns null on 404. */
  private async contents(vaultPath: string): Promise<ContentsResponse | null> {
    const path = repoPath(this.vaultRoot, vaultPath);
    const res = await this.api(
      `/repos/${this.repo}/contents/${this.encodeApiPath(path)}?ref=${encodeURIComponent(this.branch)}`,
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await this.errorText(res));
    return (await res.json()) as ContentsResponse;
  }

  /** The whole vault as a flat list of blobs, from one recursive tree request. */
  private async tree(): Promise<TreeEntry[]> {
    const head = await this.headSha();
    const res = await this.api(
      `/repos/${this.repo}/git/trees/${head}?recursive=1`,
    );
    if (!res.ok) throw new Error(await this.errorText(res));

    const data = (await res.json()) as { tree: TreeEntry[]; truncated?: boolean };
    const root = this.vaultRoot ? `${this.vaultRoot}/` : '';
    return data.tree.filter(
      (e) => e.type === 'blob' && (root === '' || e.path === this.vaultRoot || e.path.startsWith(root)),
    );
  }

  private blobPath(entry: TreeEntry): string {
    const root = this.vaultRoot ? `${this.vaultRoot}/` : '';
    return root && entry.path.startsWith(root) ? entry.path.slice(root.length) : entry.path;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async read(path: string): Promise<string> {
    const file = await this.readFile(path);
    return file.content;
  }

  async readFile(path: string): Promise<VaultFile> {
    const meta = await this.contents(path);
    if (!meta || meta.type !== 'file') {
      throw new VaultNotFoundError(`Not found: ${path}`);
    }

    // The contents endpoint inlines base64 for files up to 1 MB; larger ones come back with
    // an empty `content` and must be fetched as a blob.
    if (!meta.content) {
      const res = await this.api(`/repos/${this.repo}/git/blobs/${meta.sha}`);
      if (!res.ok) throw new Error(await this.errorText(res));
      const blob = (await res.json()) as { content: string; encoding: string };
      const text = Buffer.from(blob.content, 'base64').toString('utf8');
      return { content: text, etag: meta.sha, lastModified: '' };
    }

    const text = Buffer.from(meta.content, 'base64').toString('utf8');
    return { content: text, etag: meta.sha, lastModified: '' };
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  private async put(
    repoRelPath: string,
    content: string,
    sha: string | undefined,
    message: string,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      message,
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: this.branch,
    };
    if (sha) body['sha'] = sha;

    const res = await this.api(`/repos/${this.repo}/contents/${this.encodeApiPath(repoRelPath)}`, {
      method: 'PUT',
      body,
    });

    if (res.status === 409 || res.status === 422) {
      // 409: sha no longer current. 422: "sha wasn't supplied" when the file exists, which
      // is the same conflict seen from the other side.
      throw new EtagMismatchError();
    }
    if (!res.ok) throw new Error(await this.errorText(res));

    const data = (await res.json()) as { content?: { sha?: string } };
    return data.content?.sha ?? '';
  }

  async write(path: string, content: string, ifMatch?: string): Promise<string> {
    const repoRel = repoPath(this.vaultRoot, path);
    let sha = ifMatch;

    if (!sha) {
      // Unconditional write: send the current sha when the file exists, so GitHub treats it
      // as an update rather than rejecting it.
      const existing = await this.contents(path);
      sha = existing?.type === 'file' ? existing.sha : undefined;
    }

    return this.put(repoRel, content, sha, `[vault] write ${path}`);
  }

  async append(path: string, content: string): Promise<string> {
    let existing: VaultFile | null = null;
    try {
      existing = await this.readFile(path);
    } catch (err) {
      if (!(err instanceof VaultNotFoundError)) throw err;
    }

    const body = existing ? existing.content + content : content;
    const repoRel = repoPath(this.vaultRoot, path);
    return this.put(repoRel, body, existing?.etag, `[vault] append ${path}`);
  }

  // ── listing ────────────────────────────────────────────────────────────────

  async list(path: string, opts: ListOptions = {}): Promise<VaultEntry[]> {
    const recursive = opts.recursive ?? false;
    const dir = path.replace(/^\/+|\/+$/g, "");
    const prefix = dir ? `${dir}/` : '';

    const blobs = await this.tree();
    const entries: VaultEntry[] = [];
    const folders = new Set<string>();

    for (const blob of blobs) {
      const rel = this.blobPath(blob);
      if (prefix && !rel.startsWith(prefix)) continue;
      if (!prefix && dir !== '') continue;

      const tail = prefix ? rel.slice(prefix.length) : rel;
      if (tail === '') continue;

      if (recursive) {
        entries.push({
          name: tail.split('/').pop() ?? tail,
          path: rel,
          size: blob.size ?? 0,
          modified: '',
          isFolder: false,
        });
        // Record every intermediate folder so the listing mirrors a real tree walk.
        const parts = tail.split('/');
        for (let i = 1; i < parts.length; i++) {
          folders.add(prefix + parts.slice(0, i).join('/'));
        }
        continue;
      }

      // Non-recursive: only direct children.
      if (tail.includes('/')) {
        folders.add(prefix + tail.split('/')[0]);
        continue;
      }

      entries.push({
        name: tail,
        path: rel,
        size: blob.size ?? 0,
        modified: '',
        isFolder: false,
      });
    }

    for (const folder of folders) {
      entries.push({
        name: folder.split('/').pop() ?? folder,
        path: folder,
        size: 0,
        modified: '',
        isFolder: true,
      });
    }

    if (entries.length === 0 && dir !== '') {
      // Distinguish "empty directory" from "no such directory".
      const meta = await this.contents(dir);
      if (!meta) throw new VaultNotFoundError(`Not found: ${dir}`);
    }

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return entries;
  }

  // ── move / delete ──────────────────────────────────────────────────────────

  async move(from: string, to: string): Promise<void> {
    const file = await this.readFile(from);
    await this.write(to, file.content);
    await this.remove(from);
  }

  async remove(path: string): Promise<void> {
    const meta = await this.contents(path);
    if (!meta || meta.type !== 'file') {
      throw new VaultNotFoundError(`Not found: ${path}`);
    }

    const repoRel = repoPath(this.vaultRoot, path);
    const res = await this.api(`/repos/${this.repo}/contents/${this.encodeApiPath(repoRel)}`, {
      method: 'DELETE',
      body: { message: `[vault] delete ${path}`, sha: meta.sha, branch: this.branch },
    });

    if (res.status === 404) throw new VaultNotFoundError(`Not found: ${path}`);
    if (res.status === 409) throw new EtagMismatchError();
    if (!res.ok) throw new Error(await this.errorText(res));
  }

  // ── search ─────────────────────────────────────────────────────────────────

  async search(query: string, scope?: string): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    if (!needle) return [];

    const scopePrefix = scope ? `${scope.replace(/^\/+|\/+$/g, '')}/` : '';
    const candidates = (await this.tree())
      .filter((e) => e.path.toLowerCase().endsWith('.md'))
      .map((e) => ({ entry: e, rel: this.blobPath(e) }))
      .filter(({ rel }) => !scopePrefix || rel.startsWith(scopePrefix))
      // Newest-first is not available from the tree API; path order keeps results stable.
      .sort((a, b) => (a.rel < b.rel ? -1 : 1))
      .slice(0, MAX_SEARCH_FILES);

    const hits: SearchHit[] = [];
    for (const { rel, entry } of candidates) {
      if ((entry.size ?? 0) > MAX_FILE_BYTES) continue;
      let text: string;
      try {
        text = await this.read(rel);
      } catch {
        continue;
      }
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      hits.push({
        path: rel,
        title: (rel.split('/').pop() ?? rel).replace(/\.md$/i, ''),
        snippet: snippetAround(text, idx, needle.length),
      });
    }
    return hits;
  }

  // ── changes ────────────────────────────────────────────────────────────────

  async changes(token?: string): Promise<ChangeSet> {
    const head = await this.headSha();

    if (!token) {
      // First poll: hand back a cursor and no changes. Reporting the entire history as
      // "changed" would make the first ingester run reprocess the whole vault.
      return { changes: [], nextToken: head };
    }

    if (token === head) {
      return { changes: [], nextToken: head };
    }

    const res = await this.api(
      `/repos/${this.repo}/compare/${encodeURIComponent(token)}...${encodeURIComponent(head)}`,
    );
    if (!res.ok) {
      // An unknown base (force-push, rebased branch) is not fatal: reset the cursor.
      if (res.status === 404 || res.status === 422) {
        return { changes: [], nextToken: head };
      }
      throw new Error(await this.errorText(res));
    }

    const data = (await res.json()) as {
      files?: Array<{ filename: string; status: string; additions?: number; deletions?: number }>;
    };

    const root = this.vaultRoot ? `${this.vaultRoot}/` : '';
    const changes: VaultEntry[] = [];

    for (const file of data.files ?? []) {
      if (root && !file.filename.startsWith(root)) continue;
      const rel = root ? file.filename.slice(root.length) : file.filename;
      if (!rel) continue;
      changes.push({
        name: rel.split('/').pop() ?? rel,
        path: rel,
        size: 0,
        modified: '',
        // The Compare API does not distinguish files from folders; a removed entry is
        // reported with status "removed", which the tool surfaces via `path` alone.
        isFolder: false,
      });
    }

    return { changes, nextToken: head };
  }
}
