import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  __testing,
  autocompact,
  extractPreviousSummary,
  getPreserveTailBudget,
} from "../../src/services/manager-automation/autonomous-loop/message-compaction";
import type {
  LeaderAssistantMessage,
  LeaderMessage,
  LeaderModelCallParams,
} from "../../src/services/manager-automation/autonomous-loop/autonomous-types";

// Spec discussion: docs/specs/2026-04-29-todowrite-and-parallel-subagents-spec.md +
// session conversation 2026-04-29 (PR1 + PR2 compaction overhaul).
// These tests pin the new contracts so a future refactor can't
// silently regress: structured prompt, token-budget tail, prev-summary
// anchor, failure→`failed: true` flag, durable-state Session Progress.

function makeFakeModel(text: string) {
  return async function* (
    _params: LeaderModelCallParams,
  ): AsyncGenerator<LeaderAssistantMessage> {
    yield {
      type: "assistant",
      content: [{ type: "text", text }],
    };
  };
}

function makeFailingModel() {
  return async function* (
    _params: LeaderModelCallParams,
  ): AsyncGenerator<LeaderAssistantMessage> {
    throw new Error("provider 400 — simulated");
    yield { type: "assistant", content: [] }; // unreachable; satisfies generator typing
  };
}

function buildTurns(count: number): LeaderMessage[] {
  const out: LeaderMessage[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({ type: "user", content: `turn ${i} user msg with some content for tokens` });
    out.push({
      type: "assistant",
      content: [{ type: "text", text: `assistant response for turn ${i} with sufficient text for token bookkeeping` }],
    });
  }
  return out;
}

describe("SUMMARY_TEMPLATE structure", () => {
  test("template enforces all required sections in order", () => {
    const tpl = __testing.SUMMARY_TEMPLATE;
    const order = [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "### Done",
      "### In Progress",
      "### Blocked",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
      "## Relevant Files",
    ];
    let prev = -1;
    for (const section of order) {
      const idx = tpl.indexOf(section);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  test("template instructs model to keep empty sections, not skip them", () => {
    expect(__testing.SUMMARY_TEMPLATE).toContain("Keep every section, even when empty.");
  });
});

describe("extractPreviousSummary", () => {
  test("returns null when head isn't a previous-summary anchor", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "hello" },
      { type: "assistant", content: [{ type: "text", text: "hi" }] },
    ];
    const r = extractPreviousSummary(messages);
    expect(r.previousSummary).toBeNull();
    expect(r.rest).toEqual(messages);
  });

  test("strips the anchor and returns its body when present", () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "[Previous conversation summary]\n## Goal\n- do thing", isMeta: true },
      { type: "user", content: "follow-up" },
      { type: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    const r = extractPreviousSummary(messages);
    expect(r.previousSummary).toBe("## Goal\n- do thing");
    expect(r.rest.length).toBe(2);
    expect(r.rest[0]!.type).toBe("user");
  });

  test("ignores a non-meta user message that happens to start the same way", () => {
    // A pasted user input that includes the literal marker text
    // shouldn't be treated as an anchor — it must be `isMeta: true`.
    const messages: LeaderMessage[] = [
      { type: "user", content: "[Previous conversation summary] is something the user typed" },
    ];
    const r = extractPreviousSummary(messages);
    expect(r.previousSummary).toBeNull();
  });
});

