import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { buildFeishuApprovalCard } from "../../src/integrations/feishu/feishu-approval-card";
import { buildFeishuRequestSignature } from "../../src/integrations/feishu/feishu-signature";
import { ApprovalRepository } from "../../src/repositories/approval-repository";
import { ConversationBindingRepository } from "../../src/repositories/conversation-binding-repository";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { buildApp } from "../../src/app";
import {
  createFeishuFetchMock,
  createFeishuTestHarness,
  type FeishuTestHarness,
} from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "feishu-channel-events-db",
    includeExecutorConfig: true,
    defaultWorkspaceId: "workspace_main",
  });
  harness.writeStubExecutorConfig();
  harness.installFetchStub(
    createFeishuFetchMock({
      reactionId: "reaction_channel_event_ok",
      defaultMessageId: "om_text_message_channel_event",
    }).fetch,
  );
});

afterEach(() => {
  harness.cleanup();
});

test("POST /channel-events accepts a signed Feishu text message, resolves a binding, and creates a task", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820100000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_1",
        chat_id: "oc_chat_route",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "Create a task from Feishu",
        }),
        create_time: "1712820103000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820103";
  const nonce = "nonce-feishu-route-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      binding: {
        id: "feishu:tenant_alpha:oc_chat_route",
        workspaceId: "workspace_main",
        status: "created",
      },
      intake: {
        action: "task_created",
        workspaceId: "workspace_main",
        source: "feishu",
        title: "Create a task from Feishu",
      },
      normalizedEvent: {
        channel: "feishu",
        eventId: "evt_message_route_1",
        eventType: "message",
        accountId: "tenant_alpha",
        chatId: "oc_chat_route",
        platformMessageId: "om_message_route_1",
        sender: {
          platformUserId: "ou_sender_route",
          displayName: "Yuhao",
        },
        content: {
          text: "Create a task from Feishu",
        },
      },
    },
  });

  const eventRepository = new ExecutionEventRepository();
  const recordedEvents = await eventRepository.listAll();
  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const tasks = sqlite
    .query(
      "select id, workspace_id, source, title, root_channel_binding_id, created_by from tasks order by created_at asc",
    )
    .all() as Array<{
    id: string;
    workspace_id: string;
    source: string;
    title: string;
    root_channel_binding_id: string | null;
    created_by: string | null;
  }>;
  const bindings = sqlite
    .query(
      "select id, channel, account_id, chat_id, workspace_id, last_sender_user_id, last_platform_message_id from conversation_bindings order by created_at asc",
    )
    .all() as Array<{
    id: string;
    channel: string;
    account_id: string;
    chat_id: string;
    workspace_id: string;
    last_sender_user_id: string | null;
    last_platform_message_id: string | null;
  }>;
  sqlite.close();

  const inboundEvent = recordedEvents.find((event) => event.type === "channel.inbound.received");
  expect(inboundEvent).toMatchObject({
    type: "channel.inbound.received",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_route",
    severity: "info",
    workspaceId: "workspace_main",
  });
  // Single-card design (Task 8 / S9): there is NO separate "received /
  // processing" acknowledgement event anymore. The single-card streaming
  // session is the sole, immediate outbound — the old
  // `channel.outbound.delivered` ack with kind:"task_created" / title:"⏳"
  // (OnIt reaction) is gone.
  const ackDeliveredEvent = recordedEvents.find((event) => {
    if (event.type !== "channel.outbound.delivered") {
      return false;
    }
    const payload = JSON.parse(String(event.payloadJson)) as { kind?: string };
    return payload.kind === "task_created";
  });
  expect(ackDeliveredEvent).toBeUndefined();
  expect(tasks).toHaveLength(1);
  expect(tasks[0]).toMatchObject({
    workspace_id: "workspace_main",
    source: "feishu",
    title: "Create a task from Feishu",
    root_channel_binding_id: "feishu:tenant_alpha:oc_chat_route",
    created_by: "ou_sender_route",
  });
  expect(bindings).toEqual([
    {
      id: "feishu:tenant_alpha:oc_chat_route",
      channel: "feishu",
      account_id: "tenant_alpha",
      chat_id: "oc_chat_route",
      workspace_id: "workspace_main",
      last_sender_user_id: "ou_sender_route",
      last_platform_message_id: "om_message_route_1",
    },
  ]);
});

