import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  getSecretStatus,
  listSecretStatuses,
  readLocalSecretStoreFile,
  resolveSecretValue,
  writeSecretValue,
} from "../../src/services/local-secret-store-service";

const tempRoot = join(process.cwd(), ".tmp-local-secret-store");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_SECRET_STORE_PATH = join(
    tempRoot,
    `secrets-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_SECRET_STORE_PATH;
  delete process.env.MOONSHOT_API_KEY;
  delete process.env.OPENAI_API_KEY;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("local secret store writes values and exposes readiness without leaking secrets", () => {
  writeSecretValue("MOONSHOT_API_KEY", "local-secret");

  expect(readLocalSecretStoreFile()).toMatchObject({
    secrets: {
      MOONSHOT_API_KEY: {
        value: "local-secret",
      },
    },
  });
  expect(resolveSecretValue("MOONSHOT_API_KEY")).toBe("local-secret");

  const status = getSecretStatus("MOONSHOT_API_KEY");
  expect(status).toMatchObject({
    secretRef: "MOONSHOT_API_KEY",
    ready: true,
    source: "store",
  });
  expect(status.updatedAt).toEqual(expect.any(String));
  expect(JSON.stringify(status)).not.toContain("local-secret");
});

test("local secret store falls back to env when no local secret exists", () => {
  process.env.OPENAI_API_KEY = "env-secret";

  expect(resolveSecretValue("OPENAI_API_KEY")).toBe("env-secret");
  expect(getSecretStatus("OPENAI_API_KEY")).toMatchObject({
    secretRef: "OPENAI_API_KEY",
    ready: true,
    source: "env",
  });
});

test("listSecretStatuses redacts values and includes updatedAt only for local secrets", () => {
  writeSecretValue("MOONSHOT_API_KEY", "local-secret");
  process.env.OPENAI_API_KEY = "env-secret";

  const statuses = listSecretStatuses(["MOONSHOT_API_KEY", "OPENAI_API_KEY", "MISSING_KEY"]);

  expect(statuses).toMatchObject([
    {
      secretRef: "MOONSHOT_API_KEY",
      ready: true,
      source: "store",
    },
    {
      secretRef: "OPENAI_API_KEY",
      ready: true,
      source: "env",
    },
    {
      secretRef: "MISSING_KEY",
      ready: false,
      source: "missing",
    },
  ]);
  expect(statuses[0]?.updatedAt).toEqual(expect.any(String));
  expect(statuses[1]?.updatedAt).toBeUndefined();
  expect(statuses[2]?.updatedAt).toBeUndefined();
  expect(JSON.stringify(statuses)).not.toContain("local-secret");
  expect(JSON.stringify(statuses)).not.toContain("env-secret");
});
