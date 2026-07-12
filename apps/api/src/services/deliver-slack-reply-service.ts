import { buildSlackClientIfConfigured, type SlackClient } from "../integrations/slack/slack-client";
import { parseSlackConfig } from "../integrations/slack/slack-config";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";

// Slack chat.postMessage caps text at 40k chars; stay well under it so
// the message renders without Slack-side truncation surprises.
const SLACK_ANSWER_INLINE_CAP = 12000;

/**
 * Deliver the leader's final answer back to the Slack conversation the
 * task came from. Slack v1 has no streaming card — this single
 * postMessage IS the reply (the counterpart of Feishu's text fallback).
 * Best-effort: failures are recorded as observability events, never
 * thrown.
 */
export async function deliverLeaderAnswerToSlack(input: {
  bindingId: string;
  workspaceId: string;
  taskId: string;
  answer: string;
  chatId: string;
  /** Reply inside this thread (parent message ts) when set. */
  replyToMessageTs?: string;
  /** Injectable for tests; built from config when omitted. */
  client?: SlackClient;
}): Promise<void> {
  const answer = input.answer.trim();
  if (!answer) return;

  const client = input.client ?? buildSlackClientIfConfigured(parseSlackConfig().botToken);
  if (!client) return;

  const observability = new LocalObservabilityAdapter();
  const text =
    answer.length > SLACK_ANSWER_INLINE_CAP
      ? `${answer.slice(0, SLACK_ANSWER_INLINE_CAP)}…`
      : answer;

  let deliveredTs: string | undefined;
  try {
    const result = await client.postMessage({
      channel: input.chatId,
      text,
      ...(input.replyToMessageTs ? { threadTs: input.replyToMessageTs } : {}),
    });
    deliveredTs = result.ts;
  } catch {
    // Best-effort delivery — the failure event below is the record.
  }

  await observability.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: deliveredTs ? "channel.outbound.delivered" : "channel.outbound.delivery_failed",
    taskId: input.taskId,
    conversationBindingId: input.bindingId,
    workspaceId: input.workspaceId,
    severity: deliveredTs ? "info" : "warn",
    occurredAt: new Date(),
    payloadJson: JSON.stringify({
      channel: "slack",
      kind: "leader_answer_text",
      bindingId: input.bindingId,
      answerLength: input.answer.length,
      ...(deliveredTs ? { providerMessageId: deliveredTs } : {}),
    }),
  });
}
