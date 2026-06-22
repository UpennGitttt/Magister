import { writeSecretValue } from "../../services/local-secret-store-service";
import { parseFeishuConfigFromEnv } from "./feishu-config";
import { buildFeishuSetupState, type FeishuSetupState } from "./feishu-setup-state";

export type FeishuCredentialsInput = {
  appId?: string | undefined;
  appSecret?: string | undefined;
  verificationToken?: string | undefined;
  encryptKey?: string | undefined;
};

const CREDENTIAL_FIELDS: ReadonlyArray<[keyof FeishuCredentialsInput, string]> = [
  ["appId", "MAGISTER_FEISHU_APP_ID"],
  ["appSecret", "MAGISTER_FEISHU_APP_SECRET"],
  ["verificationToken", "MAGISTER_FEISHU_VERIFICATION_TOKEN"],
  ["encryptKey", "MAGISTER_FEISHU_ENCRYPT_KEY"],
];

/**
 * Persists the Feishu credentials supplied by the onboarding wizard into the
 * local secret store (under the same keys env uses, so `parseFeishuConfigFromEnv`
 * resolves them store→env). Blank/absent fields are skipped so a partial update
 * never clobbers an already-stored value. Returns the fresh, redacted state.
 */
export function applyFeishuCredentials(input: FeishuCredentialsInput): FeishuSetupState {
  for (const [field, secretRef] of CREDENTIAL_FIELDS) {
    const value = input[field]?.trim();
    if (value) {
      writeSecretValue(secretRef, value);
    }
  }

  return buildFeishuSetupState(parseFeishuConfigFromEnv());
}