describe("autocompact previous-summary anchor", () => {
  test("passes <previous-summary> to the LLM rather than re-summarizing the anchor", async () => {
    const messages: LeaderMessage[] = [
      { type: "user", content: "[Previous conversation summary]\nold summary", isMeta: true },
      ...buildTurns(5),
    ];

    let capturedPrompt = "";
    async function* captureModel(
      params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      let lastUserContent: string | undefined;
      for (let i = params.messages.length - 1; i >= 0; i--) {
        const msg = params.messages[i]!;
        if (msg.type === "user" && typeof msg.content === "string") {
          lastUserContent = msg.content;
          break;
        }
      }
      if (lastUserContent !== undefined) capturedPrompt = lastUserContent;
      yield {
        type: "assistant",
        content: [{ type: "text", text: "## Goal\n- new goal\n## Next Steps\n- next" }],
      };
    }

    const result = await autocompact(messages, captureModel, "sys", { preserveTailTokens: 30 });
    expect(result.compacted).toBe(true);
    expect(capturedPrompt).toContain("<previous-summary>");
    expect(capturedPrompt).toContain("old summary");
    expect(capturedPrompt).toContain("Update the anchored summary");
  });

  test("uses 'Create a new anchored summary' phrasing on first compaction", async () => {
    const messages = buildTurns(5);

    let capturedPrompt = "";
    async function* captureModel(
      params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      let lastUserContent: string | undefined;
      for (let i = params.messages.length - 1; i >= 0; i--) {
        const msg = params.messages[i]!;
        if (msg.type === "user" && typeof msg.content === "string") {
          lastUserContent = msg.content;
          break;
        }
      }
      if (lastUserContent !== undefined) capturedPrompt = lastUserContent;
      yield { type: "assistant", content: [{ type: "text", text: "## Goal\n- x" }] };
    }

    const r = await autocompact(messages, captureModel, "sys", { preserveTailTokens: 30 });
    expect(r.compacted).toBe(true);
    expect(capturedPrompt).toContain("Create a new anchored summary");
    expect(capturedPrompt).not.toContain("<previous-summary>");
  });
});

describe("autocompact return shape", () => {
  test("on success: compacted, summaryText, preservedTailTokens, tailStartMessageIdx populated", async () => {
    const messages = buildTurns(6);
    const result = await autocompact(
      messages,
      makeFakeModel("## Goal\n- summary"),
      "sys",
      { preserveTailTokens: 30 },
    );
    expect(result.compacted).toBe(true);
    expect(result.summaryText).toContain("Goal");
    expect(typeof result.preservedTailTokens).toBe("number");
    expect(result.preservedTailTokens).toBeGreaterThan(0);
    expect(typeof result.tailStartMessageIdx).toBe("number");
    expect(result.tailStartMessageIdx).toBeGreaterThan(0);
  });

  test("on LLM throw: compacted=false, failed=true, original messages preserved", async () => {
    const messages = buildTurns(6);
    const result = await autocompact(messages, makeFailingModel(), "sys", { preserveTailTokens: 30 });
    expect(result.compacted).toBe(false);
    expect(result.failed).toBe(true);
    expect(result.messages.length).toBe(messages.length);
  });

  test("on empty LLM response: compacted=false, failed=true (don't replace history with nothing)", async () => {
    const messages = buildTurns(6);
    const result = await autocompact(messages, makeFakeModel("   "), "sys", { preserveTailTokens: 30 });
    expect(result.compacted).toBe(false);
    expect(result.failed).toBe(true);
  });

  test("when only one turn exists: compacted=false, failed=undefined (no work, not a failure)", async () => {
    const messages = buildTurns(1);
    const result = await autocompact(
      messages,
      makeFakeModel("won't be called"),
      "sys",
      { preserveTailTokens: 30 },
    );
    expect(result.compacted).toBe(false);
    expect(result.failed).toBeUndefined();
  });
});

