const CLIENT_ID = process.env.MS_CLIENT_ID ?? '';
const TENANT_ID = process.env.MS_TENANT_ID ?? '';
const REFRESH_TOKEN = process.env.MS_REFRESH_TOKEN ?? '';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function refreshAccessToken(): Promise<string> {
  const url = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: REFRESH_TOKEN,
    scope: 'Files.ReadWrite offline_access',
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
  return refreshAccessToken();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rawFetch(fullUrl: string, options: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(fullUrl, { ...options, headers });
}

export async function graphFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const fullUrl = path.startsWith('https://') ? path : `${GRAPH_BASE}${path}`;

  let res = await rawFetch(fullUrl, options);

  if (res.status === 401) {
    cachedToken = null;
    res = await rawFetch(fullUrl, options);
  }

  if (res.status === 409) {
    return res;
  }

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') ?? '1', 10);
    await sleep(retryAfter * 1000);
    res = await rawFetch(fullUrl, options);
  }

  if (res.status >= 500) {
    let delay = 1000;
    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(delay);
      res = await rawFetch(fullUrl, options);
      if (res.status < 500) break;
      delay *= 2;
    }
  }

  return res;
}
