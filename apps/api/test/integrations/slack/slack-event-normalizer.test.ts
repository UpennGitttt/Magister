import { expect, test } from "bun:test";

import {
  normalizeSlackBlockActions,
  normalizeSlackEventsApiPayload,
  stripSlackMentions,
} from "../../../src/integrations/slack/slack-event-normalizer";

function buildMessageEnvelope(overrides: {
  event?: Record<string, unknown>;
  envelope?: Record<string, unknown>;
} = {}) {
  return {
    type: "event_callback",
    event_id: "Ev0001",
    team_id: "T0001",
    event: {
      type: "message",
      channel: "D0001",
      channel_type: "im",
      user: "U0001",
      ts: "1726063715.000200",
      text: "hello magister",
      ...overrides.event,
    },
    ...overrides.envelope,
  };
}

test("normalizes a Slack DM into the shared inbound channel shape", () => {
  const event = normalizeSlackEventsApiPayload(buildMessageEnvelope());

  expect(event).toMatchObject({
    channel: "slack",
    eventId: "Ev0001",
    eventType: "message",
    accountId: "T0001",
    chatId: "D0001",
    platformMessageId: "1726063715.000200",
    chatType: "p2p",
    sender: { platformUserId: "U0001" },
    content: { text: "hello magister" },
  });
  expect(event?.mentions).toBeUndefined();
  expect(event?.threadId).toBeUndefined();
  expect(event?.occurredAt).toBe(new Date(1726063715.0002 * 1000).toISOString());
});

test("app_mention in a channel synthesizes a mention and strips the bot token", () => {
  const event = normalizeSlackEventsApiPayload(
    buildMessageEnvelope({
      event: {
        type: "app_mention",
        channel: "C0002",
        channel_type: undefined,
        text: "<@U0BOT> run the report",
      },
    }),
  );

  expect(event).toMatchObject({
    chatType: "group",
    chatId: "C0002",
    content: { text: "run the report" },
  });
  expect(event?.mentions?.length).toBe(1);
});

test("thread replies map thread_ts to threadId, parents do not", () => {
  const reply = normalizeSlackEventsApiPayload(
    buildMessageEnvelope({ event: { thread_ts: "1726000000.000100" } }),
  );
  expect(reply?.threadId).toBe("1726000000.000100");

  const parent = normalizeSlackEventsApiPayload(
    buildMessageEnvelope({ event: { thread_ts: "1726063715.000200" } }),
  );
  expect(parent?.threadId).toBeUndefined();
});

test("bot echoes and subtyped messages are dropped", () => {
  expect(
    normalizeSlackEventsApiPayload(buildMessageEnvelope({ event: { bot_id: "B0001" } })),
  ).toBeNull();
  expect(
    normalizeSlackEventsApiPayload(
      buildMessageEnvelope({ event: { subtype: "message_changed" } }),
    ),
  ).toBeNull();
  expect(
    normalizeSlackEventsApiPayload(buildMessageEnvelope({ event: { type: "reaction_added" } })),
  ).toBeNull();
});

test("stripSlackMentions removes all mention tokens or only the bot's", () => {
  expect(stripSlackMentions("<@U1> hi <@U2|name> there")).toBe("hi there");
  expect(stripSlackMentions("<@U1> hi <@U2> there", "U1")).toBe("hi <@U2> there");
  expect(stripSlackMentions(undefined)).toBe("");
});

test("normalizes block_actions into a card_action event carrying the envelope", () => {
  const interaction = normalizeSlackBlockActions({
    type: "block_actions",
    trigger_id: "trig_1",
    user: { id: "U0001", username: "operator" },
    team: { id: "T0001" },
    channel: { id: "C0002" },
    container: { message_ts: "1726063715.000200", channel_id: "C0002" },
    actions: [
      { action_id: "magister_approval_approve", value: '{"oc":"ocf1"}' },
    ],
  });

  expect(interaction?.event).toMatchObject({
    channel: "slack",
    eventType: "card_action",
    eventId: "trig_1",
    accountId: "T0001",
    chatId: "C0002",
    sender: { platformUserId: "U0001", displayName: "operator" },
    content: { payload: { envelope: '{"oc":"ocf1"}' } },
  });
  expect(interaction?.messageTs).toBe("1726063715.000200");
  expect(interaction?.actions[0]?.actionId).toBe("magister_approval_approve");
});

test("non-block_actions interactivity payloads return null", () => {
  expect(normalizeSlackBlockActions({ type: "view_submission" })).toBeNull();
  expect(
    normalizeSlackBlockActions({
      type: "block_actions",
      trigger_id: "trig_2",
      user: { id: "U0001" },
      team: { id: "T0001" },
      channel: { id: "C0002" },
      actions: [],
    }),
  ).toBeNull();
});
