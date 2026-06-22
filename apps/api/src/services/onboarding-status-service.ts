import {
  areMagisterChannelsDisabled,
  parseFeishuConfigFromEnv,
} from "../integrations/feishu/feishu-config";
import {
  buildFeishuSetupState,
  type FeishuSetupState,
} from "../integrations/feishu/feishu-setup-state";
import {
  getFeishuWebSocketGatewayStatus,
  type FeishuWebSocketGatewayStatus,
} from "../integrations/feishu/feishu-websocket-gateway";
import type { ProviderAuthConfig } from "../providers/types";
import { getCliAgentStatus, type CliAgentStatus } from "./cli-agent-status-service";
import { readExecutorConfigFile } from "./executor-config-service";
import { getProviderAuthSecretRefs, getSecretStatus } from "./local-secret-store-service";

export type OnboardingProvidersSummary = {
  total: number;
  readyCount: number;
  configured: boolean;
};

export type OnboardingStatus = {
  /** Providers is the only hard requirement — the agent can't think without one. */
  providers: OnboardingProvidersSummary;
  cliAgents: {
    items: CliAgentStatus[];
    anyReady: boolean;
  };
  feishu: {
    state: FeishuSetupState;
    channelsDisabled: boolean;
    gateway: FeishuWebSocketGatewayStatus;
  };
  /** True once the minimum (a usable provider) is in place. */
  complete: boolean;
};

/** A provider is "usable" for onboarding if it needs no key, or all its secret refs resolve. */
function isProviderUsable(
  auth: ProviderAuthConfig | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!auth || auth.kind === "none") {
    return true;
  }
  // CLI / ChatGPT-session auth is covered by the CLI-agents step, not a stored key.
  if (auth.kind === "chatgpt_session") {
    return true;
  }
  const refs = getProviderAuthSecretRefs(auth);
  return refs.length > 0 && refs.every((ref) => getSecretStatus(ref, env).ready);
}

export function summarizeProviderReadiness(
  providers: Record<string, { auth?: ProviderAuthConfig | null }> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OnboardingProvidersSummary {
  const entries = Object.values(providers ?? {});
  let readyCount = 0;
  for (const provider of entries) {
    if (isProviderUsable(provider.auth ?? undefined, env)) {
      readyCount += 1;
    }
  }
  return { total: entries.length, readyCount, configured: readyCount > 0 };
}

/**
 * Aggregates the three onboarding areas (providers / CLI agents / Feishu) into a
 * single snapshot the Setup wizard renders. Providers is the only hard gate;
 * CLI agents and Feishu are optional.
 */
export async function getOnboardingStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<OnboardingStatus> {
  const config = await readExecutorConfigFile();
  const providers = summarizeProviderReadiness(config.providers, env);

  const cliItems = await getCliAgentStatus();
  const cliAgents = {
    items: cliItems,
    anyReady: cliItems.some((item) => item.installed && item.authenticated),
  };

  const feishu = {
    state: buildFeishuSetupState(parseFeishuConfigFromEnv()),
    channelsDisabled: areMagisterChannelsDisabled(env),
    gateway: getFeishuWebSocketGatewayStatus(),
  };

  return {
    providers,
    cliAgents,
    feishu,
    complete: providers.configured,
  };
}
