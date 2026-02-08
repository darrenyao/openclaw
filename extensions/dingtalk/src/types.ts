import type { z } from "zod";
import type { DingTalkConfigSchema, DingTalkAccountConfigSchema } from "./config-schema.js";

export type DingTalkConfig = z.infer<typeof DingTalkConfigSchema>;
export type DingTalkAccountConfig = z.infer<typeof DingTalkAccountConfigSchema>;

export type ResolvedDingTalkAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  name?: string;
  clientId?: string;
  clientSecret?: string;
  config: DingTalkConfig;
};

export type DingTalkMessageContext = {
  conversationId: string;
  senderId: string;
  senderNick?: string;
  conversationType: "1" | "2"; // 1 = single chat, 2 = group
  content: string;
  conversationToken: string;
  messageId?: string;
};

export type DingTalkProbeResult = {
  ok: boolean;
  error?: string;
  clientId?: string;
};
