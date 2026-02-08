import { z } from "zod";

export const DingTalkAccountConfigSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

export const DingTalkConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  streamTopic: z.string().optional(),
  cardTemplateId: z.string().optional(),
  dmPolicy: z.enum(["open", "pairing", "allowlist"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  groupAllowFrom: z.array(z.string()).optional(),
  requireMention: z.boolean().optional(),
  textChunkLimit: z.number().min(1).optional(),
  accounts: z.record(z.string(), DingTalkAccountConfigSchema).optional(),
});
