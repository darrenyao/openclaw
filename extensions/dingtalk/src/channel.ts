import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedDingTalkAccount, DingTalkConfig } from "./types.js";
import {
  resolveDingTalkAccount,
  listDingTalkAccountIds,
  resolveDefaultDingTalkAccountId,
} from "./accounts.js";
import { dingtalkOnboardingAdapter } from "./onboarding.js";
import { probeDingTalk } from "./probe.js";
import { getDingTalkRuntime } from "./runtime.js";

const meta = {
  id: "dingtalk",
  label: "DingTalk",
  selectionLabel: "DingTalk (钉钉)",
  docsPath: "/channels/dingtalk",
  docsLabel: "dingtalk",
  blurb: "钉钉 AI Assistant with streaming card replies.",
  aliases: ["dingding"],
  order: 36,
} as const;

export const dingtalkPlugin: ChannelPlugin<ResolvedDingTalkAccount> = {
  id: "dingtalk",
  meta: {
    ...meta,
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    blockStreaming: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: {
      minChars: 100,
      idleMs: 500,
    },
  },
  reload: { configPrefixes: ["channels.dingtalk"] },
  config: {
    listAccountIds: (cfg) => listDingTalkAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDingTalkAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDingTalkAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: {
              ...cfg.channels?.dingtalk,
              enabled,
            },
          },
        };
      }

      const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dtCfg,
            accounts: {
              ...dtCfg?.accounts,
              [accountId]: {
                ...dtCfg?.accounts?.[accountId],
                enabled,
              },
            },
          },
        },
      };
    },
    deleteAccount: ({ cfg, accountId }) => {
      const isDefault = accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        const next = { ...cfg } as OpenClawConfig;
        const nextChannels = { ...cfg.channels };
        delete (nextChannels as Record<string, unknown>).dingtalk;
        if (Object.keys(nextChannels).length > 0) {
          next.channels = nextChannels;
        } else {
          delete next.channels;
        }
        return next;
      }

      const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
      const accounts = { ...dtCfg?.accounts };
      delete accounts[accountId];

      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dtCfg,
            accounts: Object.keys(accounts).length > 0 ? accounts : undefined,
          },
        },
      };
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      return account.config?.allowFrom ?? [];
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },
  security: {
    collectWarnings: ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      const dtCfg = account.config;
      const groupPolicy = dtCfg?.groupPolicy ?? "open";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- DingTalk[${account.accountId}] groups: groupPolicy="open" allows any member to trigger. Set channels.dingtalk.groupPolicy="allowlist" + channels.dingtalk.groupAllowFrom to restrict.`,
      ];
    },
  },
  setup: {
    resolveAccountId: () => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: ({ cfg, accountId }) => {
      const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;

      if (isDefault) {
        return {
          ...cfg,
          channels: {
            ...cfg.channels,
            dingtalk: {
              ...cfg.channels?.dingtalk,
              enabled: true,
            },
          },
        };
      }

      const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          dingtalk: {
            ...dtCfg,
            accounts: {
              ...dtCfg?.accounts,
              [accountId]: {
                ...dtCfg?.accounts?.[accountId],
                enabled: true,
              },
            },
          },
        },
      };
    },
  },
  onboarding: dingtalkOnboardingAdapter,
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sendText: async ({ to }) => {
      // DingTalk AI Assistant mode requires conversationToken for replies.
      // Outbound (proactive) sends without a token are not supported.
      try {
        const core = getDingTalkRuntime();
        const logger = core.logging.getChildLogger({ channel: "dingtalk" });
        logger.warn(
          `dingtalk: outbound send to ${to} skipped (AI Assistant mode requires conversationToken)`,
        );
        return { channel: "dingtalk" };
      } catch {
        return { channel: "dingtalk" };
      }
    },
    sendMedia: null,
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    probeAccount: async ({ cfg, accountId }) => {
      const account = resolveDingTalkAccount({ cfg, accountId });
      return await probeDingTalk({
        clientId: account.clientId,
        clientSecret: account.clientSecret,
      });
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      name: account.name,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const { monitorDingTalkProvider } = await import("./monitor.js");
      ctx.log?.info(`starting dingtalk[${ctx.accountId}]`);
      return monitorDingTalkProvider({
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
  },
};
