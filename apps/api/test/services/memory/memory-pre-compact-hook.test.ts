import { expect, test } from "bun:test";
import type {
  BeforeCompactInput,
  BeforeCompactResult,
} from "../../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { composePreCompactHooks } from "../../../src/services/memory/memory-pre-compact-hook";

const fakeInput: BeforeCompactInput = {
  taskId: "task_x",
  runId: "run_x",
  messages: [
    { type: "user", content: "hi" },
    { type: "assistant", content: [{ type: "text", text: "hello" }] },
  ],
  previousSummary: null,
};

test("composePreCompactHooks delegates the return value to the inner hook", async () => {
  const inner = async (
    _input: BeforeCompactInput,
  ): Promise<BeforeCompactResult> => ({ extraContext: ["from-inner"] });
  const wrapped = composePreCompactHooks(inner);
  const result = await wrapped(fakeInput);
  expect(result.extraContext).toEqual(["from-inner"]);
});

test("composePreCompactHooks returns even when inner returns empty", async () => {
  const inner = async (): Promise<BeforeCompactResult> => ({});
  const wrapped = composePreCompactHooks(inner);
  const result = await wrapped(fakeInput);
  expect(result.extraContext).toBeUndefined();
});

test("composePreCompactHooks doesn't surface errors from the side-effect", async () => {
  // The extractor's failure path is `runMemoryExtractor` → it never
  // throws. Even with no memory runtime initialized, the wrapper
  // should resolve cleanly to the inner result.
  const inner = async (): Promise<BeforeCompactResult> => ({
    extraContext: ["safe"],
  });
  const wrapped = composePreCompactHooks(inner);
  const result = await wrapped(fakeInput);
  expect(result.extraContext).toEqual(["safe"]);
});
