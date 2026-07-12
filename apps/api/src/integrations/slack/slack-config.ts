import { resolveSecretValue } from "../../services/local-secret-store-service";

export type SlackConfig = {
  botToken: string | undefined;
  appToken: string | undefined;
  missingFields: Array<"MAGISTER_SLACK_BOT_TOKEN" | "MAGISTER_SLACK_APP_TOKEN">;
};

const SLACK_ENV_FIELDS = [
  ["MAGISTER_SLACK_BOT_TOKEN", "botToken"],
  ["MAGISTER_SLACK_APP_TOKEN", "appToken"],
] as const;

function readTrimmedValue(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function getRedactedValue(value: string) {
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}

/**
 * Reads Slack config from the local secret store first, falling back to
 * env — same posture as `parseFeishuConfigFromEnv`. Both tokens are
 * required: xoxb (bot, Web API calls) + xapp (app-level, Socket Mode).
 */
export function parseSlackConfig(): SlackConfig {
  const config: SlackConfig = {
    botToken: undefined,
    appToken: undefined,
    missingFields: [],
  };

  for (const [envKey, fieldName] of SLACK_ENV_FIELDS) {
    const value = readTrimmedValue(resolveSecretValue(envKey));
    if (value) {
      config[fieldName] = value;
    } else {
      config.missingFields.push(envKey);
    }
  }

  return config;
}

export function isSlackConfigReady(config: SlackConfig) {
  return config.missingFields.length === 0;
}

export function buildSlackSecretSnapshot(config: Pick<SlackConfig, "botToken" | "appToken">) {
  return {
    botToken: {
      present: typeof config.botToken === "string",
      redactedValue: config.botToken ? getRedactedValue(config.botToken) : "****",
    },
    appToken: {
      present: typeof config.appToken === "string",
      redactedValue: config.appToken ? getRedactedValue(config.appToken) : "****",
    },
  };
}