test("POST /channel-events persists channel session continuity for a new Feishu task", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_session_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_gamma",
      create_time: "1712820300000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_session",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_session_1",
        chat_id: "oc_chat_route_session",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "Track the channel session state",
        }),
        create_time: "1712820303000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820303";
  const nonce = "nonce-feishu-route-session-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const sessions = sqlite
    .query(
      "select id, binding_id, continuity_mode, current_task_id, latest_inbound_message_id, latest_delivered_message_id from channel_sessions order by created_at asc",
    )
    .all() as Array<{
    id: string;
    binding_id: string;
    continuity_mode: string;
    current_task_id: string | null;
    latest_inbound_message_id: string | null;
    latest_delivered_message_id: string | null;
  }>;
  sqlite.close();

  expect(sessions).toHaveLength(1);
  expect(sessions[0]).toMatchObject({
    id: "feishu:tenant_gamma:oc_chat_route_session",
    binding_id: "feishu:tenant_gamma:oc_chat_route_session",
    continuity_mode: "reply_preferred",
    current_task_id: expect.any(String),
    latest_inbound_message_id: "om_message_route_session_1",
  });
});

test("POST /channel-events handles standalone /verbose full without creating a task", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_verbose_full_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820350000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_verbose_full",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_verbose_full_1",
        chat_id: "oc_chat_route_verbose_full",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "/verbose full",
        }),
        create_time: "1712820353000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820353";
  const nonce = "nonce-feishu-route-verbose-full-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_verbose_full_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      binding: {
        id: "feishu:tenant_alpha:oc_chat_route_verbose_full",
      },
      intake: {
        action: "ignored",
        reason: "control_command",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const sessions = sqlite
    .query(
      "select binding_id, verbose_level from channel_sessions where binding_id = ?",
    )
    .all("feishu:tenant_alpha:oc_chat_route_verbose_full") as Array<{
    binding_id: string;
    verbose_level: string | null;
  }>;
  const taskCount = sqlite.query("select count(*) as count from tasks").get() as {
    count: number;
  };
  sqlite.close();

  expect(taskCount.count).toBe(0);
  expect(sessions).toEqual([
    {
      binding_id: "feishu:tenant_alpha:oc_chat_route_verbose_full",
      verbose_level: "full",
    },
  ]);

  const confirmationRequest = outboundRequests.find((request) =>
    request.url.includes("/messages/om_message_route_verbose_full_1/reply"),
  );
  expect(confirmationRequest).toBeDefined();
  const confirmationBody = JSON.parse(String(confirmationRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const confirmationContent = JSON.parse(String(confirmationBody.content ?? "{}")) as {
    text?: string;
  };
  expect(confirmationContent.text).toContain("Verbose");
  expect(confirmationContent.text).toContain("full");
  expect(outboundRequests.some((request) => request.url.includes("/reactions"))).toBe(false);
});

test("POST /channel-events reports the current verbose level without creating a task", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_verbose_status_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820360000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_verbose_status",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_verbose_status_1",
        chat_id: "oc_chat_route_verbose_status",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "/verbose",
        }),
        create_time: "1712820363000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820363";
  const nonce = "nonce-feishu-route-verbose-status-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_verbose_status_1",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  harness.seedChannelSession({
    bindingId: "feishu:tenant_alpha:oc_chat_route_verbose_status",
    verboseLevel: "on",
    now: new Date("2026-04-17T02:00:00.000Z"),
  });

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      intake: {
        action: "ignored",
        reason: "control_command",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const taskCount = sqlite.query("select count(*) as count from tasks").get() as {
    count: number;
  };
  const sessionRow = sqlite
    .query("select verbose_level from channel_sessions where binding_id = ?")
    .get("feishu:tenant_alpha:oc_chat_route_verbose_status") as {
    verbose_level: string | null;
  };
  sqlite.close();

  expect(taskCount.count).toBe(0);
  expect(sessionRow.verbose_level).toBe("on");

  const confirmationRequest = outboundRequests.find((request) =>
    request.url.includes("/messages/om_message_route_verbose_status_1/reply"),
  );
  expect(confirmationRequest).toBeDefined();
  const confirmationBody = JSON.parse(String(confirmationRequest?.init?.body ?? "{}")) as {
    content?: string;
  };
  const confirmationContent = JSON.parse(String(confirmationBody.content ?? "{}")) as {
    text?: string;
  };
  expect(confirmationContent.text).toContain("当前");
  expect(confirmationContent.text).toContain("on");
});

