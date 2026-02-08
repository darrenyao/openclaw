import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import type { ResolvedDingTalkAccount } from "./types.js";
import { resolveDingTalkAccount, listEnabledDingTalkAccounts } from "./accounts.js";
import { handleDingTalkMessage } from "./bot.js";

export type MonitorDingTalkOpts = {
  config?: OpenClawConfig;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string;
};

const DEFAULT_STREAM_TOPIC = "/v1.0/graph/api/invoke";

/**
 * Monitor a single DingTalk account via the stream SDK.
 */
async function monitorSingleAccount(params: {
  cfg: OpenClawConfig;
  account: ResolvedDingTalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const { accountId } = account;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const clientId = account.clientId;
  const clientSecret = account.clientSecret;
  if (!clientId || !clientSecret) {
    throw new Error(`DingTalk account "${accountId}" missing credentials`);
  }

  const streamTopic = account.config.streamTopic ?? DEFAULT_STREAM_TOPIC;
  log(`dingtalk[${accountId}]: starting stream (topic: ${streamTopic})...`);

  // Dynamic import to avoid loading the SDK at module level
  const { DWClient, TOPIC_ROBOT } = await import("dingtalk-stream-sdk-nodejs");

  const client = new DWClient({ clientId, clientSecret });

  // Use the configured stream topic (AI Assistant graph mode or standard robot topic)
  const topic = streamTopic === "robot" ? TOPIC_ROBOT : streamTopic;

  client.registerCallbackListener(topic, (res) => {
    try {
      const data = JSON.parse(res.data);
      // In graph API mode, body is nested; in robot mode, data is the message directly
      const body = typeof data.body === "string" ? JSON.parse(data.body) : (data.body ?? data);
      log(
        `dingtalk[${accountId}]: incoming message from ${body.sender_id ?? body.senderStaffId ?? "?"}`,
      );

      void handleDingTalkMessage({
        cfg,
        ctx: {
          conversationId: body.conversationId ?? body.conversation_id ?? "",
          senderId: body.senderStaffId ?? body.sender_id ?? body.uid ?? "",
          senderNick: body.senderNick ?? body.sender_nick ?? undefined,
          conversationType: body.conversationType ?? body.conversation_type ?? "1",
          content: body.text?.content ?? body.input ?? body.content ?? "",
          conversationToken: body.conversationToken ?? body.conversation_token ?? "",
          messageId: body.msgId ?? body.message_id ?? undefined,
        },
        runtime,
        accountId,
      });
    } catch (err) {
      error(`dingtalk[${accountId}]: error handling message: ${String(err)}`);
    }
  });

  return new Promise<void>((resolve) => {
    const handleAbort = () => {
      log(`dingtalk[${accountId}]: abort signal received, stopping`);
      client.disconnect();
      resolve();
    };

    if (abortSignal?.aborted) {
      resolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    void client.connect();
    log(`dingtalk[${accountId}]: stream client connected`);
  });
}

/**
 * Main entry: start monitoring for enabled DingTalk accounts.
 */
export async function monitorDingTalkProvider(opts: MonitorDingTalkOpts = {}): Promise<void> {
  const cfg = opts.config;
  if (!cfg) {
    throw new Error("Config is required for DingTalk monitor");
  }

  const log = opts.runtime?.log ?? console.log;

  if (opts.accountId) {
    const account = resolveDingTalkAccount({ cfg, accountId: opts.accountId });
    if (!account.enabled || !account.configured) {
      throw new Error(`DingTalk account "${opts.accountId}" not configured or disabled`);
    }
    return monitorSingleAccount({
      cfg,
      account,
      runtime: opts.runtime,
      abortSignal: opts.abortSignal,
    });
  }

  const accounts = listEnabledDingTalkAccounts(cfg);
  if (accounts.length === 0) {
    throw new Error("No enabled DingTalk accounts configured");
  }

  log(
    `dingtalk: starting ${accounts.length} account(s): ${accounts.map((a) => a.accountId).join(", ")}`,
  );

  await Promise.all(
    accounts.map((account) =>
      monitorSingleAccount({
        cfg,
        account,
        runtime: opts.runtime,
        abortSignal: opts.abortSignal,
      }),
    ),
  );
}
