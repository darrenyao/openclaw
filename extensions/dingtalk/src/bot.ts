import type { OpenClawConfig, ReplyPayload, RuntimeEnv } from "openclaw/plugin-sdk";
import { createReplyPrefixContext } from "openclaw/plugin-sdk";
import type { DingTalkMessageContext, ResolvedDingTalkAccount } from "./types.js";
import { resolveDingTalkAccount } from "./accounts.js";
import { getDingTalkRuntime } from "./runtime.js";
import { replyCard, finishCard, updateCard } from "./send.js";

const DEFAULT_CARD_TEMPLATE_ID = "4b6e421f-5300-4ba4-bb0b-0fcea69051f0.schema";

/**
 * Handle an incoming DingTalk message and dispatch to the OpenClaw agent.
 */
export async function handleDingTalkMessage(params: {
  cfg: OpenClawConfig;
  ctx: DingTalkMessageContext;
  runtime?: RuntimeEnv;
  accountId?: string;
}): Promise<void> {
  const { cfg, ctx, runtime, accountId } = params;

  const account = resolveDingTalkAccount({ cfg, accountId });
  const dtCfg = account.config;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const isGroup = ctx.conversationType === "2";

  log(
    `dingtalk[${account.accountId}]: received message from ${ctx.senderId} (${isGroup ? "group" : "DM"})`,
  );

  // --- DM policy check ---
  if (!isGroup) {
    const dmPolicy = dtCfg?.dmPolicy ?? "open";
    const allowFrom = dtCfg?.allowFrom ?? [];

    if (dmPolicy === "allowlist") {
      const allowed = allowFrom.includes("*") || allowFrom.some((entry) => entry === ctx.senderId);
      if (!allowed) {
        log(`dingtalk[${account.accountId}]: sender ${ctx.senderId} not in DM allowlist`);
        return;
      }
    }
  }

  // --- Group policy check ---
  if (isGroup) {
    const groupPolicy = dtCfg?.groupPolicy ?? "open";
    const groupAllowFrom = dtCfg?.groupAllowFrom ?? [];

    if (groupPolicy === "disabled") {
      log(`dingtalk[${account.accountId}]: group messages disabled`);
      return;
    }

    if (groupPolicy === "allowlist") {
      const allowed =
        groupAllowFrom.includes("*") ||
        groupAllowFrom.some((entry) => entry === ctx.conversationId);
      if (!allowed) {
        log(`dingtalk[${account.accountId}]: group ${ctx.conversationId} not in group allowlist`);
        return;
      }
    }
  }

  try {
    const core = getDingTalkRuntime();

    const dingtalkFrom = `dingtalk:${ctx.senderId}`;
    const dingtalkTo = isGroup
      ? `dingtalk:group:${ctx.conversationId}`
      : `dingtalk:${ctx.senderId}`;

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "dingtalk",
      accountId: account.accountId,
      peer: {
        kind: isGroup ? "group" : "dm",
        id: isGroup ? ctx.conversationId : ctx.senderId,
      },
    });

    const preview = ctx.content.replace(/\s+/g, " ").slice(0, 160);
    const inboundLabel = isGroup
      ? `DingTalk[${account.accountId}] message in group ${ctx.conversationId}`
      : `DingTalk[${account.accountId}] DM from ${ctx.senderId}`;

    core.system.enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
      sessionKey: route.sessionKey,
      contextKey: `dingtalk:message:${ctx.conversationId}:${ctx.senderId}`,
    });

    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const speaker = ctx.senderNick ?? ctx.senderId;
    const messageBody = `${speaker}: ${ctx.content}`;

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "DingTalk",
      from: ctx.senderId,
      timestamp: new Date(),
      envelope: envelopeOptions,
      body: messageBody,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: ctx.content,
      CommandBody: ctx.content,
      From: dingtalkFrom,
      To: dingtalkTo,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      GroupSubject: isGroup ? ctx.conversationId : undefined,
      SenderName: ctx.senderNick ?? ctx.senderId,
      SenderId: ctx.senderId,
      Provider: "dingtalk" as const,
      Surface: "dingtalk" as const,
      MessageSid: ctx.messageId ?? `${ctx.conversationId}:${Date.now()}`,
      Timestamp: Date.now(),
      WasMentioned: false,
      CommandAuthorized: true,
      OriginatingChannel: "dingtalk" as const,
      OriginatingTo: dingtalkTo,
    });

    // Build a proper ReplyDispatcher via createReplyDispatcherWithTyping
    const { dispatcher, replyOptions, finalizeCard } = createDingTalkReplyDispatcher({
      cfg,
      account,
      conversationToken: ctx.conversationToken,
      agentId: route.agentId ?? "main",
      runtime,
    });

    log(`dingtalk[${account.accountId}]: dispatching to agent (session=${route.sessionKey})`);

    const { queuedFinal, counts } = await core.channel.reply.dispatchReplyFromConfig({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions,
    });

    // Finalize the AI Card streaming session after all replies are dispatched
    await finalizeCard();

    log(
      `dingtalk[${account.accountId}]: dispatch complete (queuedFinal=${queuedFinal}, replies=${counts.final})`,
    );
  } catch (err) {
    error(`dingtalk[${account.accountId}]: failed to dispatch message: ${String(err)}`);
  }
}

