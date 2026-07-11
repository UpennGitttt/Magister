import type { InboundChannelEvent } from "../feishu/feishu-event-normalizer";

/**
 * Slack Events API / interactivity payloads → the shared
 * InboundChannelEvent shape consumed by processChannelEvent().
 *
 * Mapping:
 *   event_id           → eventId   (envelope-level, retry-stable)
 *   team_id            → accountId
 *   event.channel      → chatId
 *   event.ts           → platformMessageId
 *   event.thread_ts    → threadId  (present only for threaded replies)
 *   channel_type "im"  → chatType "p2p", everything else "group"
 *
 * DM double-delivery (message.im + app_mention firing for the same
 * message) is absorbed downstream by the `platform:<ts>` dedupe key —
 * both events share the same message ts.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Slack ts ("1726063715.000200", seconds.micros) → ISO string. */
function tsToIso(ts: string | undefined): string {
  const parsed = ts ? Number.parseFloat(ts) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Unsupported Slack timestamp: ${ts}`);
  }
  return new Date(parsed * 1000).toISOString();
}

/** Strip `<@UXXX>` mention tokens (optionally only the bot's own). */
export function stripSlackMentions(text: string | undefined, botUserId?: string): string {
  if (!text) return "";
  const pattern = botUserId ? new RegExp(`<@${botUserId}(\\|[^>]*)?>`, "g") : /<@[A-Z0-9]+(\|[^>]*)?>/g;
  return text.replace(pattern, "").replace(/\s+/g, " ").trim();
}

/**
 * Returns null for events we deliberately ignore: bot echoes (our own
 * replies would loop forever), message edits/deletes (`subtype`), and
 * anything without the identity fields the pipeline requires.
 */
export function normalizeSlackEventsApiPayload(payload: unknown): InboundChannelEvent | null {
  const record = asRecord(payload);
  const event = asRecord(record?.event);
  if (!record || !event) {
    throw new Error("Slack payload must be an events_api envelope with an event");
  }

  const eventType = readString(event.type);
  if (eventType !== "message" && eventType !== "app_mention") {
    return null;
  }
  // subtype covers message_changed / message_deleted / bot_message /
  // channel_join etc — none of which should spawn tasks.
  if (readString(event.subtype) || readString(event.bot_id)) {
    return null;
  }

  const eventId = readString(record.event_id);
  const accountId = readString(record.team_id);
  const chatId = readString(event.channel);
  const userId = readString(event.user);
  const ts = readString(event.ts);
  if (!eventId || !accountId || !chatId || !userId || !ts) {
    throw new Error("Slack message payload is missing required identity fields");
  }

  const channelType = readString(event.channel_type);
  const chatType: "p2p" | "group" =
    channelType === "im" ? "p2p" : "group";
  // A thread reply carries thread_ts !== ts; a thread PARENT has
  // thread_ts === ts, which must NOT become a separate binding.
  const threadTs = readString(event.thread_ts);
  const threadId = threadTs && threadTs !== ts ? threadTs : undefined;

  const rawText = readString(event.text) ?? "";
  const text = stripSlackMentions(rawText);

  return {
    channel: "slack",
    eventId,
    eventType: "message",
    accountId,
    chatId,
    ...(threadId ? { threadId } : {}),
    platformMessageId: ts,
    chatType,
    // app_mention implies the bot was mentioned — synthesize a mention
    // entry so processChannelEvent's group @mention gate passes. Plain
    // channel `message` events (no mention) stay empty and get dropped
    // by that gate, matching the Feishu posture.
    ...(eventType === "app_mention"
      ? { mentions: [{ key: "slack-app-mention", id: {}, name: "bot" }] }
      : {}),
    sender: { platformUserId: userId },
    content: {
      ...(text ? { text } : {}),
      payload: { messageType: eventType, chatType },
    },
    occurredAt: tsToIso(ts),
  };
}

export type SlackBlockAction = {
  actionId: string;
  value: unknown;
};

export type NormalizedSlackInteraction = {
  event: InboundChannelEvent;
  actions: SlackBlockAction[];
  /** The message the button lives on — needed for chat.update. */
  messageTs: string | undefined;
};

/** block_actions interactivity payload → card_action event. */
export function normalizeSlackBlockActions(payload: unknown): NormalizedSlackInteraction | null {
  const record = asRecord(payload);
  if (!record || record.type !== "block_actions") {
    return null;
  }

  const user = asRecord(record.user);
  const team = asRecord(record.team);
  const channel = asRecord(record.channel);
  const container = asRecord(record.container);
  const rawActions = Array.isArray(record.actions) ? record.actions : [];

  const accountId = readString(team?.id);
  const chatId = readString(channel?.id) ?? readString(container?.channel_id);
  const userId = readString(user?.id);
  // block_actions has no event_id — trigger_id is unique per click.
  const eventId = readString(record.trigger_id);
  if (!accountId || !chatId || !userId || !eventId) {
    throw new Error("Slack block_actions payload is missing required identity fields");
  }

  const actions: SlackBlockAction[] = [];
  for (const raw of rawActions) {
    const rec = asRecord(raw);
    const actionId = readString(rec?.action_id);
    if (!actionId) continue;
    actions.push({ actionId, value: rec?.value });
  }
  if (actions.length === 0) return null;

  const messageTs = readString(container?.message_ts);
  const firstAction = actions[0]!;
  const displayName = readString(user?.username);

  return {
    event: {
      channel: "slack",
      eventId,
      eventType: "card_action",
      accountId,
      chatId,
      ...(messageTs ? { platformMessageId: messageTs } : {}),
      sender: {
        platformUserId: userId,
        ...(displayName ? { displayName } : {}),
      },
      content: {
        actionId: firstAction.actionId,
        payload: {
          ...(typeof firstAction.value === "string" ? { envelope: firstAction.value } : {}),
        },
      },
      occurredAt: new Date().toISOString(),
    },
    actions,
    messageTs,
  };
}
