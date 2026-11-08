/**
 * The storage contract every backend implements.
 *
 * All paths are **vault-root-relative** and carry no leading slash: `wiki/index.md`,
 * `sources/_inbox/note.md`. The backend translates that to whatever its store needs — a
 * Graph item id, a repo path, a filesystem path. Nothing above this layer knows which.
 *
 * Paths are also the only thing the tools pass around, so a backend must not leak store
 * specific ids into `VaultEntry` — `path` is always the vault-relative path.
 */

/** One entry in a directory listing or a change feed. */
export interface VaultEntry {
  /** Base name, e.g. `index.md`. */
  name: string;
  /** Vault-relative path, e.g. `wiki/index.md`. */
  path: string;
  /** Byte length, or 0 when the store does not report one. */
  size: number;
  /** ISO-8601 timestamp, or '' when the store does not report one. */
  modified: string;
  isFolder: boolean;
}

/** One search result. */
export interface SearchHit {
  /** Vault-relative path of the matching file. */
  path: string;
  /** Page title, derived from the file name. */
  title: string;
  /** Short excerpt around the match; may be '' when the store returns no summary. */
  snippet: string;
}

/** The result of a `changes()` poll. */
export interface ChangeSet {
  changes: VaultEntry[];
  /**
   * Opaque cursor to hand back on the next call. Never parse it above this layer — each
   * backend stores whatever it needs (a Graph nextLink, a commit sha, a JSON mtime map).
   */
  nextToken: string;
}

export interface ListOptions {
  recursive?: boolean;
}

/** Thrown by a conditional write when the file changed underneath the caller. */
export class EtagMismatchError extends Error {
  constructor(message = 'ETag mismatch — file was modified') {
    super(message);
    this.name = 'EtagMismatchError';
  }
}

/** The result of a read that also reports concurrency metadata. */
export interface VaultFile {
  content: string;
  /** Opaque concurrency token. Empty string when the backend has none. */
  etag: string;
  /** ISO-8601 modification time, or '' when unknown. */
  lastModified: string;
}

export interface VaultBackend {
  /** Backend identifier, for logs: `onedrive`, `github`, or `local`. */
  readonly kind: string;
  /** Human-readable description of where the vault lives, safe to log (no secrets). */
  readonly location: string;

  /** Read a file as UTF-8 text. Throws if it does not exist. */
  read(path: string): Promise<string>;

  /**
   * Read a file plus its concurrency metadata. The `read_note` tool uses this so `etag`
   * can be handed back to `write` — that is what keeps conditional writes working across
   * every backend.
   */
  readFile(path: string): Promise<VaultFile>;

  /**
   * Create or overwrite a file. Missing parent folders are created.
   * Pass `ifMatch` (an etag from `readFile`) to make the write conditional; the backend
   * throws `EtagMismatchError` when the file changed underneath you.
   * Returns the new etag ('' when the backend has none).
   */
  write(path: string, content: string, ifMatch?: string): Promise<string>;

  /**
   * Append to a file, creating it if absent. Read-modify-write, guarded with the etag the
   * read returned where the store supports it, so a concurrent writer surfaces as an
   * `EtagMismatchError` rather than a silent clobber.
   * Returns the new etag ('' when the backend has none).
   */
  append(path: string, content: string): Promise<string>;

  /** List a directory. `path` may be '' for the vault root. */
  list(path: string, opts?: ListOptions): Promise<VaultEntry[]>;

  /** Move (rename and/or relocate) a file. Throws if the source is missing. */
  move(from: string, to: string): Promise<void>;

  /** Delete a file. Throws if it does not exist. */
  remove(path: string): Promise<void>;

  /** Case-insensitive substring search, optionally confined to a subdirectory. */
  search(query: string, scope?: string): Promise<SearchHit[]>;

  /** Files changed since `token`; with no token, an empty set plus the current cursor. */
  changes(token?: string): Promise<ChangeSet>;
}

/** Shape of every error a backend raises for a missing object. */
export class VaultNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotFoundError';
  }
}
