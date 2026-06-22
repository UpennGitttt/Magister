import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureDatabaseInitialized } from "@magister/db";
import { resetFeishuTokenCache } from "../../src/integrations/feishu/feishu-client";

const FEISHU_ENV_KEYS = [
  "MAGISTER_DB_PATH",
  "MAGISTER_FEISHU_APP_ID",
  "MAGISTER_FEISHU_APP_SECRET",
  "MAGISTER_FEISHU_VERIFICATION_TOKEN",
  "MAGISTER_FEISHU_ENCRYPT_KEY",
  "MAGISTER_DEFAULT_WORKSPACE_ID",
  "MAGISTER_EXECUTOR_CONFIG_PATH",
  "MAGISTER_FEISHU_OUTBOUND_STYLE",
  "MAGISTER_WEB_PUBLIC_BASE_URL",
] as const;

type FeishuEnvKey = (typeof FEISHU_ENV_KEYS)[number];

export type FeishuFetchRequestRecord = {
  url: string;
  init?: RequestInit | undefined;
};

export type FeishuFetchHandler = (
  url: string | URL | Request,
  init?: RequestInit | undefined,
) => Response | Promise<Response>;

export type FeishuFetchMockOptions = {
  reactionId?: string;
  replyMessageId?: string;
  topLevelMessageId?: string;
  defaultMessageId?: string;
  customHandler?: (
    url: string,
    init?: RequestInit | undefined,
    requests?: FeishuFetchRequestRecord[],
  ) => Response | Promise<Response> | null | undefined;
};

export type ChannelSessionSeed = {
  id?: string;
  bindingId: string;
  channel?: string;
  workspaceId?: string;
  continuityMode?: "reaction_only" | "reply_preferred" | "top_level_preferred" | "always_visible_ack";
  verboseLevel?: "off" | "on" | "full";
  currentTaskId?: string | null;
  latestInboundMessageId?: string | null;
  latestDeliveredMessageId?: string | null;
  latestAnswerSummary?: string | null;
  now?: Date;
};

export type FeishuTestHarnessOptions = {
  name: string;
  includeExecutorConfig?: boolean;
  defaultWorkspaceId?: string;
  outboundStyle?: string;
  webPublicBaseUrl?: string;
};

