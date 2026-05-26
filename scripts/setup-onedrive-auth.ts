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

function storeInOneCli(refreshToken: string): void {
  const result = spawnSync(
    'onecli',
    [
      'secrets',
      'create',
      '--name',
      'ms-onedrive-refresh-token',
      '--value',
      refreshToken,
      '--host',
      'login.microsoftonline.com',
    ],
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`Failed to run onecli: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`onecli exited with status ${result.status}`);
    process.exit(1);
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
  console.log('Authorization complete. Storing refresh token in OneCLI vault...');
  storeInOneCli(refreshToken);

  console.log();
  console.log('Refresh token obtained. Stored in OneCLI vault.');
  console.log('You can also add it manually to .env:');
  console.log(`MS_REFRESH_TOKEN=${refreshToken}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
