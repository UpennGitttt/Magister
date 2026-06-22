import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { runToolUse } from "../../../../src/services/manager-automation/autonomous-loop/tool-execution";
import type {
  LeaderTool,
  LeaderToolUseContext,
} from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";

/**
 * 2026-05-12 — per-tool timeout coverage. Replicates the failure
 * mode that motivated the feature: a tool whose promise never
 * resolves should NOT hang the loop indefinitely; instead the
 * runToolUse generator yields a tool_result with a timeout error
 * message within ~timeoutMs of the call.
 */

function makeContext(overrides: Partial<LeaderToolUseContext> = {}): LeaderToolUseContext {
  return {
    taskId: "task_test",
    runId: "run_test",
    requestId: "req_test",
    workspaceDir: "/tmp",
    abortController: new AbortController(),
    messages: [],
    tools: [],
    getInProgressToolUseIDs: () => new Set(),
    setInProgressToolUseIDs: () => {},
    recordEvent: async () => {},
    ...overrides,
  };
}

function makeHangingTool(timeoutMs?: number): LeaderTool {
  return {
    name: "hangs_forever",
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isPlanSafe: () => true,
    ...(timeoutMs != null ? { defaultTimeoutMs: timeoutMs } : {}),
    call: async (_args, ctx) => {
      // Promise that resolves ONLY when the scoped controller aborts.
      // Mirrors how bash-tool reacts to input.signal.abort().
      return new Promise<{ data: string }>((resolve) => {
        const sig = ctx.abortController.signal;
        if (sig.aborted) {
          resolve({ data: "aborted-early" });
          return;
        }
        sig.addEventListener("abort", () => {
          resolve({ data: "aborted" });
        }, { once: true });
      });
    },
  };
}

function makeIgnorantTool(timeoutMs?: number): LeaderTool {
  // A tool that doesn't even look at its abort signal — simulates
  // a misbehaving handler (sync-blocking computation, ignored
  // signal). Promise.race in tool-execution is what saves us.
  return {
    name: "ignores_signal",
    inputSchema: z.object({}),
    isConcurrencySafe: () => true,
    isReadOnly: () => true,
    isPlanSafe: () => true,
    ...(timeoutMs != null ? { defaultTimeoutMs: timeoutMs } : {}),
    call: () => new Promise<{ data: string }>(() => {
      /* never resolves, never reacts to abort */
    }),
  };
}

async function collectFirstMessage(
  toolUse: { id: string; name: string; input: Record<string, unknown> },
  tools: LeaderTool[],
  context: LeaderToolUseContext,
) {
  const updates: Array<{ message?: { content?: unknown; isError?: boolean } }> = [];
  for await (const u of runToolUse(toolUse, tools, context)) {
    updates.push(u as { message?: { content?: unknown; isError?: boolean } });
    if (u.message) break;
  }
  return updates;
}

function contentString(msg: { content?: unknown } | undefined): string {
  const c = msg?.content;
  return typeof c === "string" ? c : "";
}