test("POST /channel-events tolerates Feishu control-command reply failures without aborting intake", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_verbose_failure_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820365000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_verbose_failure",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_verbose_failure_1",
        chat_id: "oc_chat_route_verbose_failure",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "/verbose full",
        }),
        create_time: "1712820368000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820368";
  const nonce = "nonce-feishu-route-verbose-failure-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const fetchMock = createFeishuFetchMock({
    customHandler: (url) => {
      if (url.includes("/reply")) {
        throw new Error("reply delivery failed");
      }
      return null;
    },
  });
  harness.installFetchStub(fetchMock.fetch);

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      intake: {
        action: "ignored",
        reason: "control_command",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const taskCount = sqlite.query("select count(*) as count from tasks").get() as {
    count: number;
  };
  const sessionRow = sqlite
    .query("select verbose_level from channel_sessions where binding_id = ?")
    .get("feishu:tenant_alpha:oc_chat_route_verbose_failure") as {
    verbose_level: string | null;
  };
  sqlite.close();

  expect(taskCount.count).toBe(0);
  expect(sessionRow.verbose_level).toBe("full");

  const failedEvent = (await new ExecutionEventRepository().listAll()).find((event) => {
    if (event.type !== "channel.outbound.failed") {
      return false;
    }
    const payload = JSON.parse(String(event.payloadJson)) as { code?: string };
    return payload.code === "control_command_reply_failed";
  });

  expect(failedEvent).toMatchObject({
    type: "channel.outbound.failed",
    conversationBindingId: "feishu:tenant_alpha:oc_chat_route_verbose_failure",
    severity: "warn",
  });
  expect(JSON.parse(String(failedEvent?.payloadJson))).toMatchObject({
    channel: "feishu",
    bindingId: "feishu:tenant_alpha:oc_chat_route_verbose_failure",
    code: "control_command_reply_failed",
  });
});

test("POST /channel-events sends NO separate ack text/reaction even when the session requests an always-visible ack (single-card replaces it)", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_visible_ack_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_delta",
      create_time: "1712820400000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_visible_ack",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_visible_ack_1",
        chat_id: "oc_chat_route_visible_ack",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "Make the acknowledgement visible",
        }),
        create_time: "1712820403000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820403";
  const nonce = "nonce-feishu-route-visible-ack-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const fetchMock = createFeishuFetchMock({
    topLevelMessageId: "om_visible_ack_message_123",
  });
  const outboundRequests = fetchMock.requests;
  harness.installFetchStub(fetchMock.fetch);

  const initRepository = new ConversationBindingRepository();
  await initRepository.getById("feishu:tenant_delta:oc_chat_route_visible_ack");

  const now = new Date("2026-04-11T06:30:00.000Z");
  harness.seedChannelSession({
    bindingId: "feishu:tenant_delta:oc_chat_route_visible_ack",
    continuityMode: "always_visible_ack",
    now,
  });

  const app = buildApp();
  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
    },
  });
  // Single-card design (Task 8 / S9): even when the session requested an
  // "always_visible_ack", we no longer send a separate "已收到，正在处理"
  // text message. The single-card streaming session is the sole, visible
  // outbound — it eager-creates a "⏳ Thinking…" card. So NO ack text and
  // NO OnIt reaction should be sent on intake.
  const visibleAckRequest = outboundRequests.find((request) => {
    if (request.url !== "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id") {
      return false;
    }

    const body = JSON.parse(String(request.init?.body ?? "{}")) as {
      receive_id?: string;
      msg_type?: string;
      content?: string;
    };
    if (body.receive_id !== "oc_chat_route_visible_ack" || body.msg_type !== "text") {
      return false;
    }

    const content = JSON.parse(String(body.content ?? "{}")) as { text?: string };
    return content.text === "已收到，正在处理";
  });
  expect(visibleAckRequest).toBeUndefined();
  expect(outboundRequests.some((request) => request.url.includes("/reactions"))).toBe(false);
});

