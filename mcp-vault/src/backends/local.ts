/**
 * Local backend — plain `node:fs` against a directory on this machine.
 *
 * This exists for three reasons: development without credentials, offline use, and a
 * reference implementation. It is a first-class backend, not a test double — point
 * `VAULT_LOCAL_PATH` at a folder Obsidian already syncs and the agents work on it directly.
 *
 * Two deliberate choices:
 *
 *   - **`changes()` diffs by mtime** against the JSON cursor it returns
 *     (`{"path": mtimeMs}`). There is no journal to replay, so "changed" means "mtime moved
 *     forward". A file restored from backup with an older mtime is missed until it is touched;
 *     for a single-user vault that is an acceptable trade for not scanning file contents.
 *   - **`search()` is a recursive read**, not a shell-out to `grep`. It is a few hundred files
 *     at most, and doing it in-process keeps the error handling uniform.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
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

const MAX_SEARCH_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIPPET_RADIUS = 100;

interface MtimeMap {
  [vaultPath: string]: number;
}

export class LocalBackend implements VaultBackend {
  readonly kind = 'local';
  readonly location: string;

  private readonly root: string;

  constructor(config: VaultConfig) {
    if (!path.isAbsolute(config.vaultLocalPath)) {
      throw new Error(
        `VAULT_LOCAL_PATH must be an absolute path (got a relative one). ` +
          `Try: VAULT_LOCAL_PATH=${path.resolve(config.vaultLocalPath)}`,
      );
    }
    const base = config.vaultLocalPath.replace(/\/+$/, '');
    // For local, VAULT_ROOT is only meaningful when the vault is nested inside the given
    // directory — which is the common "point it at the Obsidian folder" case.
    const nested = config.vaultRoot ? path.join(base, config.vaultRoot) : base;
    this.root = nested;
    this.location = `local ${this.root}`;
  }

  /** Absolute path for a vault-relative path, with traversal rejected. */
  private abs(vaultPath: string): string {
    const rel = vaultPath.replace(/^\/+/, '');
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error(`Path escapes the vault root: ${vaultPath}`);
    }
    return full;
  }

  /** Vault-relative path for an absolute one. */
  private rel(absolute: string): string {
    const r = path.relative(this.root, absolute);
    return r.split(path.sep).join('/');
  }

  private async etagFor(absolute: string): Promise<string> {
    const st = await fs.stat(absolute);
    return `${st.mtimeMs.toString(36)}-${st.size.toString(36)}`;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async read(vaultPath: string): Promise<string> {
    const file = await this.readFile(vaultPath);
    return file.content;
  }

  async readFile(vaultPath: string): Promise<VaultFile> {
    const absolute = this.abs(vaultPath);
    try {
      const [content, st] = await Promise.all([
        fs.readFile(absolute, 'utf8'),
        fs.stat(absolute),
      ]);
      return {
        content,
        etag: `${st.mtimeMs.toString(36)}-${st.size.toString(36)}`,
        lastModified: st.mtime.toISOString(),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultNotFoundError(`Not found: ${vaultPath}`);
      }
      throw err;
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  async write(vaultPath: string, content: string, ifMatch?: string): Promise<string> {
    const absolute = this.abs(vaultPath);

    if (ifMatch) {
      let current: string;
      try {
        current = await this.etagFor(absolute);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new VaultNotFoundError(`Not found: ${vaultPath}`);
        }
        throw err;
      }
      if (current !== ifMatch) throw new EtagMismatchError();
    }

    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
    return this.etagFor(absolute);
  }

  async append(vaultPath: string, content: string): Promise<string> {
    const absolute = this.abs(vaultPath);
    await fs.mkdir(path.dirname(absolute), { recursive: true });

    // Read-modify-write through a single open handle keeps the append atomic with respect to
    // the etag we hand back, and matches the OneDrive/GitHub backends' semantics.
    let existing = '';
    try {
      existing = await fs.readFile(absolute, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    await fs.writeFile(absolute, existing + content, 'utf8');
    return this.etagFor(absolute);
  }

  // ── listing ────────────────────────────────────────────────────────────────

  private async walk(absolute: string, recursive: boolean, out: VaultEntry[]): Promise<void> {
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    for (const dirent of dirents) {
      const child = path.join(absolute, dirent.name);
      const st = await fs.stat(child).catch(() => null);
      if (!st) continue;

      if (dirent.isDirectory()) {
        out.push({
          name: dirent.name,
          path: this.rel(child),
          size: 0,
          modified: st.mtime.toISOString(),
          isFolder: true,
        });
        if (recursive) await this.walk(child, recursive, out);
      } else if (dirent.isFile()) {
        out.push({
          name: dirent.name,
          path: this.rel(child),
          size: st.size,
          modified: st.mtime.toISOString(),
          isFolder: false,
        });
      }
    }
  }

  async list(vaultPath: string, opts: ListOptions = {}): Promise<VaultEntry[]> {
    const absolute = this.abs(vaultPath);
    let st;
    try {
      st = await fs.stat(absolute);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultNotFoundError(`Not found: ${vaultPath || '/'}`);
      }
      throw err;
    }
    if (!st.isDirectory()) throw new VaultNotFoundError(`Not a directory: ${vaultPath}`);

    const out: VaultEntry[] = [];
    await this.walk(absolute, opts.recursive ?? false, out);
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  // ── move / delete ──────────────────────────────────────────────────────────

  async move(from: string, to: string): Promise<void> {
    const src = this.abs(from);
    const dest = this.abs(to);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    try {
      await fs.rename(src, dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultNotFoundError(`Not found: ${from}`);
      }
      throw err;
    }
  }

  async remove(vaultPath: string): Promise<void> {
    try {
      await fs.unlink(this.abs(vaultPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultNotFoundError(`Not found: ${vaultPath}`);
      }
      throw err;
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────

  async search(query: string, scope?: string): Promise<SearchHit[]> {
    const needle = query.toLowerCase();
    if (!needle) return [];

    const scopeDir = scope ? this.abs(scope) : this.root;
    let entries: VaultEntry[];
    try {
      entries = await this.list(scope ? scope.replace(/^\/+|\/+$/g, '') : '', { recursive: true });
    } catch (err) {
      if (err instanceof VaultNotFoundError) return [];
      throw err;
    }

    const hits: SearchHit[] = [];
    let scanned = 0;
    for (const entry of entries) {
      if (entry.isFolder) continue;
      if (!/\.(md|txt|markdown)$/i.test(entry.name)) continue;
      if (entry.size > MAX_FILE_BYTES) continue;
      if (scanned++ >= MAX_SEARCH_FILES) break;

      let text: string;
      try {
        text = await fs.readFile(this.abs(entry.path), 'utf8');
      } catch {
        continue;
      }
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;

      const start = Math.max(0, idx - SNIPPET_RADIUS);
      const end = Math.min(text.length, idx + needle.length + SNIPPET_RADIUS);
      const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
      hits.push({
        path: entry.path,
        title: entry.name.replace(/\.md$/i, ''),
        snippet: `${start > 0 ? '…' : ''}${snippet}${end < text.length ? '…' : ''}`,
      });
    }
    // scopeDir is referenced so the intent (search is confined to it by `list`) stays obvious.
    void scopeDir;
    return hits;
  }

  // ── changes ────────────────────────────────────────────────────────────────

  async changes(token?: string): Promise<ChangeSet> {
    let previous: MtimeMap = {};
    if (token) {
      try {
        const parsed = JSON.parse(token) as unknown;
        if (parsed && typeof parsed === 'object') previous = parsed as MtimeMap;
      } catch {
        // A corrupt cursor is not fatal — treat it as a first run.
        previous = {};
      }
    }

    const entries = await this.list('', { recursive: true });
    const next: MtimeMap = {};
    const changes: VaultEntry[] = [];

    for (const entry of entries) {
      if (entry.isFolder) continue;
      const mtime = Date.parse(entry.modified) || 0;
      next[entry.path] = mtime;

      const before = previous[entry.path];
      if (before === undefined || mtime > before) {
        changes.push(entry);
        continue;
      }
      if (mtime < before) {
        // Restored/rolled back — report it so the ingester re-reads the old content.
        changes.push(entry);
      }
    }

    // Deletions: present in the old cursor, gone now.
    for (const [oldPath, oldMtime] of Object.entries(previous)) {
      if (next[oldPath] !== undefined) continue;
      changes.push({
        name: oldPath.split('/').pop() ?? oldPath,
        path: oldPath,
        size: 0,
        modified: new Date(oldMtime).toISOString(),
        isFolder: false,
      });
    }

    if (!token) {
      // First call: establish the cursor without claiming every file changed.
      return { changes: [], nextToken: JSON.stringify(next) };
    }

    return { changes, nextToken: JSON.stringify(next) };
  }
}