describe("getPreserveTailBudget", () => {
  const ORIG = process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS;

  beforeEach(() => {
    delete process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS;
  });
  afterEach(() => {
    if (ORIG === undefined) delete process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS;
    else process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS = ORIG;
  });

  test("default 30% of availableForInput, clamped to [2k, 30k]", () => {
    // 222k input budget → 30% = 66.6k → clamped to 30k ceiling.
    expect(getPreserveTailBudget(222_000)).toBe(30_000);
    // 50k → 30% = 15k, in range.
    expect(getPreserveTailBudget(50_000)).toBe(15_000);
    // 5k → 30% = 1.5k, hits 2k floor.
    expect(getPreserveTailBudget(5_000)).toBe(2_000);
  });

  test("env override (absolute) wins, also clamped to [2k, 30k]", () => {
    process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS = "100000";
    expect(getPreserveTailBudget(50_000)).toBe(30_000); // clamp ceiling
    process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS = "500";
    expect(getPreserveTailBudget(50_000)).toBe(2_000); // clamp floor
    process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS = "8000";
    expect(getPreserveTailBudget(50_000)).toBe(8_000); // honored
  });

  test("invalid env value falls back to default ratio", () => {
    process.env.MAGISTER_LEADER_PRESERVE_TAIL_TOKENS = "garbage";
    expect(getPreserveTailBudget(50_000)).toBe(15_000);
  });
});

