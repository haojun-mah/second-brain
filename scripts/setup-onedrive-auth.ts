/**
 * scripts/setup-onedrive-auth.ts
 *
 * Runs the Microsoft OAuth device code flow to obtain a refresh token for
 * OneDrive access, then stores it in the OneCLI vault as
 * "ms-onedrive-refresh-token".
 *
 * Prerequisites:
 *   1. Register an app in Azure Portal → App registrations.
 *      - Add a Mobile/desktop platform with redirect URI:
 *        https://login.microsoftonline.com/common/oauth2/nativeclient
 *      - Grant the delegated permission: Files.ReadWrite
 *   2. Copy the Application (client) ID → MS_CLIENT_ID in .env
 *   3. Copy the Directory (tenant) ID  → MS_TENANT_ID  in .env
 *      (Use "common" for multi-tenant / personal accounts.)
 *   4. onecli must be installed and the vault must be running.
 *
 * Usage:
 *   pnpm exec tsx scripts/setup-onedrive-auth.ts
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const clientId = process.env.MS_CLIENT_ID;
const tenantId = process.env.MS_TENANT_ID;

if (!clientId || !tenantId) {
  console.error(
    'Error: MS_CLIENT_ID and MS_TENANT_ID must be set in .env before running this script.\n' +
      'See .env.example for instructions.',
  );
  process.exit(1);
}

const BASE = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0`;

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface TokenResponse {
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const res = await fetch(`${BASE}/devicecode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId!,
      scope: 'Files.ReadWrite offline_access',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Device code request failed (${res.status}): ${body}`);
    process.exit(1);
  }

  return res.json() as Promise<DeviceCodeResponse>;
}

async function pollForToken(
  deviceCode: string,
  intervalSecs: number,
): Promise<string> {
  let interval = intervalSecs;

  while (true) {
    await new Promise((r) => setTimeout(r, interval * 1000));

    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId!,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }),
    });

    const data = (await res.json()) as TokenResponse;

    if (data.refresh_token) {
      return data.refresh_token;
    }

    switch (data.error) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        interval += 5;
        break;
      case 'expired_token':
        console.error('Error: The device code has expired. Please run the script again.');
        process.exit(1);
      default:
        console.error(
          `Error polling for token: ${data.error} — ${data.error_description ?? ''}`,
        );
        process.exit(1);
    }
  }
}

function writeToEnvFile(filePath: string, key: string, value: string): void {
  const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
  const re = new RegExp(`^${key}=.*$`, 'm');
  const updated = re.test(content)
    ? content.replace(re, `${key}=${value}`)
    : content.trimEnd() + (content ? '\n' : '') + `${key}=${value}\n`;
  fs.writeFileSync(filePath, updated);
}

// Inject MS credentials into the DB mcp_servers config for all second-brain
// agent groups, then regenerate their container.json files. This is the only
// place secrets should enter container config — never hand-edited.
function updateAgentGroupCredentials(refreshToken: string): void {
  const root = path.resolve(import.meta.dirname, '..');
  const dbPath = path.join(root, 'data', 'v2.db');

  if (!fs.existsSync(dbPath)) {
    console.log('  DB not found — skipping agent group credential update (run after setup:auto)');
    return;
  }

  const db = new Database(dbPath);

  const SECOND_BRAIN_GROUPS = ['ingester', 'query', 'linter'];

  for (const folder of SECOND_BRAIN_GROUPS) {
    const group = db.prepare('SELECT id, name FROM agent_groups WHERE folder = ?').get(folder) as
      | { id: string; name: string }
      | undefined;
    if (!group) {
      console.log(`  ${folder}: group not found in DB — skipping`);
      continue;
    }

    const row = db.prepare('SELECT * FROM container_configs WHERE agent_group_id = ?').get(group.id) as
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Record<string, any> | undefined;
    if (!row) {
      console.log(`  ${folder}: no container_config row — skipping`);
      continue;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mcpServers = JSON.parse(row.mcp_servers as string) as Record<string, any>;
    if (!mcpServers.onedrive) {
      console.log(`  ${folder}: no onedrive MCP server in config — skipping`);
      continue;
    }

    // Replace env wholesale — no stale keys left behind.
    mcpServers.onedrive.env = {
      MS_CLIENT_ID: clientId,
      MS_TENANT_ID: tenantId,
      MS_REFRESH_TOKEN: refreshToken,
      // Bypass the OneCLI proxy for Microsoft auth/data endpoints.
      NO_PROXY: 'login.microsoftonline.com,graph.microsoft.com',
    };

    db.prepare('UPDATE container_configs SET mcp_servers = ?, updated_at = ? WHERE agent_group_id = ?').run(
      JSON.stringify(mcpServers),
      new Date().toISOString(),
      group.id,
    );

    // Regenerate container.json from updated DB data so the next spawn picks
    // up the change without requiring a host restart.
    const containerConfig = {
      mcpServers,
      packages: {
        apt: JSON.parse(row.packages_apt as string ?? '[]') as string[],
        npm: JSON.parse(row.packages_npm as string ?? '[]') as string[],
      },
      ...(row.image_tag ? { imageTag: row.image_tag as string } : {}),
      additionalMounts: JSON.parse(row.additional_mounts as string ?? '[]'),
      skills: JSON.parse(row.skills as string ?? '"all"'),
      ...(row.provider ? { provider: row.provider as string } : {}),
      groupName: group.name,
      assistantName: (row.assistant_name as string | null) ?? group.name,
      agentGroupId: group.id,
      ...(row.max_messages_per_prompt != null ? { maxMessagesPerPrompt: row.max_messages_per_prompt as number } : {}),
      ...(row.model ? { model: row.model as string } : {}),
      ...(row.effort ? { effort: row.effort as string } : {}),
    };

    const containerJsonPath = path.join(root, 'groups', folder, 'container.json');
    fs.mkdirSync(path.dirname(containerJsonPath), { recursive: true });
    fs.writeFileSync(containerJsonPath, JSON.stringify(containerConfig, null, 2) + '\n');

    console.log(`  ${folder}: DB + container.json updated`);
  }

  db.close();
}

function persistRefreshToken(refreshToken: string): void {
  const root = path.resolve(import.meta.dirname, '..');
  const envFile = path.join(root, '.env');
  const containerEnvFile = path.join(root, 'data', 'env', 'env');

  writeToEnvFile(envFile, 'MS_REFRESH_TOKEN', refreshToken);
  console.log(`  Written to .env`);

  fs.mkdirSync(path.dirname(containerEnvFile), { recursive: true });
  writeToEnvFile(containerEnvFile, 'MS_REFRESH_TOKEN', refreshToken);
  console.log(`  Written to data/env/env`);

  updateAgentGroupCredentials(refreshToken);

  // Also store in OneCLI vault as a secure backup reference.
  const result = spawnSync(
    'onecli',
    ['secrets', 'create', '--name', 'ms-onedrive-refresh-token', '--value', refreshToken, '--host', 'login.microsoftonline.com'],
    { stdio: 'pipe' },
  );
  if (result.status === 0) {
    console.log(`  Stored in OneCLI vault`);
  }
}

async function main(): Promise<void> {
  console.log('Requesting device code from Microsoft...');
  const dc = await requestDeviceCode();

  console.log();
  console.log(dc.message);
  console.log();
  console.log('Waiting for authorization...');

  const refreshToken = await pollForToken(dc.device_code, dc.interval);

  console.log();
  console.log('Authorization complete. Persisting refresh token...');
  persistRefreshToken(refreshToken);

  console.log();
  console.log('Done. MS_REFRESH_TOKEN is now available to the agent containers.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