test("POST /channel-events keeps workspace-awareness questions on the manager runtime path", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_local_shortcut_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820200000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_local",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_local_1",
        chat_id: "oc_chat_route_local",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "当前工作文件夹是啥",
        }),
        create_time: "1712820203000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820203";
  const nonce = "nonce-feishu-route-local-1";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      intake: {
        action: "task_created",
        source: "feishu",
        title: "当前工作文件夹是啥",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const task = sqlite
    .query(
      "select id, state from tasks where title = ? order by created_at desc limit 1",
    )
    .get("当前工作文件夹是啥") as { id: string; state: string } | null;
  sqlite.close();

  expect(task).toBeDefined();
  expect(task!.id).toMatch(/^task_/);

  await app.close();
});

test("POST /channel-events reuses an existing binding for card actions and skips task intake", async () => {
  const timestamp = "1712820105";
  const nonce = "nonce-feishu-route-3";
  const messagePayload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_2",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_beta",
      create_time: "1712820105000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_two",
        },
        sender_name: "Feishu User",
      },
      message: {
        message_id: "om_message_route_2",
        chat_id: "oc_chat_route_two",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "Create another task",
        }),
        create_time: "1712820105000",
      },
    },
  };
  const messageBody = JSON.stringify(messagePayload);
  const messageSignature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: messageBody,
  });

  const app = buildApp();
  const approvalRepository = new ApprovalRepository();
  const firstResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": messageSignature,
    },
    payload: messageBody,
  });
  expect(firstResponse.statusCode).toBe(202);
  const created = firstResponse.json() as {
    data: { intake: { action: "task_created"; taskId: string; latestRunId: string } };
  };

  await approvalRepository.create({
    id: "approval_feishu_card_action_1",
    taskId: created.data.intake.taskId,
    roleRuntimeId: created.data.intake.latestRunId,
    approvalType: "merge",
    state: "pending",
    requestedAt: new Date(),
  });

  const card = buildFeishuApprovalCard({
    approval: {
      id: "approval_feishu_card_action_1",
      taskId: created.data.intake.taskId,
      roleRuntimeId: created.data.intake.latestRunId,
      approvalType: "merge",
      state: "pending",
      requestedAt: new Date().toISOString(),
      resolvedAt: null,
      resolvedBy: null,
    },
    bindingId: "feishu:tenant_beta:oc_chat_route_two",
    taskTitle: "Create another task",
    secret: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    now: new Date(),
  });
  const approveAction = card.actions[0]!;

  const actionPayload = {
    open_id: "ou_sender_route_two",
    user_name: "Feishu User",
    open_message_id: "om_message_route_two_card",
    open_chat_id: "oc_chat_route_two",
    tenant_key: "tenant_beta",
    event_id: "evt_card_route_1",
    action_time: "1712820107000",
    action: {
      tag: "button",
      value: {
        actionId: "approve_task",
        approvalId: approveAction.approvalId,
        bindingId: approveAction.bindingId,
        resolution: approveAction.resolution,
        expiresAt: approveAction.expiresAt,
        signedToken: approveAction.signedToken,
      },
    },
  };
  const actionBody = JSON.stringify(actionPayload);
  const actionTimestamp = "1712820107";
  const actionNonce = "nonce-feishu-route-4";
  const actionSignature = buildFeishuRequestSignature({
    timestamp: actionTimestamp,
    nonce: actionNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: actionBody,
  });

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": actionTimestamp,
      "x-feishu-request-nonce": actionNonce,
      "x-feishu-signature": actionSignature,
    },
    payload: actionBody,
  });

  expect(response.statusCode).toBe(202);
  expect(response.json()).toMatchObject({
    ok: true,
    data: {
      accepted: true,
      binding: {
        id: "feishu:tenant_beta:oc_chat_route_two",
        workspaceId: "workspace_main",
        status: "resolved",
      },
      intake: {
        action: "approval_resolved",
        approvalId: "approval_feishu_card_action_1",
        bindingId: "feishu:tenant_beta:oc_chat_route_two",
        state: "approved",
      },
      normalizedEvent: {
        eventType: "card_action",
        chatId: "oc_chat_route_two",
      },
    },
  });
});

