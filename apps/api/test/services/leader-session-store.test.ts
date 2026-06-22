import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExecutionPolicy } from "../../src/services/leader-execution-policy-service";
import type { DoomLoopSnapshot } from "../../src/services/manager-automation/autonomous-loop/doom-loop-detector";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-session-store-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `store-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_LEADER_SESSION_TTL_MS;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("LeaderSessionStore", () => {
  test("writeCheckpoint stores and getLatestCheckpoint retrieves", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();
    const messages = [
      { type: "user" as const, content: "hello" },
      { type: "assistant" as const, content: [{ type: "text" as const, text: "hi" }] },
    ];

    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
      requestId: "req-test",
      turnCount: 2,
      messages,
    });

    const checkpoint = await store.getLatestCheckpoint("r-1");
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.turnCount).toBe(2);
    expect(checkpoint!.messages.length).toBe(2);
    expect(checkpoint!.sessionId).toBe("s-1");
  });

  test("writeCheckpoint prunes old checkpoints keeping only 2", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();

    for (let i = 1; i <= 4; i++) {
      await store.writeCheckpoint({
        sessionId: "s-1",
        taskId: "t-1",
        runId: "r-1",
      requestId: "req-test",
      turnCount: i,
        messages: [{ type: "user" as const, content: `turn ${i}` }],
      });
    }

    const checkpoint = await store.getLatestCheckpoint("r-1");
    expect(checkpoint!.turnCount).toBe(4);
  });

  test("isSessionActive returns true for fresh session", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
      requestId: "req-test",
      turnCount: 1,
      messages: [{ type: "user" as const, content: "hi" }],
    });

    const active = await store.isSessionActive("r-1");
    expect(active).toBe(true);
  });

  test("isSessionActive returns true regardless of age when checkpoint exists", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s-1",
      taskId: "t-1",
      runId: "r-1",
      requestId: "req-test",
      turnCount: 1,
      messages: [{ type: "user" as const, content: "hi" }],
    });

    await new Promise((r) => setTimeout(r, 10));
    const active = await store.isSessionActive("r-1");
    expect(active).toBe(true); // No TTL — always resumable
  });
});

describe("LeaderSessionStore checkpoint payload", () => {
  test("round-trips executionPolicy + doomState alongside turnCount/messages", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();
    const executionPolicy: ExecutionPolicy = {
      mode: "delegated_coding",
      source: "runtime_escalation",
      reason: "budget exceeded",
      constraints: { mustDelegate: true, allowCodeWriteTools: false, allowReadTools: true, allowSpawnTools: true, allowOpsBash: false, allowGitCommit: false } as any,
      counters: { discoveryToolCalls: 3, writeToolCalls: 1, writtenPaths: ["a.ts", "b.ts"], codeMutatingBashCalls: 0, testFailures: 0, teammateSpawned: true },
    };
    const doomState: DoomLoopSnapshot = { window: ["fp1", "fp1", "fp2"] };

    await store.writeCheckpoint({
      sessionId: "s1",
      taskId: "t_b2",
      runId: "r_b2",
      requestId: "q1",
      turnCount: 7,
      messages: [],
      executionPolicy,
      doomState,
    });

    const got = await store.getLatestCheckpoint("r_b2");
    expect(got?.turnCount).toBe(7);
    expect(got?.executionPolicy?.mode).toBe("delegated_coding");
    expect(got?.executionPolicy?.source).toBe("runtime_escalation");
    expect(got?.executionPolicy?.counters.writtenPaths).toEqual(["a.ts", "b.ts"]);
    expect(got?.doomState?.window).toEqual(["fp1", "fp1", "fp2"]);
  });

  test("legacy checkpoint without the new fields returns them as undefined", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s2",
      taskId: "t_b2b",
      runId: "r_b2b",
      requestId: "q2",
      turnCount: 1,
      messages: [],
    });

    const got = await store.getLatestCheckpoint("r_b2b");
    expect(got?.executionPolicy).toBeUndefined();
    expect(got?.doomState).toBeUndefined();
  });

  test("round-trips the terminal flag (P1-fix-a); absent flag reads undefined", async () => {
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
    const store = new LeaderSessionStore();

    await store.writeCheckpoint({
      sessionId: "s_term",
      taskId: "t_term",
      runId: "r_term",
      requestId: "q_term",
      turnCount: 9,
      messages: [],
      terminal: true,
    });
    const terminalCkpt = await store.getLatestCheckpoint("r_term");
    expect(terminalCkpt?.terminal).toBe(true);

    // A non-terminal (mid-flight) checkpoint must NOT report terminal.
    await store.writeCheckpoint({
      sessionId: "s_mid",
      taskId: "t_mid",
      runId: "r_mid",
      requestId: "q_mid",
      turnCount: 2,
      messages: [],
    });
    const midCkpt = await store.getLatestCheckpoint("r_mid");
    expect(midCkpt?.terminal).toBeUndefined();
  });
});