describe("buildProgressArtifactFromState (PR2)", () => {
  // Use the durable-state version against a fresh test DB to verify
  // it surfaces real plan / teammates / approvals / artifacts rather
  // than just scanning the message stream.

  const tempRoot = join(process.cwd(), ".tmp-progress-rehydration-test");

  beforeEach(() => {
    mkdirSync(tempRoot, { recursive: true });
    process.env.MAGISTER_DB_PATH = join(
      tempRoot,
      `progress-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );
  });

  afterEach(() => {
    delete process.env.MAGISTER_DB_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("falls back to baseline when no durable state exists", async () => {
    const { buildProgressArtifactFromState } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );
    const messages: LeaderMessage[] = [
      { type: "user", content: "hi" },
      { type: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    const r = await buildProgressArtifactFromState(messages, {
      taskId: "task_empty",
      runId: "run_empty",
    });
    expect(r.plan).toBeUndefined();
    expect(r.activeTeammates).toBeUndefined();
    expect(r.pendingApprovals).toBeUndefined();
    expect(r.recentArtifacts).toBeUndefined();
    // baseline still populated
    expect(r.turnCount).toBe(1);
  });

  test("surfaces latest update_plan from execution_events", async () => {
    const { ExecutionEventRepository } = await import(
      "../../src/repositories/execution-event-repository"
    );
    const { buildProgressArtifactFromState } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );

    const repo = new ExecutionEventRepository();
    // Older plan call — should be ignored in favor of the newer one.
    await repo.create({
      id: "evt_plan_old",
      type: "leader.tool_call",
      taskId: "task_p",
      requestId: "req_p",
      occurredAt: new Date(Date.now() - 60_000),
      payloadJson: JSON.stringify({
        toolName: "update_plan",
        input: {
          todos: [
            { content: "OLD A", activeForm: "Doing OLD A", status: "in_progress" },
          ],
        },
      }),
    });
    await repo.create({
      id: "evt_plan_new",
      type: "leader.tool_call",
      taskId: "task_p",
      requestId: "req_p",
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        toolName: "update_plan",
        input: {
          todos: [
            { content: "Do A", activeForm: "Doing A", status: "completed" },
            { content: "Do B", activeForm: "Doing B", status: "in_progress" },
          ],
        },
      }),
    });

    const r = await buildProgressArtifactFromState([], { taskId: "task_p", runId: "run_p" });
    expect(r.plan).toBeDefined();
    expect(r.plan!.length).toBe(2);
    expect(r.plan![0]!.content).toBe("Do A");
    expect(r.plan![0]!.status).toBe("completed");
    expect(r.plan![1]!.content).toBe("Do B");
  });

  test("surfaces active teammate role_runtimes belonging to this run", async () => {
    const { RoleRuntimeRepository } = await import(
      "../../src/repositories/role-runtime-repository"
    );
    const { buildProgressArtifactFromState } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );

    const repo = new RoleRuntimeRepository();
    await repo.create({
      id: "rt_active",
      taskId: "task_t",
      roleId: "coder",
      state: "RUNNING",
      parentRunId: "run_parent",
      attemptCount: 0,
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    await repo.create({
      id: "rt_done",
      taskId: "task_t",
      roleId: "reviewer",
      state: "COMPLETED",
      parentRunId: "run_parent",
      attemptCount: 0,
      startedAt: new Date(),
      updatedAt: new Date(),
    });
    await repo.create({
      id: "rt_other_parent",
      taskId: "task_t",
      roleId: "coder",
      state: "RUNNING",
      parentRunId: "run_OTHER",
      attemptCount: 0,
      startedAt: new Date(),
      updatedAt: new Date(),
    });

    const r = await buildProgressArtifactFromState([], { taskId: "task_t", runId: "run_parent" });
    expect(r.activeTeammates).toBeDefined();
    expect(r.activeTeammates!.length).toBe(1);
    expect(r.activeTeammates![0]!.runId).toBe("rt_active");
  });
});

describe("loadReadFiles ledger (PR3)", () => {
  // Walks `leader.tool_call` events for read_file invocations,
  // dedupes by path, returns most-recent first, caps at 50.

  const tempRoot = join(process.cwd(), ".tmp-readfiles-ledger-test");

  beforeEach(() => {
    mkdirSync(tempRoot, { recursive: true });
    process.env.MAGISTER_DB_PATH = join(
      tempRoot,
      `readfiles-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );
  });

  afterEach(() => {
    delete process.env.MAGISTER_DB_PATH;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test("returns undefined when no read_file events exist", async () => {
    const { loadReadFiles } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );
    const r = await loadReadFiles("task_empty");
    expect(r).toBeUndefined();
  });

  test("collects unique paths most-recent first, dedupes repeated reads", async () => {
    const { ExecutionEventRepository } = await import(
      "../../src/repositories/execution-event-repository"
    );
    const { loadReadFiles } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );

    const repo = new ExecutionEventRepository();
    const base = Date.now();
    // a.ts read first
    await repo.create({
      id: "evt_1",
      type: "leader.tool_call",
      taskId: "task_files",
      requestId: "req_files",
      occurredAt: new Date(base),
      payloadJson: JSON.stringify({ toolName: "read_file", input: { path: "a.ts" } }),
    });
    // b.ts read second
    await repo.create({
      id: "evt_2",
      type: "leader.tool_call",
      taskId: "task_files",
      requestId: "req_files",
      occurredAt: new Date(base + 1000),
      payloadJson: JSON.stringify({ toolName: "read_file", input: { path: "b.ts" } }),
    });
    // a.ts read again — should dedupe with b coming first now.
    await repo.create({
      id: "evt_3",
      type: "leader.tool_call",
      taskId: "task_files",
      requestId: "req_files",
      occurredAt: new Date(base + 2000),
      payloadJson: JSON.stringify({ toolName: "read_file", input: { path: "a.ts" } }),
    });
    // Non-read_file event — ignored.
    await repo.create({
      id: "evt_4",
      type: "leader.tool_call",
      taskId: "task_files",
      requestId: "req_files",
      occurredAt: new Date(base + 3000),
      payloadJson: JSON.stringify({ toolName: "bash", input: { command: "ls" } }),
    });

    const r = await loadReadFiles("task_files");
    expect(r).toBeDefined();
    expect(r).toEqual(["a.ts", "b.ts"]); // a is newest (read at +2000), b at +1000
  });

  test("caps at 50 entries", async () => {
    const { ExecutionEventRepository } = await import(
      "../../src/repositories/execution-event-repository"
    );
    const { loadReadFiles } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );

    const repo = new ExecutionEventRepository();
    const base = Date.now();
    for (let i = 0; i < 60; i++) {
      await repo.create({
        id: `evt_cap_${i}`,
        type: "leader.tool_call",
        taskId: "task_cap",
        requestId: "req_cap",
        occurredAt: new Date(base + i),
        payloadJson: JSON.stringify({
          toolName: "read_file",
          input: { path: `file_${i}.ts` },
        }),
      });
    }
    const r = await loadReadFiles("task_cap");
    expect(r).toBeDefined();
    expect(r!.length).toBe(50);
    // Most recent first: file_59.ts came in last → should be first.
    expect(r![0]).toBe("file_59.ts");
  });

  test("falls back to file_path when path is absent (legacy claude-code style arg name)", async () => {
    const { ExecutionEventRepository } = await import(
      "../../src/repositories/execution-event-repository"
    );
    const { loadReadFiles } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );
    const repo = new ExecutionEventRepository();
    await repo.create({
      id: "evt_legacy",
      type: "leader.tool_call",
      taskId: "task_legacy",
      requestId: "req_legacy",
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        toolName: "read_file",
        input: { file_path: "/abs/path.ts" },
      }),
    });
    const r = await loadReadFiles("task_legacy");
    expect(r).toEqual(["/abs/path.ts"]);
  });
});

