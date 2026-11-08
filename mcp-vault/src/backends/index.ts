/**
 * Backend factory.
 *
 * Adding a new storage backend is three steps:
 *   1. Implement `VaultBackend` from `./types.js`.
 *   2. Add its credential fields to `VaultConfig` and validate them in `config.ts`.
 *   3. Add a `case` below.
 * Nothing above this file changes — the tools only ever see the interface.
 */

import type { VaultBackend } from './types.js';
import type { VaultConfig } from '../config.js';
import { OneDriveBackend } from './onedrive.js';
import { GitHubBackend } from './github.js';
import { LocalBackend } from './local.js';

export type { VaultBackend, VaultEntry, SearchHit, ChangeSet, VaultFile } from './types.js';
export { EtagMismatchError, VaultNotFoundError } from './types.js';

export function createBackend(config: VaultConfig): VaultBackend {
  switch (config.kind) {
    case 'onedrive':
      return new OneDriveBackend(config);
    case 'github':
      return new GitHubBackend(config);
    case 'local':
      return new LocalBackend(config);
    default: {
      // Exhaustiveness guard: adding a BackendKind without a case is a compile error.
      const never: never = config.kind;
      throw new Error(`Unsupported VAULT_BACKEND: ${String(never)}`);
    }
  }
}