describe("per-tool timeout (defaultTimeoutMs) — runToolUse wrapper", () => {
  test("signal-aware tool: timeout fires, scoped signal aborts, tool resolves, tool_result is timeout-flavored", async () => {
    const tool = makeHangingTool(150);
    const t0 = Date.now();
    const updates = await collectFirstMessage(
      { id: "tu_timeout_aware", name: "hangs_forever", input: {} },
      [tool],
      makeContext(),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // far below the original 12.5h hang
    expect(elapsed).toBeGreaterThanOrEqual(140);
    const last = updates[updates.length - 1]!;
    expect(last.message?.isError).toBe(true);
    expect(contentString(last.message)).toContain("timed out after 150ms");
  });

  test("signal-ignoring tool: Promise.race breaks free, tool_result still flagged as timeout", async () => {
    const tool = makeIgnorantTool(150);
    const t0 = Date.now();
    const updates = await collectFirstMessage(
      { id: "tu_timeout_ignorant", name: "ignores_signal", input: {} },
      [tool],
      makeContext(),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(140);
    const last = updates[updates.length - 1]!;
    expect(last.message?.isError).toBe(true);
    expect(contentString(last.message)).toContain("timed out");
  });

  test("no defaultTimeoutMs: tool runs indefinitely until parent abort (sanity check — long-running teammate path)", async () => {
    const tool = makeHangingTool(undefined); // no timeout
    const ctx = makeContext();
    // Run the tool in the background; abort the parent after 100ms.
    setTimeout(() => ctx.abortController.abort("parent_cancel"), 100);
    const updates = await collectFirstMessage(
      { id: "tu_no_timeout", name: "hangs_forever", input: {} },
      [tool],
      ctx,
    );
    // Tool resolved (because we used a signal-aware tool that listens
    // to abort) — but the result is NOT a tool-timeout, it's the
    // normal "aborted" data, since timeout didn't fire.
    const last = updates[updates.length - 1]!;
    expect(contentString(last.message)).not.toContain("timed out");
    // The cancelled-by-user short-circuit at the top of runToolUse
    // fires before the tool even runs when parent is already aborted
    // — but here the abort happens DURING execution. Either way the
    // tool exits cleanly without a "timed out after" message.
  });

  test("model-provided timeout override (input.timeout) wins over defaultTimeoutMs — only when acceptsTimeoutOverride is set", async () => {
    // Tool's default is 5 seconds, but the model passes timeout=200ms — the
    // shorter override should win, and we should see a timeout fire well
    // before the 5-second default.
    const tool: LeaderTool = {
      name: "hangs_forever",
      inputSchema: z.object({ timeout: z.number().optional() }),
      defaultTimeoutMs: 5_000,
      acceptsTimeoutOverride: true,
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async (_args, ctx) =>
        new Promise<{ data: string }>((resolve) => {
          ctx.abortController.signal.addEventListener(
            "abort",
            () => resolve({ data: "aborted" }),
            { once: true },
          );
        }),
    };
    const t0 = Date.now();
    const updates = await collectFirstMessage(
      { id: "tu_override", name: "hangs_forever", input: { timeout: 200 } },
      [tool],
      makeContext(),
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // would have been ≥5s without the override
    expect(elapsed).toBeGreaterThanOrEqual(190);
    const last = updates[updates.length - 1]!;
    expect(last.message?.isError).toBe(true);
    expect(contentString(last.message)).toContain("timed out after 200ms");
  });

  test("input.timeout is IGNORED when acceptsTimeoutOverride is not set (regression: prevents seconds-vs-ms unit collision)", async () => {
    // Regression for the M1 review finding. request_human_input
    // declared a `timeout` field in SECONDS — if the runner reads
    // `input.timeout` blindly as MILLISECONDS for every tool, a model
    // passing `timeout: 60` (intended seconds) gets aborted at 60ms.
    // Without the opt-in flag, the runner must ignore `input.timeout`
    // and fall back to defaultTimeoutMs.
    const tool: LeaderTool = {
      name: "sleeps_briefly",
      inputSchema: z.object({ timeout: z.number().optional() }),
      defaultTimeoutMs: 5_000,
      // Crucially, NO acceptsTimeoutOverride flag.
      isConcurrencySafe: () => true,
      isReadOnly: () => true,
      isPlanSafe: () => true,
      call: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { data: "completed" };
      },
    };
    const t0 = Date.now();
    const updates = await collectFirstMessage(
      // Model passes timeout=60 (intended seconds). If the runner
      // misreads this as 60 ms the tool would abort immediately.
      { id: "tu_no_optin", name: "sleeps_briefly", input: { timeout: 60 } },
      [tool],
      makeContext(),
    );
    const elapsed = Date.now() - t0;
    const last = updates[updates.length - 1]!;
    // Must complete normally — input.timeout was ignored.
    expect(elapsed).toBeGreaterThanOrEqual(190);
    expect(last.message?.isError).toBeFalsy();
    expect(contentString(last.message)).not.toContain("timed out");
  });

  test("parent abort during timed tool: tool exits as user-cancel, not as timeout", async () => {
    const tool = makeHangingTool(5_000); // long timeout
    const ctx = makeContext();
    setTimeout(() => ctx.abortController.abort("user_cancel"), 100);
    const t0 = Date.now();
    const updates = await collectFirstMessage(
      { id: "tu_parent_cancel", name: "hangs_forever", input: {} },
      [tool],
      ctx,
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1000); // exited via parent cancel, not 5s timeout
    const last = updates[updates.length - 1]!;
    // The tool resolved on signal.abort; content is "aborted" (from
    // the tool's own signal handler), NOT a timeout message.
    expect(contentString(last.message)).not.toContain("timed out after");
  });
});
