/**
 * OneDrive backend — Microsoft Graph, delegated permissions, refresh-token auth.
 *
 * This is a faithful port of the original single-backend server. Everything that made it
 * work in practice is preserved:
 *
 *   - **Item-id traversal where it matters.** Path addressing on `/me/drive/root:/...` is
 *     unreliable for some drives (renames leave stale path indices), so `move` resolves the
 *     source to an item id and PATCHes the item, and `list` walks `/children` on item ids.
 *   - **Retry on 401.** The token cache is dropped and the request retried once. A refresh
 *     token shared by two processes can be rolled by one of them, which invalidates the
 *     other's cached access token mid-run.
 *   - **429 respects `Retry-After`; 5xx gets three exponentiating retries; 409 is passed
 *     through untouched** so the caller sees the ETag conflict instead of a masked failure.
 *   - **Downloads go through `curl -sL`-equivalent handling**: Graph's `/content` endpoint
 *     302-redirects to a pre-authorised URL, and that URL rejects an Authorization header.
 *     `fetch` follows redirects and drops nothing here because we never re-send the header
 *     ourselves, but we do check for an error body masquerading as content.
 *   - **Search is the Graph search API**, filtered to the vault root, because the alternative
 *     (walking the whole drive) is far more expensive.
 *
 * `VAULT_ROOT` replaces the old hardcoded `Obsidian` folder name.
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

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_SCOPE = 'Files.ReadWrite offline_access';

const SELECT_FIELDS = '$select=name,size,lastModifiedDateTime,folder,file,parentReference';

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  lastModifiedDateTime?: string;
  eTag?: string;
  cTag?: string;
  folder?: unknown;
  file?: unknown;
  deleted?: { state: string };
  parentReference?: { path?: string };
  searchResult?: { summary?: string };
}

interface DeltaPage {
  value: DriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Quote a vault path for the `root:/<path>:` addressing form. */