describe("autocompact retry on summary failure (PR3)", () => {
  // First-attempt failures halve the input and retry, up to 2 retries
  // total. Only `failed: true` after all retries exhaust.

  test("succeeds on first attempt — summaryRetryCount: 0", async () => {
    const messages = buildTurns(6);
    const r = await autocompact(
      messages,
      makeFakeModel("## Goal\n- ok"),
      "sys",
      { preserveTailTokens: 30 },
    );
    expect(r.compacted).toBe(true);
    expect(r.summaryRetryCount).toBe(0);
  });

  test("retries with halved input when first attempt throws context-overflow — summaryRetryCount: 1", async () => {
    const messages = buildTurns(8);
    let calls = 0;
    let firstAttemptMessageCount = -1;
    let secondAttemptMessageCount = -1;
    async function* model(
      params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      calls += 1;
      if (calls === 1) {
        firstAttemptMessageCount = params.messages.length;
        // Use a message that matches the context-overflow regex.
        throw new Error("input too long: max tokens exceeded");
      }
      secondAttemptMessageCount = params.messages.length;
      yield { type: "assistant", content: [{ type: "text", text: "## Goal\n- recovered" }] };
    }

    const r = await autocompact(messages, model, "sys", { preserveTailTokens: 30 });
    expect(r.compacted).toBe(true);
    expect(r.summaryRetryCount).toBe(1);
    expect(calls).toBe(2);
    // Second attempt sees fewer messages than the first (halved old portion).
    expect(secondAttemptMessageCount).toBeLessThan(firstAttemptMessageCount);
  });

  test("after 3 context-overflow attempts (initial + 2 retries) → failed: true", async () => {
    const messages = buildTurns(8);
    let calls = 0;
    async function* model(
      _params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      calls += 1;
      // Match the context-overflow detector so the retry loop runs.
      throw new Error("context_length_exceeded — too many tokens");
      yield { type: "assistant", content: [] }; // unreachable; satisfies generator typing
    }

    const r = await autocompact(messages, model, "sys", { preserveTailTokens: 30 });
    expect(r.compacted).toBe(false);
    expect(r.failed).toBe(true);
    expect(calls).toBe(3); // initial + 2 retries
  });

  test("non-context errors (auth/rate-limit) do NOT retry — fail fast", async () => {
    // kimi review fix: a 401/403/429 should fail immediately so we
    // don't burn retries on errors that halving the input can't fix.
    const messages = buildTurns(8);
    let calls = 0;
    async function* model(
      _params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      calls += 1;
      throw new Error("401 Unauthorized — bad API key");
      yield { type: "assistant", content: [] };
    }

    const r = await autocompact(messages, model, "sys", { preserveTailTokens: 30 });
    expect(r.compacted).toBe(false);
    expect(r.failed).toBe(true);
    expect(calls).toBe(1); // no retries — failed immediately
  });

  test("error with code: context_length_exceeded triggers retry path", async () => {
    const messages = buildTurns(8);
    let calls = 0;
    async function* model(
      _params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      calls += 1;
      if (calls < 3) {
        const err = new Error("provider error") as Error & { code?: string };
        err.code = "context_length_exceeded";
        throw err;
      }
      yield { type: "assistant", content: [{ type: "text", text: "## Goal\n- ok" }] };
    }

    const r = await autocompact(messages, model, "sys", { preserveTailTokens: 30 });
    expect(r.compacted).toBe(true);
    expect(calls).toBe(3); // 2 retries needed
    expect(r.summaryRetryCount).toBe(2);
  });
});

