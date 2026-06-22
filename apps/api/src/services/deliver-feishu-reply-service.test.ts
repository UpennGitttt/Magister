/**
 * Task 9 — fallback convergence to a single plain-text reply.
 *
 * When the CardKit single-card flow could NOT deliver (createCard failed →
 * hasDeliveredCardFor returns false), the system must still reach the user
 * with exactly ONE plain-text message carrying the final answer, never a
 * notification card and never scattered/multiple messages.
 */
import { describe, expect, it } from "bun:test";

import { deliverLeaderAnswerToFeishu } from "./deliver-feishu-reply-service";
import type { FeishuClient } from "../integrations/feishu/feishu-client";

type CallRecord =
  | { kind: "sendText"; chatId: string; text: string }
  | { kind: "replyText"; messageId: string; text: string }
  | { kind: "sendCard"; chatId: string }
  | { kind: "replyCard"; messageId: string };

function fakeClient(): { calls: CallRecord[]; client: FeishuClient } {
  const calls: CallRecord[] = [];
  const client = {
    async sendTextMessage(input: { chatId: string; text: string }) {
      calls.push({ kind: "sendText", chatId: input.chatId, text: input.text });
      return { messageId: "msg1" };
    },
    async replyTextMessage(input: { messageId: string; text: string }) {
      calls.push({ kind: "replyText", messageId: input.messageId, text: input.text });
      return { messageId: "msg2" };
    },
    async sendCardMessage(input: { chatId: string; card: unknown }) {
      calls.push({ kind: "sendCard", chatId: input.chatId });
      return { messageId: "msg3" };
    },
    async replyCardMessage(input: { messageId: string; card: unknown }) {
      calls.push({ kind: "replyCard", messageId: input.messageId });
      return { messageId: "msg4" };
    },
  } as unknown as FeishuClient;
  return { calls, client };
}

describe("deliverLeaderAnswerToFeishu — plain-text fallback (Task 9)", () => {
  it("sends exactly ONE sendTextMessage with the answer (no card) when card creation failed", async () => {
    const { calls, client } = fakeClient();
    await deliverLeaderAnswerToFeishu({
      bindingId: "b1",
      workspaceId: "ws1",
      taskId: "task1",
      answer: "Here is the result",
      chatId: "chat1",
      client,
    });

    const textCalls = calls.filter((c) => c.kind === "sendText");
    const cardCalls = calls.filter((c) => c.kind === "sendCard" || c.kind === "replyCard");

    // Exactly one plain-text delivery — never a card, never scattered
    expect(textCalls.length).toBe(1);
    expect(cardCalls.length).toBe(0);

    // Answer content is present in the message text
    const [firstText] = textCalls as Extract<CallRecord, { kind: "sendText" }>[];
    expect(firstText!.text).toContain("Here is the result");
    expect(firstText!.chatId).toBe("chat1");
  });

  it("includes the web deep-link as a trailing line in the plain-text message", async () => {
    const { calls, client } = fakeClient();
    await deliverLeaderAnswerToFeishu({
      bindingId: "b1",
      workspaceId: "ws-abc",
      taskId: "task-xyz",
      answer: "Done",
      chatId: "chat1",
      client,
    });

    const textCalls = calls.filter((c) => c.kind === "sendText") as Extract<CallRecord, { kind: "sendText" }>[];
    expect(textCalls.length).toBe(1);
    // Deep-link must reference the task so the user can navigate
    expect(textCalls[0]!.text).toContain("task-xyz");
  });

  it("uses replyTextMessage when replyToMessageId is provided", async () => {
    const { calls, client } = fakeClient();
    await deliverLeaderAnswerToFeishu({
      bindingId: "b1",
      workspaceId: "ws1",
      taskId: "task1",
      answer: "Reply here",
      chatId: "chat1",
      replyToMessageId: "original-msg",
      client,
    });

    const replyCalls = calls.filter((c) => c.kind === "replyText") as Extract<CallRecord, { kind: "replyText" }>[];
    const textCalls = calls.filter((c) => c.kind === "sendText");
    const cardCalls = calls.filter((c) => c.kind === "sendCard" || c.kind === "replyCard");

    // Replies via replyText, not sendCard/sendText
    expect(replyCalls.length).toBe(1);
    expect(replyCalls[0]!.messageId).toBe("original-msg");
    expect(replyCalls[0]!.text).toContain("Reply here");
    expect(cardCalls.length).toBe(0);
    expect(textCalls.length).toBe(0);
  });

  it("falls back to sendTextMessage when replyTextMessage fails (withdrawn message)", async () => {
    const calls: CallRecord[] = [];
    const client = {
      async sendTextMessage(input: { chatId: string; text: string }) {
        calls.push({ kind: "sendText", chatId: input.chatId, text: input.text });
        return { messageId: "msg1" };
      },
      async replyTextMessage(_input: { messageId: string; text: string }) {
        throw new Error("message withdrawn");
      },
      async sendCardMessage(input: { chatId: string; card: unknown }) {
        calls.push({ kind: "sendCard", chatId: input.chatId });
        return { messageId: "msg3" };
      },
      async replyCardMessage(input: { messageId: string; card: unknown }) {
        calls.push({ kind: "replyCard", messageId: input.messageId });
        return { messageId: "msg4" };
      },
    } as unknown as FeishuClient;

    await deliverLeaderAnswerToFeishu({
      bindingId: "b1",
      workspaceId: "ws1",
      taskId: "task1",
      answer: "The answer",
      chatId: "chat1",
      replyToMessageId: "withdrawn-msg",
      client,
    });

    const textCalls = calls.filter((c) => c.kind === "sendText");
    const cardCalls = calls.filter((c) => c.kind === "sendCard" || c.kind === "replyCard");

    // Falls back to direct text send — still exactly one delivery
    expect(textCalls.length).toBe(1);
    expect(cardCalls.length).toBe(0);
    expect((textCalls[0] as Extract<CallRecord, { kind: "sendText" }>).text).toContain("The answer");
  });

  it("skips delivery for empty answer", async () => {
    const { calls, client } = fakeClient();
    await deliverLeaderAnswerToFeishu({
      bindingId: "b1",
      workspaceId: "ws1",
      taskId: "task1",
      answer: "   ",
      chatId: "chat1",
      client,
    });
    expect(calls.length).toBe(0);
  });
});
