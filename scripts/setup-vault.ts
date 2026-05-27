/**
 * scripts/setup-vault.ts
 *
 * Creates the OneDrive/Obsidian vault folder structure and seeds initial files.
 * Safe to re-run — skips folders and files that already exist.
 *
 * Prerequisites:
 *   MS_CLIENT_ID, MS_TENANT_ID, MS_REFRESH_TOKEN must be in the environment.
 *   Run setup-onedrive-auth.ts first to obtain the refresh token.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-vault.ts
 */

import fs from 'fs';
import path from 'path';

const clientId = process.env.MS_CLIENT_ID;
const tenantId = process.env.MS_TENANT_ID;
const refreshToken = process.env.MS_REFRESH_TOKEN;

if (!clientId || !tenantId || !refreshToken) {
  console.error(
    'Error: MS_CLIENT_ID, MS_TENANT_ID, and MS_REFRESH_TOKEN must be set.\n' +
      'Run scripts/setup-onedrive-auth.ts first to obtain the refresh token.',
  );
  process.exit(1);
}

const GRAPH = 'https://graph.microsoft.com/v1.0';

async function getAccessToken(): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId!,
        grant_type: 'refresh_token',
        refresh_token: refreshToken!,
        scope: 'Files.ReadWrite offline_access',
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// Create a folder. 409 = already exists (ok). Any other non-2xx = error.
async function ensureFolder(
  token: string,
  childrenEndpoint: string,
  name: string,
  label: string,
): Promise<void> {
  const res = await fetch(childrenEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'fail',
    }),
  });

  if (res.status === 409) {
    console.log(`  ✓ ${label}/ (exists)`);
    return;
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create ${label}/: ${body}`);
  }
  console.log(`  + ${label}/`);
}

// Upload a file only if it does not already exist.
async function createFileIfMissing(
  token: string,
  vaultRelPath: string,
  content: string,
): Promise<void> {
  const checkRes = await fetch(
    `${GRAPH}/me/drive/root:/Obsidian/${vaultRelPath}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (checkRes.ok) {
    console.log(`  ✓ ${vaultRelPath} (exists)`);
    return;
  }

  const uploadRes = await fetch(
    `${GRAPH}/me/drive/root:/Obsidian/${vaultRelPath}:/content`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: content,
    },
  );

  if (!uploadRes.ok) {
    const body = await uploadRes.text();
    throw new Error(`Failed to create ${vaultRelPath}: ${body}`);
  }
  console.log(`  + ${vaultRelPath}`);
}

async function main(): Promise<void> {
  console.log('Obtaining OneDrive access token...');
  const token = await getAccessToken();
  console.log('Token obtained.\n');

  // ── Folders ──────────────────────────────────────────────────────────────────
  console.log('Creating vault folder structure...');

  // Vault root under OneDrive root
  await ensureFolder(
    token,
    `${GRAPH}/me/drive/root/children`,
    'Obsidian',
    'Obsidian',
  );

  // Top-level directories
  for (const dir of ['sources', 'wiki', '.meta']) {
    await ensureFolder(
      token,
      `${GRAPH}/me/drive/root:/Obsidian:/children`,
      dir,
      `Obsidian/${dir}`,
    );
  }

  // sources/ subdirectories
  for (const dir of ['_inbox', 'articles', 'voice-notes', 'conversations', 'books', 'drafts']) {
    await ensureFolder(
      token,
      `${GRAPH}/me/drive/root:/Obsidian/sources:/children`,
      dir,
      `Obsidian/sources/${dir}`,
    );
  }

  // wiki/ subdirectories
  for (const dir of ['concepts', 'people', 'projects', 'questions', 'syntheses']) {
    await ensureFolder(
      token,
      `${GRAPH}/me/drive/root:/Obsidian/wiki:/children`,
      dir,
      `Obsidian/wiki/${dir}`,
    );
  }

  // ── Initial files ─────────────────────────────────────────────────────────────
  console.log('\nSeeding initial files...');

  // CLAUDE.md — vault schema (from template in this repo)
  const templatePath = path.resolve(
    import.meta.dirname,
    '..',
    'docs',
    'second-brain-vault-claude.md',
  );
  const claudeMdContent = fs.readFileSync(templatePath, 'utf-8');
  await createFileIfMissing(token, 'CLAUDE.md', claudeMdContent);

  // wiki/index.md
  const today = new Date().toISOString().slice(0, 10);
  await createFileIfMissing(
    token,
    'wiki/index.md',
    [
      '# Index',
      '',
      '<!-- Agent-maintained catalog. Each wiki page has one entry here. -->',
      '',
      `Created: ${today}`,
      '',
    ].join('\n'),
  );

  // wiki/log.md
  await createFileIfMissing(
    token,
    'wiki/log.md',
    [
      '# Log',
      '',
      '<!-- Append-only agent change log. -->',
      '',
      `## ${new Date().toISOString().slice(0, 19)}Z — setup`,
      '- Vault initialized by setup-vault.ts',
      '',
    ].join('\n'),
  );

  // .meta/ state files
  await createFileIfMissing(token, '.meta/processed.json', '{"processed":[]}\n');
  await createFileIfMissing(token, '.meta/delta_token.json', '{}\n');
  await createFileIfMissing(token, '.meta/last_lint.json', '{}\n');

  console.log('\nVault setup complete.');
  console.log('Open OneDrive/Obsidian/ in Obsidian to verify the structure.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
