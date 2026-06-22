import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";

import { createFeishuFetchMock, createFeishuTestHarness } from "./feishu-test-harness";

test("createFeishuTestHarness sets baseline env, writes stub executor config, and restores global state", async () => {
  const originalOutboundStyle = process.env.MAGISTER_FEISHU_OUTBOUND_STYLE;
  const originalDefaultWorkspaceId = process.env.MAGISTER_DEFAULT_WORKSPACE_ID;
  const originalExecutorConfigPath = process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  process.env.MAGISTER_DB_PATH = "/tmp/original-db.sqlite";
  process.env.MAGISTER_FEISHU_APP_ID = "original-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "original-app-secret";
  process.env.MAGISTER_WEB_PUBLIC_BASE_URL = "https://original.example.com/";
  const originalFetch = globalThis.fetch;

  const harness = createFeishuTestHarness({
    name: "feishu-harness-baseline",
    includeExecutorConfig: true,
    defaultWorkspaceId: "workspace_test",
    outboundStyle: "compact",
    webPublicBaseUrl: "https://console.example.com/",
  });

  harness.installFetchStub(async () => new Response("ok"));
  harness.writeStubExecutorConfig();

  expect(process.env.MAGISTER_DB_PATH).toBe(harness.dbPath);
  expect(process.env.MAGISTER_FEISHU_APP_ID).toBe("cli-agent-app-id");
  expect(process.env.MAGISTER_FEISHU_APP_SECRET).toBe("cli-agent-app-secret");
  expect(process.env.MAGISTER_DEFAULT_WORKSPACE_ID).toBe("workspace_test");
  expect(process.env.MAGISTER_FEISHU_OUTBOUND_STYLE).toBe("compact");
  expect(process.env.MAGISTER_WEB_PUBLIC_BASE_URL).toBe("https://console.example.com/");
  expect(process.env.MAGISTER_EXECUTOR_CONFIG_PATH).toBe(harness.executorConfigPath);
  expect(globalThis.fetch).not.toBe(originalFetch);
  expect(existsSync(harness.executorConfigPath!)).toBe(true);
  expect(JSON.parse(readFileSync(harness.executorConfigPath!, "utf8"))).toMatchObject({
    roleRouting: {
      manager: "codex",
      reviewer: "qoder",
    },
  });

  harness.cleanup();

  expect(process.env.MAGISTER_DB_PATH).toBe("/tmp/original-db.sqlite");
  expect(process.env.MAGISTER_FEISHU_APP_ID).toBe("original-app-id");
  expect(process.env.MAGISTER_FEISHU_APP_SECRET).toBe("original-app-secret");
  expect(process.env.MAGISTER_WEB_PUBLIC_BASE_URL).toBe("https://original.example.com/");
  expect(process.env.MAGISTER_DEFAULT_WORKSPACE_ID).toBe(originalDefaultWorkspaceId);
  expect(process.env.MAGISTER_FEISHU_OUTBOUND_STYLE).toBe(originalOutboundStyle);
  expect(process.env.MAGISTER_EXECUTOR_CONFIG_PATH).toBe(originalExecutorConfigPath);
  expect(globalThis.fetch).toBe(originalFetch);
  expect(existsSync(harness.tempRoot)).toBe(false);
});

test("createFeishuTestHarness seeds channel sessions after initializing the database schema", () => {
  const harness = createFeishuTestHarness({
    name: "feishu-harness-channel-session",
  });

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_visible",
    continuityMode: "top_level_preferred",
    currentTaskId: "task_visible_delivery",
    latestInboundMessageId: "om_visible_inbound",
    latestAnswerSummary: "Visible answers should go to the top level.",
    verboseLevel: "full",
    now: new Date("2026-04-14T02:00:00.000Z"),
  });

  const sqlite = new Database(harness.dbPath);
  const inserted = sqlite
    .query(
      "select id, binding_id, continuity_mode, current_task_id, latest_inbound_message_id, latest_answer_summary, verbose_level from channel_sessions",
    )
    .get() as {
    id: string;
    binding_id: string;
    continuity_mode: string;
    current_task_id: string | null;
    latest_inbound_message_id: string | null;
    latest_answer_summary: string | null;
    verbose_level: string | null;
  };
  sqlite.close();
  harness.cleanup();

  expect(inserted).toEqual({
    id: "feishu:tenant_alpha:oc_chat_visible",
    binding_id: "feishu:tenant_alpha:oc_chat_visible",
    continuity_mode: "top_level_preferred",
    current_task_id: "task_visible_delivery",
    latest_inbound_message_id: "om_visible_inbound",
    latest_answer_summary: "Visible answers should go to the top level.",
    verbose_level: "full",
  });
});

test("createFeishuFetchMock captures requests and serves the standard Feishu endpoints", async () => {
  const mock = createFeishuFetchMock({
    reactionId: "reaction_visible_ok",
    replyMessageId: "om_reply_visible",
    topLevelMessageId: "om_top_level_visible",
    defaultMessageId: "om_default_visible",
  });

  const tokenResponse = await mock.fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {},
  );
  const reactionResponse = await mock.fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent/reactions",
    { method: "POST" },
  );
  const replyResponse = await mock.fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent/reply",
    { method: "POST" },
  );
  const topLevelResponse = await mock.fetch(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    { method: "POST" },
  );
  const defaultResponse = await mock.fetch("https://open.feishu.cn/open-apis/im/v1/messages", {
    method: "POST",
  });

  expect(await tokenResponse.json()).toMatchObject({
    tenant_access_token: "tenant_access_token_value",
  });
  expect(await reactionResponse.json()).toMatchObject({
    data: {
      reaction_id: "reaction_visible_ok",
    },
  });
  expect(await replyResponse.json()).toMatchObject({
    data: {
      message_id: "om_reply_visible",
    },
  });
  expect(await topLevelResponse.json()).toMatchObject({
    data: {
      message_id: "om_top_level_visible",
    },
  });
  expect(await defaultResponse.json()).toMatchObject({
    data: {
      message_id: "om_default_visible",
    },
  });
  expect(mock.requests.map((request) => request.url)).toEqual([
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent/reactions",
    "https://open.feishu.cn/open-apis/im/v1/messages/om_parent/reply",
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    "https://open.feishu.cn/open-apis/im/v1/messages",
  ]);
});
