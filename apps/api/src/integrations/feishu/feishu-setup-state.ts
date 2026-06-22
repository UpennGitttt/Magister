import type { FeishuConfig } from "./feishu-config";
import { buildFeishuSecretSnapshot, isFeishuConfigReady } from "./feishu-config";

export type FeishuSetupState = {
  provider: "feishu";
  mode: FeishuConfig["connectionMode"];
  ready: boolean;
  valid: boolean;
  missingFields: FeishuConfig["missingFields"];
  fields: ReturnType<typeof buildFeishuSecretSnapshot>;
};

export function buildFeishuSetupState(config: FeishuConfig): FeishuSetupState {
  const ready = isFeishuConfigReady(config);

  return {
    provider: "feishu",
    mode: config.connectionMode,
    ready,
    valid: ready,
    missingFields: [...config.missingFields],
    fields: buildFeishuSecretSnapshot(config),
  };
}
