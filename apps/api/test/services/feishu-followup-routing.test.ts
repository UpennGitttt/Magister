import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-followup-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `followup-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_LEADER_SESSION_TTL_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("follow-up routing", () => {
  test("checkpoint is written for completed 1-turn tasks", async () => {
    const { LeaderSessionStore } = await import(
      "../../src/services/leader-session-store"
    );
    const store = new LeaderSessionStore();

    // Simulate what the leader loop should do on completion
    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
    requestId: "req-fixture",
    turnCount: 1,
      messages: [
        { type: "user" as const, content: "What time is it?" },
        {
          type: "assistant" as const,
          content: [{ type: "text" as const, text: "It is 3pm" }],
        },
      ],
    });

    const checkpoint = await store.getLatestCheckpoint("r-1");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.messages.length).toBe(2);
    expect(checkpoint!.turnCount).toBe(1);
  });

  test("getActiveLeaderSession returns correct data after recordLeaderSession", async () => {
    const { ChannelSessionService } = await import(
      "../../src/services/channel-session-service"
    );
    const svc = new ChannelSessionService();

    await svc.ensureForBinding({
      bindingId: "feishu:acc:chat1",
      channel: "feishu",
      workspaceId: "ws-1",
    });

    await svc.recordLeaderSession({
      bindingId: "feishu:acc:chat1",
      currentLeaderSessionId: "run-leader-1",
      currentTaskId: "task-1",
    });

    const active = await svc.getActiveLeaderSession("feishu:acc:chat1");
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe("run-leader-1");
    expect(active!.taskId).toBe("task-1");
  });

  test("isSessionActive returns true for fresh session", async () => {
    const { LeaderSessionStore } = await import(
      "../../src/services/leader-session-store"
    );
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
    requestId: "req-fixture",
    turnCount: 1,
      messages: [{ type: "user" as const, content: "hello" }],
    });

    const active = await store.isSessionActive("r-1");
    expect(active).toBe(true);
  });

  test("isSessionActive returns true regardless of age", async () => {
    const { LeaderSessionStore } = await import(
      "../../src/services/leader-session-store"
    );
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
    requestId: "req-fixture",
    turnCount: 1,
      messages: [{ type: "user" as const, content: "hello" }],
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    const active = await store.isSessionActive("r-1");
    expect(active).toBe(true); // No TTL — always resumable
  });

  test("full follow-up chain: session + checkpoint enables resume path", async () => {
    const { ChannelSessionService } = await import(
      "../../src/services/channel-session-service"
    );
    const { LeaderSessionStore } = await import(
      "../../src/services/leader-session-store"
    );
    const channelSvc = new ChannelSessionService();
    const sessionStore = new LeaderSessionStore();

    const bindingId = "feishu:acc:chat_followup";
    const runId = "rt_leader_followup_1";
    const taskId = "task_followup_1";

    // Step 1: First message creates channel session + leader session
    await channelSvc.ensureForBinding({
      bindingId,
      channel: "feishu",
      workspaceId: "ws-1",
    });
    await channelSvc.recordLeaderSession({
      bindingId,
      currentLeaderSessionId: runId,
      currentTaskId: taskId,
    });

    // Step 2: Leader loop completes and writes checkpoint (the bug fix)
    await sessionStore.writeCheckpoint({
      sessionId: runId,
      taskId,
      runId,
      requestId: "req-fixture",
      turnCount: 1,
      messages: [
        { type: "user" as const, content: "今天天气如何" },
        {
          type: "assistant" as const,
          content: [
            {
              type: "text" as const,
              text: "今天天气晴朗，气温约25度。请问您想了解哪个城市的天气？",
            },
          ],
        },
      ],
    });

    // Step 3: Follow-up message arrives — verify resume path works
    const activeSession = await channelSvc.getActiveLeaderSession(bindingId);
    expect(activeSession).not.toBeNull();
    expect(activeSession!.sessionId).toBe(runId);

    const isActive = await sessionStore.isSessionActive(activeSession!.sessionId);
    expect(isActive).toBe(true);

    const checkpoint = await sessionStore.getLatestCheckpoint(activeSession!.sessionId);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.messages.length).toBe(2);

    // The restored messages would be passed to executeLeaderLoop with the new prompt
    const restoredMessages = checkpoint!.messages;
    const followUpPrompt = "成都";
    const followUpMessage = { type: "user" as const, content: followUpPrompt };
    const messagesForNextLoop = [...restoredMessages, followUpMessage];
    expect(messagesForNextLoop.length).toBe(3);
    const lastMsg = messagesForNextLoop[2];
    expect(lastMsg).toBeDefined();
    expect(lastMsg!.type).toBe("user");
    expect((lastMsg as { type: "user"; content: string }).content).toBe("成都");
  });
});