export type FeishuTestHarness = {
  tempRoot: string;
  dbPath: string;
  executorConfigPath: string | undefined;
  installFetchStub: (handler: FeishuFetchHandler) => void;
  createSqlite: (options?: { initialize?: boolean }) => Database;
  seedChannelSession: (seed: ChannelSessionSeed) => void;
  writeStubExecutorConfig: (config?: unknown) => string;
  cleanup: () => void;
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

function buildStubRoutingConfig() {
  return {
    executors: {
      codex: {
        configuredModel: "gpt-5.3-codex",
        commandPath: "__stub__",
      },
      qoder: {
        configuredModel: "qoder-review",
        commandPath: "qoder",
      },
    },
    roleRouting: {
      manager: "codex",
      architect: "codex",
      coder: "codex",
      reviewer: "qoder",
      lander: "codex",
    },
    providers: {},
    models: {},
    bindings: {},
  };
}

function restoreEnv(originalEnv: Record<FeishuEnvKey, string | undefined>) {
  for (const key of FEISHU_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

export function createFeishuFetchMock(
  options: FeishuFetchMockOptions = {},
): {
  requests: FeishuFetchRequestRecord[];
  fetch: FeishuFetchHandler;
} {
  const requests: FeishuFetchRequestRecord[] = [];

  const fetchImpl: FeishuFetchHandler = async (url, init) => {
    const request = {
      url: String(url),
      init,
    };
    if (request.url.startsWith("https://open.feishu.cn/")) {
      requests.push(request);
    }

    const customResponse = await options.customHandler?.(request.url, init, requests);
    if (customResponse) {
      return customResponse;
    }

    if (request.url.includes("/tenant_access_token/internal")) {
      return jsonResponse({
        code: 0,
        tenant_access_token: "tenant_access_token_value",
        expire: 7200,
      });
    }

    if (request.url.includes("/reactions")) {
      return jsonResponse({
        code: 0,
        data: {
          reaction_id: options.reactionId ?? "reaction_ok_123",
        },
      });
    }

    if (request.url.includes("/messages?receive_id_type=chat_id")) {
      return jsonResponse({
        code: 0,
        data: {
          message_id: options.topLevelMessageId ?? options.defaultMessageId ?? "om_top_level_message",
        },
      });
    }

    if (request.url.includes("/reply")) {
      return jsonResponse({
        code: 0,
        data: {
          message_id: options.replyMessageId ?? options.defaultMessageId ?? "om_reply_message",
        },
      });
    }

    if (request.url.includes("/messages")) {
      return jsonResponse({
        code: 0,
        data: {
          message_id: options.defaultMessageId ?? "om_text_message",
        },
      });
    }

    throw new Error(`Unexpected Feishu request: ${request.url}`);
  };

  return {
    requests,
    fetch: fetchImpl,
  };
}

export function createFeishuTestHarness(
  options: FeishuTestHarnessOptions,
): FeishuTestHarness {
  const originalEnv = Object.fromEntries(
    FEISHU_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<FeishuEnvKey, string | undefined>;
  const originalFetch = globalThis.fetch;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempRoot = join(process.cwd(), `.tmp-${options.name}`);
  const dbPath = join(tempRoot, `${options.name}-${suffix}.sqlite`);
  const executorConfigPath = options.includeExecutorConfig
    ? join(tempRoot, `executors-${suffix}.json`)
    : undefined;
  let cleanedUp = false;

  // Reset token cache so each test starts fresh
  resetFeishuTokenCache();
  mkdirSync(tempRoot, { recursive: true });

  process.env.MAGISTER_DB_PATH = dbPath;
  process.env.MAGISTER_FEISHU_APP_ID = "cli-agent-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "cli-agent-app-secret";
  process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN = "cli-agent-verification-token";
  process.env.MAGISTER_FEISHU_ENCRYPT_KEY = "cli-agent-encrypt-key";

  if (options.defaultWorkspaceId) {
    process.env.MAGISTER_DEFAULT_WORKSPACE_ID = options.defaultWorkspaceId;
  } else {
    delete process.env.MAGISTER_DEFAULT_WORKSPACE_ID;
  }

  if (executorConfigPath) {
    process.env.MAGISTER_EXECUTOR_CONFIG_PATH = executorConfigPath;
  } else {
    delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  }

  if (options.outboundStyle) {
    process.env.MAGISTER_FEISHU_OUTBOUND_STYLE = options.outboundStyle;
  } else {
    delete process.env.MAGISTER_FEISHU_OUTBOUND_STYLE;
  }

  if (options.webPublicBaseUrl) {
    process.env.MAGISTER_WEB_PUBLIC_BASE_URL = options.webPublicBaseUrl;
  } else {
    delete process.env.MAGISTER_WEB_PUBLIC_BASE_URL;
  }

  const createSqlite = ({ initialize = false }: { initialize?: boolean } = {}) => {
    const sqlite = new Database(dbPath);
    if (initialize) {
      // bun:sqlite's Database structurally satisfies the RawSqlite surface;
      // cast through the parameter type to bridge the nominal mismatch.
      ensureDatabaseInitialized(sqlite as unknown as Parameters<typeof ensureDatabaseInitialized>[0], dbPath);
    }
    return sqlite;
  };

  return {
    tempRoot,
    dbPath,
    executorConfigPath,
    installFetchStub(handler) {
      globalThis.fetch = handler as typeof fetch;
    },
    createSqlite,
    seedChannelSession(seed) {
      const now = seed.now ?? new Date();
      const sqlite = createSqlite({ initialize: true });
      sqlite
        .prepare(
          `
            insert into channel_sessions (
              id,
              binding_id,
              channel,
              workspace_id,
              continuity_mode,
              verbose_level,
              current_task_id,
              latest_inbound_message_id,
              latest_delivered_message_id,
              latest_answer_summary,
              created_at,
              updated_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          seed.id ?? seed.bindingId,
          seed.bindingId,
          seed.channel ?? "feishu",
          seed.workspaceId ?? process.env.MAGISTER_DEFAULT_WORKSPACE_ID ?? "workspace_main",
          seed.continuityMode ?? "reply_preferred",
          seed.verboseLevel ?? "off",
          seed.currentTaskId ?? null,
          seed.latestInboundMessageId ?? null,
          seed.latestDeliveredMessageId ?? null,
          seed.latestAnswerSummary ?? null,
          now.getTime(),
          now.getTime(),
        );
      sqlite.close();
    },
    writeStubExecutorConfig(config = buildStubRoutingConfig()) {
      if (!executorConfigPath) {
        throw new Error("Expected executor config path to be enabled for this harness");
      }
      writeFileSync(executorConfigPath, JSON.stringify(config));
      return executorConfigPath;
    },
    cleanup() {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      resetFeishuTokenCache();
      globalThis.fetch = originalFetch;
      restoreEnv(originalEnv);
      rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}
