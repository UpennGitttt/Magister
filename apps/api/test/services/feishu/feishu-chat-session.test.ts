import { afterEach, beforeEach, expect, test } from "bun:test";

import type {
  FeishuClient,
  FeishuPatchCardElementInput,
} from "../../../src/integrations/feishu/feishu-client";
import {
  feishuChatSessionRegistry,
  FeishuChatSession,
} from "../../../src/services/feishu/feishu-chat-session";
import { taskEventBus } from "../../../src/sse/task-event-bus";
import { __resetQueueForTests } from "../../../src/integrations/feishu/sequential-queue";

beforeEach(() => {
  feishuChatSessionRegistry.__resetForTests();
  __resetQueueForTests();
});

afterEach(() => {
  feishuChatSessionRegistry.__resetForTests();
  __resetQueueForTests();
});

type MockClientState = {
  cardsCreated: number;
  patches: FeishuPatchCardElementInput[];
  sendCardRefs: number;
  textMessages: Array<{ chatId: string; text: string }>;
};

function makeMockClient(state: MockClientState): FeishuClient {
  return {
    async getTenantAccessToken() {
      return "tok";
    },
    async createCard() {
      state.cardsCreated += 1;
      return { cardId: `card-${state.cardsCreated}` };
    },
    async patchCardElement(input: FeishuPatchCardElementInput) {
      state.patches.push(input);
    },
    async patchCardSettings() {
      /* test stub */
    },
    async sendCardRef() {
      state.sendCardRefs += 1;
      return { messageId: `msg-${state.sendCardRefs}` };
    },
    // Stubs for the rest of the surface
    async sendTextMessage(input: { chatId: string; text: string }) {
      state.textMessages.push({ chatId: input.chatId, text: input.text });
      return { messageId: "stub" };
    },
    async replyTextMessage() {
      return { messageId: "stub" };
    },
    async addMessageReaction() {
      return { reactionId: "stub" };
    },
    async deleteMessageReaction() {
      /* noop */
    },
    async sendCardMessage() {
      return { messageId: "stub" };
    },
    async replyCardMessage() {
      return { messageId: "stub" };
    },
  } as unknown as FeishuClient;
}

test("first body PATCH uses sequence >= 2 (createCard reserves seq=1)", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-seq",
    taskId: "task-seq",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  taskEventBus.publish("task-seq", {
    type: "leader.stream_delta",
    requestId: "req-seq",
    data: { type: "text_delta", text: "hello" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 250));
  // The first patch must NOT use sequence=1 — Feishu's createCard
  // reserves that for the initial body it set up, and re-using it
  // triggers an "ErrMsg: sequence number compare failed" 400.
  expect(cs.patches.length).toBeGreaterThanOrEqual(1);
  expect(cs.patches[0]?.sequence).toBeGreaterThanOrEqual(2);
  await session.close();
});

test("concurrent text_delta events trigger only ONE createCard (lock works)", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-1",
    taskId: "task-1",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });

  // Fire 10 text_delta events in the same microtask — each triggers
  // ensureCard via its own handler. Without the lock this would create
  // 10 cards. (tool_call events no longer create the card — they emit
  // standalone chat messages instead, see 2026-05-18 refactor.)
  for (let i = 0; i < 10; i++) {
    taskEventBus.publish("task-1", {
      type: "leader.stream_delta",
      requestId: "req-1",
      data: { type: "text_delta", text: `chunk${i} ` },
      timestamp: new Date().toISOString(),
    });
  }
  // Wait for the lock + sequential queue to drain
  await new Promise((r) => setTimeout(r, 400));
  expect(cs.cardsCreated).toBe(1);
  expect(cs.sendCardRefs).toBe(1);
  // Close via terminal event instead of explicit close() — mock
  // doesn't drain the footer + settings PATCH cleanly when called
  // synchronously from the test path.
  taskEventBus.publish("task-1", {
    type: "task:completed",
    requestId: "req-1",
    data: {},
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(session.snapshot().closed).toBe(true);
});

test("session ignores events for verboseLevel:off", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-off",
    taskId: "task-off",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "off",
    client,
  });
  taskEventBus.publish("task-off", {
    type: "leader.tool_call",
    requestId: "req-off",
    data: { toolName: "bash", toolUseId: "tu" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 150));
  expect(cs.cardsCreated).toBe(0);
  await session.close();
});

