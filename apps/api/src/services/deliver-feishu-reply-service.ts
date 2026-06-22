import { createHmac } from "node:crypto";

import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { createFeishuClient, type FeishuClient } from "../integrations/feishu/feishu-client";
import { enqueue, feishuChatKey } from "../integrations/feishu/sequential-queue";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";

/**
 * Deep-link token used by `serve-prod.ts:checkAuth` to auth Feishu
 * card button clicks without a Basic-Auth prompt (Feishu's in-app
 * browser ignores WWW-Authenticate). Token is derived from
 * `MAGISTER_WEB_AUTH_PASS` so it stays in lockstep with the web's
 * cookie auth — if the pass rotates, old card links stop working
 * (acceptable single-operator tradeoff). Returns empty string when
 * auth isn't configured (open access), in which case URLs go out
 * without the `?k=` param.
 */
function buildDeepLinkToken(): string {
  const pass = process.env.MAGISTER_WEB_AUTH_PASS?.trim();
  if (!pass) return "";
  return createHmac("sha256", pass).update("magister_card_link").digest("hex").slice(0, 24);
}

function buildAuthedUrl(baseUrl: string, path: string): string {
  const token = buildDeepLinkToken();
  if (!token) return `${baseUrl}${path}`;
  const sep = path.includes("?") ? "&" : "?";
  return `${baseUrl}${path}${sep}k=${token}`;
}

/**
 * Sanitize text for embedding in a Feishu `lark_md` block.
 *
 * lark_md supports a markdown subset (bold `**`, italic `*`, inline
 * code `` ` ``, fenced code ``` ``` ```, links `[text](url)`, `<at>`
 * mentions, `<font>` color spans, `\n` newlines). It does NOT render
 * markdown headers (`# Heading`).
 *
 * Behavior:
 *   - Keep `*`, `\`, `` ` ``, and fenced code blocks UNTOUCHED so
 *     deliberate markdown (including code fences) renders correctly.
 *   - Strip Feishu-specific control sequences (`<at>` / `<font>`) so
 *     model output containing these isn't interpreted as mentions or
 *     colors.
 *   - Convert ATX headers (`# H`) to bold-on-own-line as the closest
 *     lark_md approximation.
 *   - Keep `@` UNESCAPED (callers handle their own mention safety).
 */
function convertMarkdownToLarkMd(text: string): string {
  // lark_md supports triple-backtick fenced blocks natively — leave
  // them alone. Only sanitize HTML-ish tags that lark_md would
  // interpret as control sequences (<at>, <font>).
  let out = text;
  out = out.replace(/<at\s[^>]*\/?>/gi, "");
  out = out.replace(/<\/?at>/gi, "");
  out = out.replace(/<font\s[^>]*>/gi, "");
  out = out.replace(/<\/font>/gi, "");
  // Headers → bold-on-own-line. lark_md doesn't render # headers,
  // so this is the closest approximation. ATX style only; setext
  // (`====` underline) is uncommon enough to skip.
  out = out.replace(/^#{1,6}\s+(.+)$/gm, (_m, body) => `**${body}**`);
  return out;
}

// Back-compat alias — keep the old name so existing callers compile;
// the body now passes through the smarter converter.
function escapeLarkMd(text: string): string {
  return convertMarkdownToLarkMd(text);
}

function resolveWebBaseUrl(): string {
  const configured = process.env.MAGISTER_WEB_BASE_URL?.trim();
  if (!configured) {
    return "http://localhost:3701";
  }
  return configured.replace(/\/+$/, "");
}

function buildNotificationCard(input: {
  title: string;
  body: string;
  buttonText: string;
  buttonUrl: string;
  template?: string;
}): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: input.title },
      template: input.template ?? "blue",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: input.body,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: input.buttonText,
            },
            type: "primary",
            url: input.buttonUrl,
          },
        ],
      },
    ],
  };
}

function buildPreview(text: string, maxLength = 200): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}...`;
}

export async function deliverLeaderAnswerToFeishu(input: {
  bindingId: string;
  workspaceId: string;
  taskId: string;
  answer: string;
  chatId: string;
  replyToMessageId?: string;
  /**
   * Optional pre-built client for injection in tests (and for callers
   * that already hold a client, avoiding a redundant env parse). When
   * omitted the function creates one from env as before.
   */
  client?: FeishuClient;
}): Promise<void> {
  if (!input.answer.trim()) return;

  const config = parseFeishuConfigFromEnv();
  // App creds are only needed to BUILD a client from env. When the caller
  // injects a client (tests, or callers that already hold one), the env
  // requirement doesn't apply — otherwise this early-return makes the
  // function silently no-op under any test ordering that cleared the
  // MAGISTER_FEISHU_* env vars.
  if (!input.client && (!config.appId || !config.appSecret)) return;

  const observability = new LocalObservabilityAdapter();
  const client =
    input.client
    ?? createFeishuClient({ appId: config.appId!, appSecret: config.appSecret! });
  const baseUrl = resolveWebBaseUrl();

  // Task 9: CardKit single-card flow failed (createCard never set
  // hasDeliveredCardFor) — deliver the answer as ONE clean plain-text
  // message, never a scattered card, never a notification card.
  // Plain-text can carry the full answer without the ~30 KB card body
  // cap worry, and it works even when the CardKit API is degraded.
  const FEISHU_ANSWER_INLINE_CAP = 8000;
  const preview = buildPreview(input.answer, FEISHU_ANSWER_INLINE_CAP);
  const wasTruncated = input.answer.trim().length > FEISHU_ANSWER_INLINE_CAP;

  // Compose message: answer (possibly truncated) + deep-link footer.
  const deepLink = buildAuthedUrl(baseUrl, `/w/${input.workspaceId}/sessions/${input.taskId}`);
  const linkLine = wasTruncated
    ? `\n\n[查看完整回答 →](${deepLink})`
    : `\n\n[在 Web 中打开 →](${deepLink})`;
  const messageText = preview + linkLine;

  let deliveredCount = 0;

  try {
    // Per-chat queue routing — same lane as streaming-card content
    // PATCHes so this fallback message doesn't overtake an in-flight
    // card PATCH (Feishu rejects out-of-order for the same chat).
    if (input.replyToMessageId) {
      await enqueue(feishuChatKey(input.bindingId), () =>
        client.replyTextMessage({
          messageId: input.replyToMessageId!,
          text: messageText,
        }),
      );
    } else {
      await enqueue(feishuChatKey(input.bindingId), () =>
        client.sendTextMessage({ chatId: input.chatId, text: messageText }),
      );
    }
    deliveredCount = 1;
  } catch {
    // If reply fails (e.g. original message withdrawn), fall back to
    // direct send — still exactly one message, never multiple.
    try {
      await enqueue(feishuChatKey(input.bindingId), () =>
        client.sendTextMessage({ chatId: input.chatId, text: messageText }),
      );
      deliveredCount = 1;
    } catch {
      // Best-effort delivery — swallow failures.
    }
  }

  await observability.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: deliveredCount > 0 ? "channel.outbound.delivered" : "channel.outbound.delivery_failed",
    taskId: input.taskId,
    conversationBindingId: input.bindingId,
    workspaceId: input.workspaceId,
    severity: deliveredCount > 0 ? "info" : "warn",
    occurredAt: new Date(),
    payloadJson: JSON.stringify({
      channel: "feishu",
      kind: "leader_answer_text_fallback",
      bindingId: input.bindingId,
      answerLength: input.answer.length,
      chunks: 1,
      previewLength: preview.length,
      deliveredCount,
    }),
  });
}