test("POST /channel-events ignores duplicate Feishu message events without creating a second task", async () => {
  const payload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_duplicate_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820110000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_duplicate",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_duplicate_1",
        chat_id: "oc_chat_route_duplicate",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "你好，你是谁",
        }),
        create_time: "1712820113000",
      },
    },
  };

  const serializedPayload = JSON.stringify(payload);
  const timestamp = "1712820113";
  const nonce = "nonce-feishu-route-duplicate";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: serializedPayload,
  });

  const app = buildApp();
  const firstResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });
  const secondResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: serializedPayload,
  });

  expect(firstResponse.statusCode).toBe(202);
  expect(secondResponse.statusCode).toBe(202);
  expect(secondResponse.json()).toMatchObject({
    ok: true,
    data: {
      binding: {
        id: "feishu:tenant_alpha:oc_chat_route_duplicate",
        status: "duplicate",
      },
      intake: {
        action: "ignored",
        reason: "duplicate_event",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const tasks = sqlite.query("select id from tasks order by created_at asc").all() as Array<{
    id: string;
  }>;
  sqlite.close();

  expect(tasks).toHaveLength(1);
});

test("POST /channel-events treats repeated platform message ids as duplicate events", async () => {
  const firstPayload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_duplicate_platform_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820210000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_duplicate_platform",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_duplicate_platform_1",
        chat_id: "oc_chat_route_duplicate_platform",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "当前工作文件夹是啥",
        }),
        create_time: "1712820213000",
      },
    },
  };
  const secondPayload = {
    ...firstPayload,
    header: {
      ...firstPayload.header,
      event_id: "evt_message_route_duplicate_platform_2",
    },
  };

  const firstBody = JSON.stringify(firstPayload);
  const secondBody = JSON.stringify(secondPayload);
  const timestamp = "1712820213";
  const firstNonce = "nonce-feishu-route-duplicate-platform-1";
  const secondNonce = "nonce-feishu-route-duplicate-platform-2";
  const firstSignature = buildFeishuRequestSignature({
    timestamp,
    nonce: firstNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: firstBody,
  });
  const secondSignature = buildFeishuRequestSignature({
    timestamp,
    nonce: secondNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: secondBody,
  });

  const app = buildApp();

  const firstResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": firstNonce,
      "x-feishu-signature": firstSignature,
    },
    payload: firstBody,
  });
  const secondResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": secondNonce,
      "x-feishu-signature": secondSignature,
    },
    payload: secondBody,
  });

  expect(firstResponse.statusCode).toBe(202);
  expect(secondResponse.statusCode).toBe(202);
  expect(secondResponse.json()).toMatchObject({
    ok: true,
    data: {
      binding: {
        id: "feishu:tenant_alpha:oc_chat_route_duplicate_platform",
        status: "duplicate",
      },
      intake: {
        action: "ignored",
        reason: "duplicate_event",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const tasks = sqlite.query("select id from tasks order by created_at asc").all() as Array<{
    id: string;
  }>;
  sqlite.close();

  expect(tasks).toHaveLength(1);
});

test("POST /channel-events treats historical message replays as duplicate events even after newer messages", async () => {
  const firstPayload = {
    schema: "2.0",
    header: {
      event_id: "evt_message_route_replay_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820310000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_route_replay",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_route_replay_1",
        chat_id: "oc_chat_route_replay",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "第一条消息",
        }),
        create_time: "1712820313000",
      },
    },
  };
  const secondPayload = {
    ...firstPayload,
    header: {
      ...firstPayload.header,
      event_id: "evt_message_route_replay_2",
      create_time: "1712820320000",
    },
    event: {
      ...firstPayload.event,
      message: {
        ...firstPayload.event.message,
        message_id: "om_message_route_replay_2",
        content: JSON.stringify({
          text: "第二条消息",
        }),
        create_time: "1712820323000",
      },
    },
  };
  const replayPayload = {
    ...firstPayload,
    header: {
      ...firstPayload.header,
      event_id: "evt_message_route_replay_1_retry",
      create_time: "1712820330000",
    },
  };

  const firstBody = JSON.stringify(firstPayload);
  const secondBody = JSON.stringify(secondPayload);
  const replayBody = JSON.stringify(replayPayload);
  const timestamp = "1712820333";
  const firstNonce = "nonce-feishu-route-replay-1";
  const secondNonce = "nonce-feishu-route-replay-2";
  const replayNonce = "nonce-feishu-route-replay-3";

  const firstSignature = buildFeishuRequestSignature({
    timestamp,
    nonce: firstNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: firstBody,
  });
  const secondSignature = buildFeishuRequestSignature({
    timestamp,
    nonce: secondNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: secondBody,
  });
  const replaySignature = buildFeishuRequestSignature({
    timestamp,
    nonce: replayNonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: replayBody,
  });

  const app = buildApp();

  const firstResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": firstNonce,
      "x-feishu-signature": firstSignature,
    },
    payload: firstBody,
  });
  const secondResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": secondNonce,
      "x-feishu-signature": secondSignature,
    },
    payload: secondBody,
  });
  const replayResponse = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": replayNonce,
      "x-feishu-signature": replaySignature,
    },
    payload: replayBody,
  });

  expect(firstResponse.statusCode).toBe(202);
  expect(secondResponse.statusCode).toBe(202);
  expect(replayResponse.statusCode).toBe(202);
  expect(replayResponse.json()).toMatchObject({
    ok: true,
    data: {
      binding: {
        id: "feishu:tenant_alpha:oc_chat_route_replay",
        status: "duplicate",
      },
      intake: {
        action: "ignored",
        reason: "duplicate_event",
      },
    },
  });

  const sqlite = new Database(process.env.MAGISTER_DB_PATH!);
  const tasks = sqlite
    .query("select id from tasks where root_channel_binding_id = ? order by created_at asc")
    .all("feishu:tenant_alpha:oc_chat_route_replay") as Array<{ id: string }>;
  sqlite.close();

  // 2026-05-18 Phase B follow-up routing: same-chat messages reuse
  // the active task (continuity), so two distinct messages create
  // one task with a resumed leader session — not two top-level
  // tasks. The replay dedup at the inbound layer above is still
  // verified by the duplicate intake assertion. Was 2 under the
  // pre-Phase-B "every im.message creates a new task" model.
  expect(tasks).toHaveLength(1);
});