test("terminal task:completed closes the card", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-term",
    taskId: "task-term",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  // Fire one event so card is created
  taskEventBus.publish("task-term", {
    type: "leader.stream_delta",
    requestId: "req-term",
    data: { type: "text_delta", text: "Hi" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(cs.cardsCreated).toBe(1);
  // Terminal event
  taskEventBus.publish("task-term", {
    type: "task:completed",
    requestId: "req-term",
    data: { reason: "completed" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(session.snapshot().closed).toBe(true);
});

test("registry start is idempotent per requestId", () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const a = feishuChatSessionRegistry.start({
    requestId: "req-id",
    taskId: "task-id",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  const b = feishuChatSessionRegistry.start({
    requestId: "req-id",
    taskId: "task-id",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  expect(a).toBe(b);
});

test("registry sessions for different requestIds are independent", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const a = feishuChatSessionRegistry.start({
    requestId: "req-A",
    taskId: "task-shared",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  const b = feishuChatSessionRegistry.start({
    requestId: "req-B",
    taskId: "task-shared",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  expect(a).not.toBe(b);
  await a.close();
  await b.close();
});

test("snapshot reflects state after events", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-snap",
    taskId: "task-snap",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  taskEventBus.publish("task-snap", {
    type: "leader.tool_call",
    requestId: "req-snap",
    data: { toolName: "bash", toolUseId: "t1", input: { command: "ls" } },
    timestamp: new Date().toISOString(),
  });
  taskEventBus.publish("task-snap", {
    type: "leader.stream_delta",
    requestId: "req-snap",
    data: { type: "text_delta", text: "hello" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 400));
  const snap = session.snapshot();
  expect(snap.toolCount).toBe(1);
  expect(snap.answerLength).toBe(5);
  // Close via terminal event instead of explicit close() to avoid
  // the footer patch + settings PATCH that mocks don't fully drain.
  taskEventBus.publish("task-snap", {
    type: "task:completed",
    requestId: "req-snap",
    data: {},
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(session.snapshot().closed).toBe(true);
});

test("tool_call patches the tools_body panel, NOT a standalone text message", async () => {
  // Single-card refactor (Task 6): tool activity now accumulates into
  // the collapsible panel's tools_body element instead of scattered
  // chat messages. tool_call creates the card eagerly (so the panel
  // exists) and PATCHes tools_body with a row carrying the inline args.
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-tc",
    taskId: "task-tc",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  taskEventBus.publish("task-tc", {
    type: "leader.tool_call",
    requestId: "req-tc",
    data: {
      toolName: "bash",
      toolUseId: "tu-1",
      input: { command: "ls -la /tmp" },
    },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 700));
  expect(cs.cardsCreated).toBe(1);
  expect(cs.textMessages.length).toBe(0); // no scattered tool messages
  const toolPatches = cs.patches.filter((p) => p.elementId === "tools_body");
  expect(toolPatches.length).toBeGreaterThanOrEqual(1);
  const body = (toolPatches[toolPatches.length - 1]?.partial as { content?: string })?.content ?? "";
  expect(body).toContain("bash");
  expect(body).toContain("ls -la /tmp");
  await session.close();
});

test("tool_result backfills a result sub-line into the panel when verbose=high", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-tr",
    taskId: "task-tr",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  // tool_call first so there's a row to backfill the result onto.
  taskEventBus.publish("task-tr", {
    type: "leader.tool_call",
    requestId: "req-tr",
    data: { toolName: "bash", toolUseId: "tu-1", input: { command: "ls" } },
    timestamp: new Date().toISOString(),
  });
  taskEventBus.publish("task-tr", {
    type: "leader.tool_result",
    requestId: "req-tr",
    data: {
      toolName: "bash",
      toolUseId: "tu-1",
      outputSummary: "exit 0\ntotal 12\ndrwx ...",
    },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 700));
  expect(cs.textMessages.length).toBe(0);
  const toolPatches = cs.patches.filter((p) => p.elementId === "tools_body");
  const body = (toolPatches[toolPatches.length - 1]?.partial as { content?: string })?.content ?? "";
  expect(body).toContain("↳");
  await session.close();
});

test("message_complete does NOT close the card (multi-turn leader runs)", async () => {
  // Regression for 2026-05-18 truncation bug: leader emits a
  // message_complete after each assistant message (per-turn). Closing
  // on it stopped text_delta accumulation after turn 1, so Feishu saw
  // only the first turn's text. The fix: only close on task-level
  // terminals (task:completed / task:failed / task:cancelled).
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-multi",
    taskId: "task-multi",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "high",
    client,
  });
  // Turn 1
  taskEventBus.publish("task-multi", {
    type: "leader.stream_delta",
    requestId: "req-multi",
    data: { type: "text_delta", text: "turn1 " },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 150));
  // Per-turn event — must NOT close
  taskEventBus.publish("task-multi", {
    type: "message_complete",
    requestId: "req-multi",
    data: {},
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 50));
  expect(session.snapshot().closed).toBe(false);
  // Turn 2
  taskEventBus.publish("task-multi", {
    type: "leader.stream_delta",
    requestId: "req-multi",
    data: { type: "text_delta", text: "turn2 " },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 200));
  expect(session.snapshot().answerLength).toBe("turn1 turn2 ".length);
  // Task-level terminal — must close
  taskEventBus.publish("task-multi", {
    type: "task:completed",
    requestId: "req-multi",
    data: {},
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 300));
  expect(session.snapshot().closed).toBe(true);
});

test("tool_result sub-line suppressed in the panel when verbose=low", async () => {
  const cs: MockClientState = { cardsCreated: 0, patches: [], sendCardRefs: 0, textMessages: [] };
  const client = makeMockClient(cs);
  const session = new FeishuChatSession({
    requestId: "req-low",
    taskId: "task-low",
    bindingId: "binding-1",
    chatId: "chat-1",
    verboseLevel: "low",
    client,
  });
  taskEventBus.publish("task-low", {
    type: "leader.tool_call",
    requestId: "req-low",
    data: { toolName: "bash", toolUseId: "tu", input: { command: "echo hi" } },
    timestamp: new Date().toISOString(),
  });
  taskEventBus.publish("task-low", {
    type: "leader.tool_result",
    requestId: "req-low",
    data: { toolName: "bash", toolUseId: "tu", outputSummary: "hi" },
    timestamp: new Date().toISOString(),
  });
  await new Promise((r) => setTimeout(r, 700));
  // No scattered text messages at all. The tool row shows the call;
  // the result sub-line (↳) only appears at verbose=high.
  expect(cs.textMessages.length).toBe(0);
  const toolPatches = cs.patches.filter((p) => p.elementId === "tools_body");
  expect(toolPatches.length).toBeGreaterThanOrEqual(1);
  const body = (toolPatches[toolPatches.length - 1]?.partial as { content?: string })?.content ?? "";
  expect(body).toContain("bash");
  expect(body).not.toContain("↳");
  await session.close();
});
