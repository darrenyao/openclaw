/**
 * DingTalk OAuth access_token management via native fetch.
 * POST https://api.dingtalk.com/v1.0/oauth2/accessToken
 */

const DINGTALK_TOKEN_URL = "https://api.dingtalk.com/v1.0/oauth2/accessToken";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

type CachedToken = {
  accessToken: string;
  expiresAt: number;
};

const tokenCache = new Map<string, CachedToken>();
// Prevent concurrent token fetches for the same key
const pendingFetches = new Map<string, Promise<CachedToken>>();

function cacheKey(clientId: string): string {
  return clientId;
}

async function fetchAccessToken(clientId: string, clientSecret: string): Promise<CachedToken> {
  const res = await fetch(DINGTALK_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DingTalk OAuth failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as { accessToken?: string; expireIn?: number };
  if (!data.accessToken) {
    throw new Error("DingTalk OAuth: no accessToken in response");
  }

  return {
    accessToken: data.accessToken,
    expiresAt: Date.now() + (data.expireIn ?? 7200) * 1000,
  };
}

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const key = cacheKey(clientId);
  const cached = tokenCache.get(key);

  if (cached && cached.expiresAt - Date.now() > REFRESH_MARGIN_MS) {
    return cached.accessToken;
  }

  // Check if there's already a pending fetch for this key
  const pending = pendingFetches.get(key);
  if (pending) {
    const result = await pending;
    return result.accessToken;
  }

  const promise = fetchAccessToken(clientId, clientSecret);
  pendingFetches.set(key, promise);

  try {
    const token = await promise;
    tokenCache.set(key, token);
    return token.accessToken;
  } finally {
    pendingFetches.delete(key);
  }
}

export function clearTokenCache(clientId?: string): void {
  if (clientId) {
    tokenCache.delete(cacheKey(clientId));
  } else {
    tokenCache.clear();
  }
}
