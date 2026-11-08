/**
 * Environment-driven configuration and backend resolution.
 *
 * Fails fast with an actionable error naming the exact missing variables for the selected
 * backend. Never logs or throws a secret value — only variable names.
 */

export type BackendKind = 'onedrive' | 'github' | 'local';

export interface VaultConfig {
  kind: BackendKind;
  /** Folder inside the store that holds the vault (default "Obsidian"). */
  vaultRoot: string;
  /** OneDrive backend credentials. */
  msClientId: string;
  msTenantId: string;
  msRefreshToken: string;
  /** GitHub backend credentials. */
  githubToken: string;
  githubVaultRepo: string;
  githubVaultBranch: string;
  /** Local backend path (absolute). */
  vaultLocalPath: string;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(): VaultConfig {
  const raw = env('VAULT_BACKEND').toLowerCase() || 'onedrive';
  if (raw !== 'onedrive' && raw !== 'github' && raw !== 'local') {
    throw new ConfigError(
      `VAULT_BACKEND must be one of: onedrive | github | local (got "${raw}").`,
    );
  }
  const kind = raw as BackendKind;

  const config: VaultConfig = {
    kind,
    vaultRoot: env('VAULT_ROOT') || 'Obsidian',
    msClientId: env('MS_CLIENT_ID'),
    msTenantId: env('MS_TENANT_ID') || 'common',
    msRefreshToken: env('MS_REFRESH_TOKEN'),
    githubToken: env('GITHUB_TOKEN'),
    githubVaultRepo: env('GITHUB_VAULT_REPO'),
    githubVaultBranch: env('GITHUB_VAULT_BRANCH') || 'main',
    vaultLocalPath: env('VAULT_LOCAL_PATH'),
  };

  const missing: string[] = [];
  switch (kind) {
    case 'onedrive':
      if (!config.msClientId) missing.push('MS_CLIENT_ID');
      if (!config.msTenantId) missing.push('MS_TENANT_ID');
      if (!config.msRefreshToken) missing.push('MS_REFRESH_TOKEN');
      if (missing.length > 0) {
        throw new ConfigError(
          `The OneDrive backend needs these environment variables, which are missing: ` +
            `${missing.join(', ')}. Set them in .env (or ~/.hermes/.env) — see ` +
            `docs/CREDENTIALS.md, "Microsoft Graph credentials".`,
        );
      }
      break;
    case 'github':
      if (!config.githubToken) missing.push('GITHUB_TOKEN');
      if (!config.githubVaultRepo) missing.push('GITHUB_VAULT_REPO');
      if (missing.length > 0) {
        throw new ConfigError(
          `The GitHub backend needs these environment variables, which are missing: ` +
            `${missing.join(', ')}. GITHUB_TOKEN is a repo-scoped personal access token; ` +
            `GITHUB_VAULT_REPO is "owner/repo" holding the vault — see docs/CREDENTIALS.md, ` +
            `"GitHub credentials".`,
        );
      }
      if (!config.githubVaultRepo.includes('/')) {
        throw new ConfigError(
          `GITHUB_VAULT_REPO must be in "owner/repo" form (got a value without a "/").`,
        );
      }
      break;
    case 'local':
      if (!config.vaultLocalPath) {
        throw new ConfigError(
          `The local backend needs VAULT_LOCAL_PATH — an absolute path to the directory ` +
            `holding the vault. VAULT_ROOT is ignored unless the vault is nested inside it.`,
        );
      }
      break;
  }

  return config;
}
