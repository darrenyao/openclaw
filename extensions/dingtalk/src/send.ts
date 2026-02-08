/**
 * Outbound: reply to DingTalk via AI Interaction API using native fetch.
 *
 * Passive reply: POST /v1.0/aiInteraction/reply
 * AI Card streaming: prepare → update* → finish
 */

import { getAccessToken } from "./auth.js";

const AI_BASE = "https://api.dingtalk.com/v1.0/aiInteraction";

type ContentType = "text" | "markdown" | "ai_card";

async function dingtalkPost(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${AI_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-acs-dingtalk-access-token": accessToken,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DingTalk AI API ${path} failed (${res.status}): ${text}`);
  }

  // Some endpoints return empty body on success
  const text = await res.text();
  if (!text) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

// --- Passive reply (uses conversationToken from inbound message) ---

export async function replyText(params: {
  clientId: string;
  clientSecret: string;
  conversationToken: string;
  content: string;
  contentType?: ContentType;
}): Promise<boolean> {
  const { clientId, clientSecret, conversationToken, content, contentType = "markdown" } = params;
  const accessToken = await getAccessToken(clientId, clientSecret);

  try {
    await dingtalkPost("/reply", accessToken, {
      conversationToken,
      contentType,
      content,
    });
    return true;
  } catch {
    return false;
  }
}

// --- AI Card streaming ---

export type CardData = {
  templateId: string;
  cardData: Record<string, unknown>;
  options?: Record<string, unknown>;
};

function serializeCardContent(card: CardData): string {
  const payload: Record<string, unknown> = {
    templateId: card.templateId,
    cardData: card.cardData,
  };
  if (card.options) {
    payload.options = card.options;
  }
  return JSON.stringify(payload);
}

/**
 * Prepare a proactive AI Card (returns a conversationToken for subsequent updates).
 */
export async function prepareCard(params: {
  clientId: string;
  clientSecret: string;
  card: CardData;
  unionId?: string;
  openConversationId?: string;
}): Promise<string | null> {
  const { clientId, clientSecret, card, unionId, openConversationId } = params;
  const accessToken = await getAccessToken(clientId, clientSecret);

  try {
    const res = await dingtalkPost("/prepare", accessToken, {
      contentType: "ai_card",
      content: serializeCardContent(card),
      ...(unionId ? { unionId } : {}),
      ...(openConversationId ? { openConversationId } : {}),
    });
    const result = res.result as { conversationToken?: string } | undefined;
    return result?.conversationToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Reply with an AI Card in an existing conversation.
 */
export async function replyCard(params: {
  clientId: string;
  clientSecret: string;
  conversationToken: string;
  card: CardData;
}): Promise<boolean> {
  return replyText({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    conversationToken: params.conversationToken,
    content: serializeCardContent(params.card),
    contentType: "ai_card",
  });
}

/**
 * Push an incremental card update.
 */
export async function updateCard(params: {
  clientId: string;
  clientSecret: string;
  conversationToken: string;
  card: CardData;
}): Promise<boolean> {
  const { clientId, clientSecret, conversationToken, card } = params;
  const accessToken = await getAccessToken(clientId, clientSecret);

  try {
    await dingtalkPost("/update", accessToken, {
      conversationToken,
      contentType: "ai_card",
      content: serializeCardContent(card),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Finalize a streaming card session.
 */
export async function finishCard(params: {
  clientId: string;
  clientSecret: string;
  conversationToken: string;
}): Promise<boolean> {
  const { clientId, clientSecret, conversationToken } = params;
  const accessToken = await getAccessToken(clientId, clientSecret);

  try {
    await dingtalkPost("/finish", accessToken, { conversationToken });
    return true;
  } catch {
    return false;
  }
}

/**
 * Streaming session helper for AI Card output.
 * Tracks accumulated content and auto-finalizes on finish().
 */
export class DingTalkStreamingSession {
  private _finished = false;

  constructor(
    public readonly conversationToken: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly templateId: string,
  ) {}

  async update(content: string, isFinalize = false): Promise<boolean> {
    return updateCard({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      conversationToken: this.conversationToken,
      card: {
        templateId: this.templateId,
        cardData: { key: "result", value: content, isFinalize },
        options: { componentTag: "streamingComponent" },
      },
    });
  }

  async finish(): Promise<boolean> {
    if (this._finished) {
      return true;
    }
    this._finished = true;
    return finishCard({
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      conversationToken: this.conversationToken,
    });
  }

  get finished(): boolean {
    return this._finished;
  }
}