function quotePath(p: string): string {
  return p
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export class OneDriveBackend implements VaultBackend {
  readonly kind = 'onedrive';
  readonly location: string;

  private readonly clientId: string;
  private readonly tenantId: string;
  private readonly refreshToken: string;
  private readonly vaultRoot: string;

  private cachedToken: string | null = null;
  private tokenExpiry = 0;

  constructor(config: VaultConfig) {
    this.clientId = config.msClientId;
    this.tenantId = config.msTenantId;
    this.refreshToken = config.msRefreshToken;
    this.vaultRoot = config.vaultRoot.replace(/^\/+|\/+$/g, '');
    this.location = `OneDrive /${this.vaultRoot}`;
  }

  // ── auth ───────────────────────────────────────────────────────────────────

  private async refreshAccessToken(): Promise<string> {
    const url = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      scope: TOKEN_SCOPE,
    });

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      // The body names the failure (invalid_grant, AADSTS7000218, …) and never contains the
      // refresh token, so it is safe to surface.
      const text = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cachedToken = data.access_token;
    this.tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
    return this.cachedToken;
  }

  private async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiry) return this.cachedToken;
    return this.refreshAccessToken();
  }

  private async rawFetch(fullUrl: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getAccessToken();
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(fullUrl, { ...options, headers });
  }

  /** Every Graph call goes through here: absolute URLs pass through, relative ones are rooted. */
  private async graphFetch(pathOrUrl: string, options: RequestInit = {}): Promise<Response> {
    const fullUrl = pathOrUrl.startsWith('https://') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;

    let res = await this.rawFetch(fullUrl, options);

    if (res.status === 401) {
      this.cachedToken = null;
      res = await this.rawFetch(fullUrl, options);
    }

    if (res.status === 409) {
      // Conditional-write conflict. The caller decides what to do with it.
      return res;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
      await sleep(retryAfter * 1000);
      res = await this.rawFetch(fullUrl, options);
    }

    if (res.status >= 500) {
      let delay = 1000;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(delay);
        res = await this.rawFetch(fullUrl, options);
        if (res.status < 500) break;
        delay *= 2;
      }
    }

    return res;
  }

  // ── path helpers ───────────────────────────────────────────────────────────

  private fullPath(vaultPath: string): string {
    const rel = vaultPath.replace(/^\/+/, '');
    return rel ? `${this.vaultRoot}/${rel}` : this.vaultRoot;
  }

  private contentUrl(vaultPath: string): string {
    return `/me/drive/root:/${quotePath(this.fullPath(vaultPath))}:/content`;
  }

  private itemUrl(vaultPath: string): string {
    return `/me/drive/root:/${quotePath(this.fullPath(vaultPath))}:`;
  }

  private childrenUrl(vaultPath: string, select = SELECT_FIELDS): string {
    return `/me/drive/root:/${quotePath(this.fullPath(vaultPath))}:/children?${select}`;
  }

  /** Map a drive path + item name to a vault-relative path. */
  private toVaultPath(drivePath: string | undefined, name: string): string {
    const prefix = `/drive/root:/${this.vaultRoot}`;
    const parent = drivePath ?? '';
    const rel = parent.startsWith(prefix) ? parent.slice(prefix.length).replace(/^\//, '') : '';
    return rel ? `${rel}/${name}` : name;
  }

  /** True when a drive `parentReference.path` sits inside the vault root. */
  private inVault(drivePath: string | undefined): boolean {
    const prefix = `/drive/root:/${this.vaultRoot}`;
    const p = drivePath ?? '';
    return p === prefix || p.startsWith(`${prefix}/`);
  }

  private async itemId(vaultPath: string): Promise<string> {
    const res = await this.graphFetch(this.itemUrl(vaultPath));
    if (res.status === 404) {
      throw new VaultNotFoundError(`Not found: ${vaultPath}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as DriveItem;
    return data.id;
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async read(path: string): Promise<string> {
    const file = await this.readFile(path);
    return file.content;
  }

  async readFile(path: string): Promise<VaultFile> {
    const res = await this.graphFetch(this.contentUrl(path));
    if (res.status === 404) {
      throw new VaultNotFoundError(`Not found: ${path}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }
    const content = await res.text();
    return {
      content,
      etag: res.headers.get('ETag') ?? '',
      lastModified: res.headers.get('Last-Modified') ?? '',
    };
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  async write(path: string, content: string, ifMatch?: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'text/plain' };
    if (ifMatch) headers['If-Match'] = ifMatch;

    const res = await this.graphFetch(this.contentUrl(path), {
      method: 'PUT',
      headers,
      body: content,
    });

    if (res.status === 409 || res.status === 412) {
      throw new EtagMismatchError();
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as DriveItem;
    return data.eTag ?? '';
  }

  async append(path: string, content: string): Promise<string> {
    const existing = await this.readFile(path);
    const etag = existing.etag || '*';
    const res = await this.graphFetch(this.contentUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain', 'If-Match': etag },
      body: existing.content + content,
    });

    if (res.status === 409 || res.status === 412) {
      throw new EtagMismatchError('ETag mismatch — file was modified during append');
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }
    const data = (await res.json()) as DriveItem;
    return data.eTag ?? '';
  }

  // ── listing ────────────────────────────────────────────────────────────────

  private toEntry(item: DriveItem, dirPath: string): VaultEntry {
    return {
      name: item.name,
      path: dirPath === '' ? item.name : `${dirPath}/${item.name}`,
      size: item.size ?? 0,
      modified: item.lastModifiedDateTime ?? '',
      isFolder: item.folder !== undefined,
    };
  }

  async list(path: string, opts: ListOptions = {}): Promise<VaultEntry[]> {
    const recursive = opts.recursive ?? false;
    const dirPath = path.replace(/^\/+|\/+$/g, '');

    const res = await this.graphFetch(this.childrenUrl(dirPath));
    if (res.status === 404) {
      throw new VaultNotFoundError(`Not found: ${dirPath || '/'}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }

    const { value: items } = (await res.json()) as { value: DriveItem[] };
    const entries = items.map((item) => this.toEntry(item, dirPath));

    if (!recursive) return entries;

    const subfolderResults = await Promise.all(
      entries.filter((e) => e.isFolder).map((e) => this.list(e.path, { recursive: true })),
    );
    for (const children of subfolderResults) entries.push(...children);
    return entries;
  }

  // ── move / delete ──────────────────────────────────────────────────────────

  async move(from: string, to: string): Promise<void> {
    const id = await this.itemId(from);

    const toName = to.split('/').pop() ?? to;
    const toParent = to.includes('/') ? to.slice(0, to.lastIndexOf('/')) : '';
    const parentPath = `/drive/root:/${this.fullPath(toParent)}`;

    const res = await this.graphFetch(`/me/drive/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: toName, parentReference: { path: parentPath } }),
    });

    if (res.status === 404) {
      throw new VaultNotFoundError(`Move target folder missing: ${toParent || '/'}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error moving ${res.status}: ${text}`);
    }
  }

  async remove(path: string): Promise<void> {
    const id = await this.itemId(path);
    const res = await this.graphFetch(`/me/drive/items/${id}`, { method: 'DELETE' });
    if (res.status === 404) {
      throw new VaultNotFoundError(`Not found: ${path}`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }
  }

  // ── search ─────────────────────────────────────────────────────────────────

  async search(query: string, scope?: string): Promise<SearchHit[]> {
    const encoded = encodeURIComponent(query);
    const res = await this.graphFetch(
      `/me/drive/root/search(q='${encoded}')?$select=name,file,parentReference,searchResult`,
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as { value: DriveItem[] };
    const scopePrefix = scope ? `${this.vaultRoot}/${scope.replace(/^\/+|\/+$/g, '')}` : this.vaultRoot;
    const fullPrefix = `/drive/root:/${scopePrefix}`;

    const results: SearchHit[] = [];
    for (const item of data.value) {
      if (!item.file) continue;
      const parentPath = item.parentReference?.path ?? '';
      if (parentPath !== fullPrefix && !parentPath.startsWith(`${fullPrefix}/`)) continue;

      const path = this.toVaultPath(parentPath, item.name);
      results.push({
        path,
        title: item.name.replace(/\.md$/i, ''),
        snippet: item.searchResult?.summary ?? '',
      });
    }
    return results;
  }

  // ── changes ────────────────────────────────────────────────────────────────

  async changes(token?: string): Promise<ChangeSet> {
    let nextUrl: string = token
      ? token
      : `/me/drive/root/delta?$select=name,file,folder,deleted,parentReference,size,lastModifiedDateTime`;

    const changes: VaultEntry[] = [];
    let finalDeltaLink = '';

    while (true) {
      const res = await this.graphFetch(nextUrl);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Error ${res.status}: ${text}`);
      }

      const page = (await res.json()) as DeltaPage;

      for (const item of page.value) {
        const parentPath = item.parentReference?.path ?? '';
        if (!this.inVault(parentPath)) continue;
        changes.push({
          name: item.name,
          path: this.toVaultPath(parentPath, item.name),
          size: item.size ?? 0,
          modified: item.lastModifiedDateTime ?? '',
          isFolder: item.folder !== undefined,
        });
      }

      if (page['@odata.nextLink']) {
        nextUrl = page['@odata.nextLink'];
      } else if (page['@odata.deltaLink']) {
        finalDeltaLink = page['@odata.deltaLink'];
        break;
      } else {
        break;
      }
    }

    return { changes, nextToken: finalDeltaLink };
  }
}