/**
 * Create a ReplyDispatcher that sends replies back via DingTalk AI Interaction API.
 * Follows the same pattern as Feishu's reply dispatcher.
 */
function createDingTalkReplyDispatcher(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  conversationToken: string;
  agentId: string;
  runtime?: RuntimeEnv;
}) {
  const { cfg, account, conversationToken, agentId, runtime } = params;
  const core = getDingTalkRuntime();
  const clientId = account.clientId ?? "";
  const clientSecret = account.clientSecret ?? "";
  const templateId = account.config.cardTemplateId ?? DEFAULT_CARD_TEMPLATE_ID;

  const prefixContext = createReplyPrefixContext({ cfg, agentId });

  // Streaming AI Card state: accumulate text across multiple deliver() calls,
  // then finalize after dispatch completes.
  let cardInitialized = false;
  let accumulatedText = "";

  const { dispatcher, replyOptions } = core.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: prefixContext.responsePrefix,
    responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
    humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, agentId),
    deliver: async (payload: ReplyPayload) => {
      const text = payload.text ?? "";
      if (!text.trim()) return;

      accumulatedText += text;

      // DingTalk AI Assistant mode: reply (init card) → update* (stream) → finish
      if (!cardInitialized) {
        const ok = await replyCard({
          clientId,
          clientSecret,
          conversationToken,
          card: {
            templateId,
            cardData: { config: { autoLayout: true } },
            options: { componentTag: "staticComponent" },
          },
        });
        if (!ok) {
          runtime?.error?.(`dingtalk[${account.accountId}]: replyCard (init) failed`);
          return;
        }
        cardInitialized = true;
      }

      // Push streaming update (not finalized yet)
      await updateCard({
        clientId,
        clientSecret,
        conversationToken,
        card: {
          templateId,
          cardData: { key: "result", value: accumulatedText, isFinalize: false },
          options: { componentTag: "streamingComponent" },
        },
      });
    },
    onError: (err, info) => {
      runtime?.error?.(`dingtalk[${account.accountId}]: ${info.kind} reply failed: ${String(err)}`);
    },
  });

  // Called after dispatchReplyFromConfig completes to finalize the AI Card
  const finalizeCard = async () => {
    if (!cardInitialized) return;
    // Send final update with isFinalize: true
    await updateCard({
      clientId,
      clientSecret,
      conversationToken,
      card: {
        templateId,
        cardData: { key: "result", value: accumulatedText, isFinalize: true },
        options: { componentTag: "streamingComponent" },
      },
    });
    await finishCard({ clientId, clientSecret, conversationToken });
    runtime?.log?.(
      `dingtalk[${account.accountId}]: AI Card finalized (len=${accumulatedText.length})`,
    );
  };

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,
    },
    finalizeCard,
  };
}