describe("autocompact extraContext flow (PR3)", () => {
  test("extraContext is appended under <additional-context> in the summary prompt", async () => {
    const messages = buildTurns(5);
    let capturedPrompt = "";
    async function* model(
      params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      let lastUserContent: string | undefined;
      for (let i = params.messages.length - 1; i >= 0; i--) {
        const msg = params.messages[i]!;
        if (msg.type === "user" && typeof msg.content === "string") {
          lastUserContent = msg.content;
          break;
        }
      }
      if (lastUserContent !== undefined) capturedPrompt = lastUserContent;
      yield { type: "assistant", content: [{ type: "text", text: "## Goal\n- ok" }] };
    }

    await autocompact(messages, model, "sys", {
      preserveTailTokens: 30,
      extraContext: [
        "The agent has read these files: a.ts, b.ts",
        "Current plan in_progress: Run tests",
      ],
    });

    expect(capturedPrompt).toContain("<additional-context>");
    expect(capturedPrompt).toContain("The agent has read these files: a.ts, b.ts");
    expect(capturedPrompt).toContain("Current plan in_progress: Run tests");
    expect(capturedPrompt).toContain("</additional-context>");
  });

  test("no extraContext → no <additional-context> tag", async () => {
    const messages = buildTurns(5);
    let capturedPrompt = "";
    async function* model(
      params: LeaderModelCallParams,
    ): AsyncGenerator<LeaderAssistantMessage> {
      let lastUserContent: string | undefined;
      for (let i = params.messages.length - 1; i >= 0; i--) {
        const msg = params.messages[i]!;
        if (msg.type === "user" && typeof msg.content === "string") {
          lastUserContent = msg.content;
          break;
        }
      }
      if (lastUserContent !== undefined) capturedPrompt = lastUserContent;
      yield { type: "assistant", content: [{ type: "text", text: "## Goal\n- ok" }] };
    }

    await autocompact(messages, model, "sys", { preserveTailTokens: 30 });
    expect(capturedPrompt).not.toContain("<additional-context>");
  });
});

describe("formatProgressForInjection — durable sections", () => {
  test("renders plan with checkbox glyphs when present", async () => {
    const { formatProgressForInjection } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );
    const out = formatProgressForInjection({
      completedSteps: [],
      currentStep: null,
      modifiedFiles: [],
      toolsUsed: [],
      turnCount: 5,
      plan: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "in_progress" },
        { content: "C", activeForm: "Doing C", status: "pending" },
        { content: "D", activeForm: "Doing D", status: "cancelled" },
      ],
      activeTeammates: [{ runId: "rt_x", roleId: "coder", state: "RUNNING" }],
    });
    expect(out).toContain("Current plan:");
    expect(out).toContain("✔ A");
    // in_progress shows activeForm
    expect(out).toContain("▶ Doing B");
    expect(out).toContain("□ C");
    expect(out).toContain("⊘ D");
    expect(out).toContain("Active teammates:");
    expect(out).toContain("coder (rt_x");
  });

  test("omits durable sections entirely when arrays empty / undefined", async () => {
    const { formatProgressForInjection } = await import(
      "../../src/services/manager-automation/autonomous-loop/progress-artifacts"
    );
    const out = formatProgressForInjection({
      completedSteps: [],
      currentStep: null,
      modifiedFiles: [],
      toolsUsed: [],
      turnCount: 0,
    });
    expect(out).not.toContain("Current plan:");
    expect(out).not.toContain("Active teammates:");
    expect(out).not.toContain("Pending approvals:");
  });
});
