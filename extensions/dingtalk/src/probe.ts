import type { DingTalkProbeResult } from "./types.js";
import { getAccessToken } from "./auth.js";

/**
 * Probe DingTalk connection by attempting to obtain an access token.
 */
export async function probeDingTalk(params: {
  clientId?: string;
  clientSecret?: string;
}): Promise<DingTalkProbeResult> {
  const { clientId, clientSecret } = params;

  if (!clientId || !clientSecret) {
    return { ok: false, error: "missing credentials (clientId, clientSecret)" };
  }

  try {
    await getAccessToken(clientId, clientSecret);
    return { ok: true, clientId };
  } catch (err) {
    return {
      ok: false,
      clientId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
