import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk";
import type { DingTalkConfig, DingTalkAccountConfig, ResolvedDingTalkAccount } from "./types.js";

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = (cfg.channels?.dingtalk as DingTalkConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return [];
  }
  return Object.keys(accounts).filter(Boolean);
}

export function listDingTalkAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listConfiguredAccountIds(cfg);
  if (ids.length === 0) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultDingTalkAccountId(cfg: OpenClawConfig): string {
  const ids = listDingTalkAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): DingTalkAccountConfig | undefined {
  const accounts = (cfg.channels?.dingtalk as DingTalkConfig)?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  return accounts[accountId];
}

function mergeDingTalkAccountConfig(cfg: OpenClawConfig, accountId: string): DingTalkConfig {
  const dtCfg = cfg.channels?.dingtalk as DingTalkConfig | undefined;
  const { accounts: _ignored, ...base } = dtCfg ?? {};
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as DingTalkConfig;
}

export function resolveDingTalkCredentials(cfg?: DingTalkConfig): {
  clientId: string;
  clientSecret: string;
} | null {
  const clientId = cfg?.clientId?.trim();
  const clientSecret = cfg?.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }
  return { clientId, clientSecret };
}

export function resolveDingTalkAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDingTalkAccount {
  const accountId = normalizeAccountId(params.accountId);
  const dtCfg = params.cfg.channels?.dingtalk as DingTalkConfig | undefined;

  const baseEnabled = dtCfg?.enabled !== false;
  const merged = mergeDingTalkAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const creds = resolveDingTalkCredentials(merged);

  return {
    accountId,
    enabled,
    configured: Boolean(creds),
    name: (merged as DingTalkAccountConfig).name?.trim() || undefined,
    clientId: creds?.clientId,
    clientSecret: creds?.clientSecret,
    config: merged,
  };
}

export function listEnabledDingTalkAccounts(cfg: OpenClawConfig): ResolvedDingTalkAccount[] {
  return listDingTalkAccountIds(cfg)
    .map((accountId) => resolveDingTalkAccount({ cfg, accountId }))
    .filter((account) => account.enabled && account.configured);
}
