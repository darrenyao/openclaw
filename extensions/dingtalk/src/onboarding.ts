import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import { addWildcardAllowFrom, DEFAULT_ACCOUNT_ID, formatDocsLink } from "openclaw/plugin-sdk";
import type { DingTalkConfig } from "./types.js";
import { resolveDingTalkCredentials } from "./accounts.js";
import { probeDingTalk } from "./probe.js";

const channel = "dingtalk" as const;

function setDingTalkDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.dingtalk?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setDingTalkAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        allowFrom,
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptDingTalkAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const existing = params.cfg.channels?.dingtalk?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist DingTalk DMs by user staffId or unionId.",
      "You can find user IDs in the DingTalk admin console.",
      "Examples:",
      "- manager123",
      "- 6789012345",
    ].join("\n"),
    "DingTalk allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "DingTalk allowFrom (user IDs)",
      placeholder: "staffId1, staffId2",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "DingTalk allowlist");
      continue;
    }

    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...parts]),
    ];
    return setDingTalkAllowFrom(params.cfg, unique);
  }
}

async function noteCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to DingTalk Open Platform (open-dev.dingtalk.com)",
      "2) Create an enterprise internal app (AI Assistant mode)",
      "3) Get Client ID (AppKey) and Client Secret (AppSecret)",
      "4) Enable the Stream mode and AI Assistant capabilities",
      "5) Publish the app within your organization",
      `Docs: ${formatDocsLink("/channels/dingtalk", "dingtalk")}`,
    ].join("\n"),
    "DingTalk credentials",
  );
}

function setDingTalkGroupPolicy(
  cfg: OpenClawConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "DingTalk",
  channel,
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.dingtalk as DingTalkConfig | undefined)?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setDingTalkDmPolicy(cfg, policy),
  promptAllowFrom: promptDingTalkAllowFrom,
};

export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
    const configured = Boolean(resolveDingTalkCredentials(dtCfg));

    let probeResult = null;
    if (configured && dtCfg) {
      try {
        probeResult = await probeDingTalk({
          clientId: dtCfg.clientId,
          clientSecret: dtCfg.clientSecret,
        });
      } catch {
        // Ignore probe errors
      }
    }

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("DingTalk: needs app credentials");
    } else if (probeResult?.ok) {
      statusLines.push("DingTalk: connected");
    } else {
      statusLines.push("DingTalk: configured (connection not verified)");
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }) => {
    const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
    const resolved = resolveDingTalkCredentials(dtCfg);
    const hasConfigCreds = Boolean(dtCfg?.clientId?.trim() && dtCfg?.clientSecret?.trim());

    let next = cfg;
    let clientId: string | null = null;
    let clientSecret: string | null = null;

    if (!resolved) {
      await noteCredentialHelp(prompter);
    }

    if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "DingTalk credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        clientId = String(
          await prompter.text({
            message: "Enter DingTalk Client ID (AppKey)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        clientSecret = String(
          await prompter.text({
            message: "Enter DingTalk Client Secret (AppSecret)",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      clientId = String(
        await prompter.text({
          message: "Enter DingTalk Client ID (AppKey)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      clientSecret = String(
        await prompter.text({
          message: "Enter DingTalk Client Secret (AppSecret)",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (clientId && clientSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          dingtalk: {
            ...next.channels?.dingtalk,
            enabled: true,
            clientId,
            clientSecret,
          },
        },
      };

      // Test connection
      try {
        const probe = await probeDingTalk({ clientId, clientSecret });
        if (probe.ok) {
          await prompter.note("Connected successfully!", "DingTalk connection test");
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            "DingTalk connection test",
          );
        }
      } catch (err) {
        await prompter.note(`Connection test failed: ${String(err)}`, "DingTalk connection test");
      }
    }

    // Group policy
    const groupPolicy = await prompter.select({
      message: "Group chat policy",
      options: [
        { value: "open", label: "Open - respond in all groups" },
        { value: "allowlist", label: "Allowlist - only respond in specific groups" },
        { value: "disabled", label: "Disabled - don't respond in groups" },
      ],
      initialValue: (next.channels?.dingtalk as DingTalkConfig | undefined)?.groupPolicy ?? "open",
    });
    if (groupPolicy) {
      next = setDingTalkGroupPolicy(next, groupPolicy as "open" | "allowlist" | "disabled");
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: { ...cfg.channels?.dingtalk, enabled: false },
    },
  }),
};