test("POST /channel-events rejects unsigned Feishu payloads", async () => {
  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    payload: {
      schema: "2.0",
      header: {
        event_id: "evt_unsigned_1",
        event_type: "im.message.receive_v1",
        tenant_key: "tenant_alpha",
      },
      event: {
        sender: {
          sender_id: {
            open_id: "ou_unsigned",
          },
        },
        message: {
          message_id: "om_unsigned_1",
          chat_id: "oc_chat_unsigned",
          message_type: "text",
          content: JSON.stringify({ text: "Unsigned" }),
        },
      },
    },
  });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({
    ok: false,
    error: {
      code: "invalid_channel_signature",
      message: "Feishu request signature is missing or invalid",
    },
  });
});

test("POST /channel-events rejects tampered Feishu payloads", async () => {
  const originalPayload = JSON.stringify({
    schema: "2.0",
    header: {
      event_id: "evt_tampered_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_tampered",
        },
      },
      message: {
        message_id: "om_tampered_1",
        chat_id: "oc_chat_tampered",
        message_type: "text",
        content: JSON.stringify({ text: "Original body" }),
      },
    },
  });

  const tamperedPayload = JSON.stringify({
    schema: "2.0",
    header: {
      event_id: "evt_tampered_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_tampered",
        },
      },
      message: {
        message_id: "om_tampered_1",
        chat_id: "oc_chat_tampered",
        message_type: "text",
        content: JSON.stringify({ text: "Tampered body" }),
      },
    },
  });

  const timestamp = "1712820104";
  const nonce = "nonce-feishu-route-2";
  const signature = buildFeishuRequestSignature({
    timestamp,
    nonce,
    verificationToken: process.env.MAGISTER_FEISHU_VERIFICATION_TOKEN!,
    rawBody: originalPayload,
  });

  const app = buildApp();

  const response = await app.inject({
    method: "POST",
    url: "/channel-events",
    headers: {
      "content-type": "application/json",
      "x-feishu-request-timestamp": timestamp,
      "x-feishu-request-nonce": nonce,
      "x-feishu-signature": signature,
    },
    payload: tamperedPayload,
  });

  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({
    ok: false,
    error: {
      code: "invalid_channel_signature",
      message: "Feishu request signature is missing or invalid",
    },
  });
});
