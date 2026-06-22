import { describe, expect, test } from "bun:test";
import { DoomLoopDetector } from "../../src/services/manager-automation/autonomous-loop/doom-loop-detector";

describe("DoomLoopDetector", () => {
  test("no doom loop for unique tool calls", () => {
    const detector = new DoomLoopDetector();

    const calls = [
      detector.record("read", { file_path: "a.txt" }),
      detector.record("bash", { command: "ls -la" }),
      detector.record("glob", { pattern: "*.ts" }),
    ];

    for (const call of calls) {
      expect(call.isDoomLoop).toBe(false);
      expect(call.count).toBe(1);
      expect(call.warningMessage).toBeUndefined();
    }
  });

  test("detects doom loop when same fingerprint appears 3 times", () => {
    const detector = new DoomLoopDetector();

    const first = detector.record("bash", { command: "pwd" });
    const second = detector.record("bash", { command: "pwd" });
    const third = detector.record("bash", { command: "pwd" });

    expect(first.isDoomLoop).toBe(false);
    expect(second.isDoomLoop).toBe(false);
    expect(third.isDoomLoop).toBe(true);
    expect(third.count).toBe(3);
    expect(third.warningMessage).toContain("Doom loop detected");
  });

  test("doom loop detection resets after different tool call", () => {
    const detector = new DoomLoopDetector();

    detector.record("bash", { command: "pwd" });
    detector.record("bash", { command: "pwd" });

    const differentCall = detector.record("read", { file_path: "README.md" });

    expect(differentCall.isDoomLoop).toBe(false);
    expect(differentCall.count).toBe(1);
  });

  test("sliding window of 20 calls — old fingerprints expire", () => {
    const detector = new DoomLoopDetector();

    detector.record("bash", { command: "pwd" });
    detector.record("bash", { command: "pwd" });

    for (let i = 0; i < 20; i += 1) {
      detector.record("read", { file_path: `file-${i}.txt` });
    }

    const afterWindowExpires = detector.record("bash", { command: "pwd" });

    expect(afterWindowExpires.isDoomLoop).toBe(false);
    expect(afterWindowExpires.count).toBe(1);
  });

  test("different args = different fingerprint (no false positive)", () => {
    const detector = new DoomLoopDetector();

    const a = detector.record("bash", { command: "echo one" });
    const b = detector.record("bash", { command: "echo two" });
    const c = detector.record("bash", { command: "echo three" });

    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(b.fingerprint).not.toBe(c.fingerprint);
    expect(c.isDoomLoop).toBe(false);
  });

  test("getWarningMessage returns actionable text", () => {
    const detector = new DoomLoopDetector();

    const warning = detector.getWarningMessage("bash", 3);

    expect(warning).toContain("Doom loop detected");
    expect(warning).toContain('tool "bash"');
    expect(warning).toContain("Breaking loop");
  });

  // Regression coverage for the update_plan / doom-loop interaction
  // I flagged in the TodoWrite spec rollout. Concern was: leader
  // calls update_plan many times in a row to advance progress; if the
  // fingerprint were derived from toolName only (or a coarse subset
  // of args), three consecutive plan updates would falsely trip the
  // doom loop and lock the new feature.
  //
  // Conclusion: fingerprint hashes the FULL JSON-stringified args, so
  // each progressive update has a different fingerprint. False
  // positive is impossible for genuine progressive updates. The two
  // tests below pin this contract so future fingerprint changes
  // can't silently regress it.

  test("progressive update_plan calls (status advancing) do NOT trigger doom loop", () => {
    const detector = new DoomLoopDetector();

    // Snapshot 1: item 1 in_progress
    const r1 = detector.record("update_plan", {
      todos: [
        { content: "A", activeForm: "Doing A", status: "in_progress" },
        { content: "B", activeForm: "Doing B", status: "pending" },
        { content: "C", activeForm: "Doing C", status: "pending" },
      ],
    });
    // Snapshot 2: item 1 completed, item 2 in_progress
    const r2 = detector.record("update_plan", {
      todos: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "in_progress" },
        { content: "C", activeForm: "Doing C", status: "pending" },
      ],
    });
    // Snapshot 3: items 1-2 completed, item 3 in_progress
    const r3 = detector.record("update_plan", {
      todos: [
        { content: "A", activeForm: "Doing A", status: "completed" },
        { content: "B", activeForm: "Doing B", status: "completed" },
        { content: "C", activeForm: "Doing C", status: "in_progress" },
      ],
    });

    // All three should have distinct fingerprints — no false trigger.
    expect(r1.fingerprint).not.toBe(r2.fingerprint);
    expect(r2.fingerprint).not.toBe(r3.fingerprint);
    expect(r1.fingerprint).not.toBe(r3.fingerprint);
    expect(r1.isDoomLoop).toBe(false);
    expect(r2.isDoomLoop).toBe(false);
    expect(r3.isDoomLoop).toBe(false);
  });

  test("re-emitting an UNCHANGED update_plan 3+ times DOES trigger doom loop", () => {
    // The flip side of the previous test: if the leader gets stuck and
    // re-emits the same plan snapshot without making real progress,
    // the doom loop should still fire. This is a legitimate signal —
    // we don't want a special exemption for update_plan that swallows
    // real stuck-leader behavior.
    const detector = new DoomLoopDetector();
    const stuckSnapshot = {
      todos: [
        { content: "A", activeForm: "Doing A", status: "in_progress" },
        { content: "B", activeForm: "Doing B", status: "pending" },
      ],
    };

    detector.record("update_plan", stuckSnapshot);
    detector.record("update_plan", stuckSnapshot);
    const third = detector.record("update_plan", stuckSnapshot);

    expect(third.isDoomLoop).toBe(true);
    expect(third.count).toBe(3);
  });

  test("snapshot/restore preserves the fingerprint window across instances", () => {
    const d = new DoomLoopDetector();
    // Record the same tool call REPEAT_THRESHOLD-1 (i.e. 2) times — one below the block threshold.
    d.record("bash", { command: "echo stuck" });
    d.record("bash", { command: "echo stuck" });

    // Snapshot the state and restore it into a fresh instance.
    const snap = d.snapshot();
    const d2 = new DoomLoopDetector();
    d2.restore(snap);

    // The next identical call on the restored detector should trip the block.
    const verdict = d2.record("bash", { command: "echo stuck" });
    expect(verdict.isDoomLoop).toBe(true);
    expect(verdict.count).toBe(3);

    // A fresh (un-restored) detector should NOT block on a single call.
    const d3 = new DoomLoopDetector();
    expect(d3.record("bash", { command: "echo stuck" }).isDoomLoop).toBe(false);
  });
});
