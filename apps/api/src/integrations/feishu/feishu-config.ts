import { resolveSecretValue } from "../../services/local-secret-store-service";

export type FeishuConnectionMode = "websocket" | "webhook";

export type FeishuConfig = {
  connectionMode: FeishuConnectionMode;
  appId: string | undefined;
  appSecret: string | undefined;
  verificationToken: string | undefined;
  encryptKey: string | undefined;
  missingFields: Array<
    | "MAGISTER_FEISHU_APP_ID"
    | "MAGISTER_FEISHU_APP_SECRET"
    | "MAGISTER_FEISHU_VERIFICATION_TOKEN"
    | "MAGISTER_FEISHU_ENCRYPT_KEY"
  >;
};

export type FeishuSecretSnapshot = {
  present: boolean;
  redactedValue: string;
};

const FEISHU_ENV_FIELDS = [
  ["MAGISTER_FEISHU_APP_ID", "appId"],
  ["MAGISTER_FEISHU_APP_SECRET", "appSecret"],
  ["MAGISTER_FEISHU_VERIFICATION_TOKEN", "verificationToken"],
  ["MAGISTER_FEISHU_ENCRYPT_KEY", "encryptKey"],
] as const;

export function areMagisterChannelsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MAGISTER_DISABLE_CHANNELS?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function readFeishuConnectionMode(value: string | undefined): FeishuConnectionMode {
  return value?.trim() === "webhook" ? "webhook" : "websocket";
}

function readTrimmedEnvValue(value: string | undefined) {
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
 * Reads Feishu config from the local secret store first, falling back to env.
 * `resolveSecretValue(key)` checks `config/secrets.json` then `process.env[key]`,
 * so creds written by the onboarding wizard win, while plain env still works.
 * Name kept (`...FromEnv`) to avoid churning its 12 callers; env is the fallback.
 */
export function parseFeishuConfigFromEnv(): FeishuConfig {
  const config: FeishuConfig = {
    connectionMode: readFeishuConnectionMode(process.env.MAGISTER_FEISHU_CONNECTION_MODE),
    appId: undefined,
    appSecret: undefined,
    verificationToken: undefined,
    encryptKey: undefined,
    missingFields: [],
  };

  for (const [envKey, fieldName] of FEISHU_ENV_FIELDS) {
    const value = readTrimmedEnvValue(resolveSecretValue(envKey));
    if (value) {
      config[fieldName] = value;
    } else if (
      envKey === "MAGISTER_FEISHU_APP_ID" ||
      envKey === "MAGISTER_FEISHU_APP_SECRET" ||
      config.connectionMode === "webhook"
    ) {
      config.missingFields.push(envKey);
    }
  }

  return config;
}

export function isFeishuConfigReady(config: FeishuConfig) {
  return config.missingFields.length === 0;
}

export function buildFeishuSecretSnapshot(
  config: Pick<FeishuConfig, "appId" | "appSecret" | "verificationToken" | "encryptKey">,
) {
  return {
    appId: {
      present: typeof config.appId === "string",
      redactedValue: config.appId ? getRedactedValue(config.appId) : "****",
    },
    appSecret: {
      present: typeof config.appSecret === "string",
      redactedValue: config.appSecret ? getRedactedValue(config.appSecret) : "****",
    },
    verificationToken: {
      present: typeof config.verificationToken === "string",
      redactedValue: config.verificationToken ? getRedactedValue(config.verificationToken) : "****",
    },
    encryptKey: {
      present: typeof config.encryptKey === "string",
      redactedValue: config.encryptKey ? getRedactedValue(config.encryptKey) : "****",
    },
  };
}
