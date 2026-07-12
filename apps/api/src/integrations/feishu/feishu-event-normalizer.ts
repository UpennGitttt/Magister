type FeishuContentFile = {
  fileId: string;
  name?: string;
  mimeType?: string;
};

export type FeishuMention = {
  key: string;
  id: { userId?: string; openId?: string; unionId?: string };
  name: string;
  tenantKey?: string;
};

// Shared across channel integrations — Slack events normalize into this
// same shape (see integrations/slack/slack-event-normalizer.ts).
export type InboundChannel = "feishu" | "slack";

export type InboundChannelEvent = {
  channel: InboundChannel;
  eventId: string;
  eventType: "message" | "card_action" | "reaction" | "file";
  accountId: string;
  chatId: string;
  threadId?: string;
  platformMessageId?: string;
  chatType?: "p2p" | "group";
  mentions?: FeishuMention[];
  sender: {
    platformUserId: string;
    displayName?: string;
  };
  content: {
    text?: string;
    actionId?: string;
    files?: FeishuContentFile[];
    payload?: Record<string, unknown>;
  };
  occurredAt: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringOrNumber(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function parseJsonObject(value: unknown) {
  if (typeof value !== "string") {
    return asRecord(value);
  }

  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function toOccurredAt(value: unknown) {
  const raw = readStringOrNumber(value);
  if (raw === undefined) {
    throw new Error("Feishu payload is missing an event timestamp");
  }

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return new Date(asNumber).toISOString();
  }

  const asDate = new Date(raw);
  if (Number.isNaN(asDate.getTime())) {
    throw new Error(`Unsupported Feishu timestamp: ${raw}`);
  }

  return asDate.toISOString();
}

function getSender(record: Record<string, unknown>) {
  const sender = asRecord(record.sender) ?? asRecord(record.operator);
  const senderId = asRecord(sender?.sender_id) ?? asRecord(sender?.operator_id);
  // The new card.action.trigger payload (v2 schema) puts `open_id`
  // directly on `operator` (no nested `operator_id` wrapper). Old
  // im.message.receive_v1 events still use the nested form. Try both
  // — and fall back to top-level `open_id` for the simplest synthetic
  // payloads (test fixtures, some webhook shapes).
  const platformUserId =
    readString(senderId?.open_id) ??
    readString(senderId?.user_id) ??
    readString(sender?.open_id) ??
    readString(sender?.user_id) ??
    readString(sender?.union_id) ??
    readString(record.open_id) ??
    readString(record.user_id);
  const displayName =
    readString(sender?.sender_name) ??
    readString(sender?.name) ??
    readString(record.user_name);

  if (!platformUserId) {
    throw new Error("Feishu payload is missing a sender id");
  }

  return {
    platformUserId,
    ...(displayName ? { displayName } : {}),
  };
}

function normalizeMessageEvent(payload: Record<string, unknown>): InboundChannelEvent {
  const header = asRecord(payload.header);
  const event = asRecord(payload.event);
  const message = asRecord(event?.message);
  const content = parseJsonObject(message?.content) ?? {};
  const messageType = readString(message?.message_type) ?? "text";
  const eventType = messageType === "file" ? "file" : "message";
  const fileId = readString(content.file_key);
  const fileName = readString(content.file_name);
  const fileMimeType = readString(content.mime_type);
  const files =
    eventType === "file" && fileId
      ? [
          {
            fileId,
            ...(fileName ? { name: fileName } : {}),
            ...(fileMimeType ? { mimeType: fileMimeType } : {}),
          },
        ]
      : undefined;

  const eventId = readString(header?.event_id);
  const accountId = readString(header?.tenant_key);
  const chatId = readString(message?.chat_id);
  const platformMessageId = readString(message?.message_id);
  // Text extraction per messageType. Previously this only read
  // `content.text` which exists for `text` type but is undefined for
  // `image`/`post`/`rich_text`/`audio` → those messages were silently
  // dropped as "empty_message_text". The new path tries the
  // type-specific field then falls back to text.
  //   post:  content.content is array-of-rows-of-elements; flatten and
  //          extract `text` element values.
  //   image: caption usually lives in content.text (rare) — leave as
  //          null if not present (we still hand the event to the bot
  //          with image marker so it can still spawn an empty task).
  //   audio/file: same — no text.
  let text = readString(content.text);
  if (!text && messageType === "post") {
    const post = content.content;
    if (Array.isArray(post)) {
      const flat: string[] = [];
      for (const row of post) {
        if (!Array.isArray(row)) continue;
        for (const el of row) {
          const rec = asRecord(el);
          if (rec && typeof rec.text === "string") flat.push(rec.text);
        }
      }
      if (flat.length > 0) text = flat.join(" ").trim();
    }
    const title = readString(content.title);
    if (title) text = text ? `${title}\n${text}` : title;
  }
  const chatType = readString(message?.chat_type);
  const rawEventType = readString(header?.event_type);
  const threadId = readString(message?.root_id) ?? readString(message?.parent_id);
  const rawMentions = Array.isArray(message?.mentions) ? (message.mentions as unknown[]) : [];
  const mentions: FeishuMention[] = rawMentions
    .map((m) => {
      const rec = asRecord(m);
      if (!rec) return null;
      const key = readString(rec.key);
      const name = readString(rec.name) ?? "";
      const idRec = asRecord(rec.id) ?? {};
      return key
        ? {
            key,
            id: {
              ...(readString(idRec.user_id) ? { userId: readString(idRec.user_id) } : {}),
              ...(readString(idRec.open_id) ? { openId: readString(idRec.open_id) } : {}),
              ...(readString(idRec.union_id) ? { unionId: readString(idRec.union_id) } : {}),
            },
            name,
            ...(readString(rec.tenant_key) ? { tenantKey: readString(rec.tenant_key) } : {}),
          }
        : null;
    })
    .filter((m): m is FeishuMention => m !== null);

  const normalizedContent: InboundChannelEvent["content"] = {
    ...(text ? { text } : {}),
    ...(files && files.length > 0 ? { files } : {}),
    payload: {
      messageType,
      ...(chatType ? { chatType } : {}),
      ...(rawEventType ? { rawEventType } : {}),
    },
  };

  if (!eventId || !accountId || !chatId) {
    throw new Error("Feishu message payload is missing required identity fields");
  }

  return {
    channel: "feishu",
    eventId,
    eventType,
    accountId,
    chatId,
    ...(threadId ? { threadId } : {}),
    ...(platformMessageId ? { platformMessageId } : {}),
    ...(chatType === "p2p" || chatType === "group" ? { chatType } : {}),
    ...(mentions.length > 0 ? { mentions } : {}),
    sender: getSender(event ?? {}),
    content: normalizedContent,
    occurredAt: toOccurredAt(message?.create_time ?? header?.create_time),
  };
}

function normalizeCardActionEvent(payload: Record<string, unknown>): InboundChannelEvent {
  // Card.action.trigger arrives in TWO different shapes depending on
  // the card schema:
  //   v1 (legacy "msg_type:interactive"): fields live at the top of
  //     payload (open_chat_id, event_id, tenant_key, action, ...).
  //   v2 (CardKit / schema:2.0): payload is wrapped in `event` with
  //     `header` siblings, and operator/chat fields live under
  //     `event.operator` / `event.context` etc.
  //
  // Try the v2 envelope first (wrapped form), fall back to v1
  // (flat form). The downstream code only cares about the
  // normalized output.
  const header = asRecord(payload.header);
  const wrapped = asRecord(payload.event);
  const source: Record<string, unknown> = wrapped ?? payload;

  const action = asRecord(source.action);
  const actionValue = asRecord(action?.value) ?? {};
  // event_id lives on `header` in v2, top-level in v1
  const eventId =
    readString(header?.event_id) ?? readString(payload.event_id) ?? readString(source.event_id);
  // tenant_key — same dual location
  const accountId =
    readString(header?.tenant_key) ??
    readString(source.tenant_key) ??
    readString(payload.tenant_key) ??
    readString(asRecord(source.operator)?.tenant_key);
  const context = asRecord(source.context);
  const chatId =
    readString(source.open_chat_id) ??
    readString(payload.open_chat_id) ??
    readString(context?.open_chat_id) ??
    readString(context?.chat_id);
  const platformMessageId =
    readString(source.open_message_id) ??
    readString(payload.open_message_id) ??
    readString(context?.open_message_id);
  const actionId = readString(actionValue.actionId) ?? readString(action?.tag);
  const normalizedContent: InboundChannelEvent["content"] = {
    ...(actionId ? { actionId } : {}),
    payload: {
      ...actionValue,
      ...(readString(action?.tag) ? { tag: readString(action?.tag) } : {}),
    },
  };

  if (!eventId || !accountId || !chatId) {
    // Surface a diagnostic dump so we can debug new payload shapes
    // without redacting in production logs (no secrets land here —
    // only public chat/event identifiers).
    // eslint-disable-next-line no-console
    console.warn(
      "[feishu-normalize] card_action missing identity:",
      JSON.stringify({ hasEventId: !!eventId, hasAccountId: !!accountId, hasChatId: !!chatId, payloadKeys: Object.keys(payload), sourceKeys: Object.keys(source) }),
    );
    throw new Error("Feishu card action payload is missing required identity fields");
  }

  return {
    channel: "feishu",
    eventId,
    eventType: "card_action",
    accountId,
    chatId,
    ...(platformMessageId ? { platformMessageId } : {}),
    sender: getSender(source),
    content: normalizedContent,
    // Real-world payload from Feishu's `card.action.trigger` event:
    // flat shape with `schema:"2.0"` at top, `create_time` (not
    // `action_time`!) as the timestamp. The `event` wrapper + `header`
    // sibling we assumed earlier is for OTHER event types. Try every
    // observed field name in priority order.
    occurredAt: toOccurredAt(
      source.action_time
        ?? payload.action_time
        ?? source.create_time
        ?? payload.create_time
        ?? header?.create_time,
    ),
  };
}

/**
 * Remove @mention placeholders (e.g. `@_user_1`) from message text.
 * Feishu embeds mentions as `@_user_N` tokens inside the text content.
 *
 * When `botOpenId` is provided, only mentions matching that open ID are
 * stripped — other user mentions are preserved in the text.  When omitted,
 * all mentions are stripped for backward compatibility.
 */
export function stripBotMention(
  text: string | null | undefined,
  mentions: InboundChannelEvent["mentions"],
  botOpenId?: string,
): string {
  if (!text || !mentions || mentions.length === 0) return text ?? "";
  let cleaned = text;
  for (const mention of mentions) {
    // Only strip bot's own mention, keep other user mentions
    if (botOpenId && mention.id?.openId !== botOpenId) continue;
    cleaned = cleaned.replaceAll(mention.key, "");
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

export function normalizeFeishuInboundEvent(payload: unknown): InboundChannelEvent {
  const record = asRecord(payload);
  if (!record) {
    throw new Error("Feishu payload must be an object");
  }

  const header = asRecord(record.header);
  const eventType = readString(header?.event_type);

  if (eventType === "im.message.receive_v1") {
    return normalizeMessageEvent(record);
  }

  if (asRecord(record.action)) {
    return normalizeCardActionEvent(record);
  }

  throw new Error("Unsupported Feishu inbound payload");
}
