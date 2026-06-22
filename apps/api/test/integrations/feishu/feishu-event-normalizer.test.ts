import { expect, test } from "bun:test";

import { normalizeFeishuInboundEvent } from "../../../src/integrations/feishu/feishu-event-normalizer";

test("normalizes a Feishu text message into the shared inbound channel shape", () => {
  const event = normalizeFeishuInboundEvent({
    schema: "2.0",
    header: {
      event_id: "evt_message_text_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820000000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_text",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_text_1",
        chat_id: "oc_chat_alpha",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "Ship the first coding task",
        }),
        create_time: "1712820005000",
      },
    },
  });

  expect(event).toMatchObject({
    channel: "feishu",
    eventId: "evt_message_text_1",
    eventType: "message",
    accountId: "tenant_alpha",
    chatId: "oc_chat_alpha",
    platformMessageId: "om_message_text_1",
    sender: {
      platformUserId: "ou_sender_text",
      displayName: "Yuhao",
    },
    content: {
      text: "Ship the first coding task",
      payload: {
        chatType: "p2p",
        messageType: "text",
        rawEventType: "im.message.receive_v1",
      },
    },
  });
  expect(event.occurredAt).toBe("2024-04-11T07:20:05.000Z");
});

test("normalizes a Feishu card action into the shared inbound channel shape", () => {
  const event = normalizeFeishuInboundEvent({
    event_id: "evt_card_action_1",
    tenant_key: "tenant_alpha",
    token: "verification-token",
    action_time: "1712820010000",
    open_message_id: "om_card_message_1",
    open_chat_id: "oc_chat_alpha",
    operator: {
      operator_id: {
        open_id: "ou_operator_1",
      },
      name: "Yuhao",
    },
    action: {
      tag: "button",
      value: {
        actionId: "approve_merge",
        approvalId: "approval_1",
      },
    },
  });

  expect(event).toMatchObject({
    channel: "feishu",
    eventId: "evt_card_action_1",
    eventType: "card_action",
    accountId: "tenant_alpha",
    chatId: "oc_chat_alpha",
    platformMessageId: "om_card_message_1",
    sender: {
      platformUserId: "ou_operator_1",
      displayName: "Yuhao",
    },
    content: {
      actionId: "approve_merge",
      payload: {
        actionId: "approve_merge",
        approvalId: "approval_1",
        tag: "button",
      },
    },
  });
  expect(event.occurredAt).toBe("2024-04-11T07:20:10.000Z");
});

test("normalizes a Feishu file upload into the shared inbound channel shape", () => {
  const event = normalizeFeishuInboundEvent({
    schema: "2.0",
    header: {
      event_id: "evt_message_file_1",
      event_type: "im.message.receive_v1",
      tenant_key: "tenant_alpha",
      create_time: "1712820015000",
    },
    event: {
      sender: {
        sender_id: {
          open_id: "ou_sender_file",
        },
        sender_name: "Operator",
      },
      message: {
        message_id: "om_message_file_1",
        chat_id: "oc_chat_beta",
        chat_type: "group",
        message_type: "file",
        content: JSON.stringify({
          file_key: "file_v1_123",
          file_name: "requirements.md",
        }),
        create_time: "1712820018000",
      },
    },
  });

  expect(event).toMatchObject({
    channel: "feishu",
    eventId: "evt_message_file_1",
    eventType: "file",
    accountId: "tenant_alpha",
    chatId: "oc_chat_beta",
    platformMessageId: "om_message_file_1",
    sender: {
      platformUserId: "ou_sender_file",
      displayName: "Operator",
    },
    content: {
      files: [
        {
          fileId: "file_v1_123",
          name: "requirements.md",
        },
      ],
      payload: {
        chatType: "group",
        messageType: "file",
        rawEventType: "im.message.receive_v1",
      },
    },
  });
  expect(event.occurredAt).toBe("2024-04-11T07:20:18.000Z");
});
