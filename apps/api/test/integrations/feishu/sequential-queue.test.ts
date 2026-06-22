import { afterEach, expect, test } from "bun:test";
import {
  __resetQueueForTests,
  enqueue,
  feishuChatKey,
  getQueueSnapshot,
} from "../../../src/integrations/feishu/sequential-queue";

afterEach(() => {
  __resetQueueForTests();
});

test("tasks for the same key run in FIFO order", async () => {
  const order: number[] = [];
  await Promise.all([
    enqueue("k", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push(1);
    }),
    enqueue("k", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
    }),
    enqueue("k", async () => {
      order.push(3);
    }),
  ]);
  expect(order).toEqual([1, 2, 3]);
});

test("tasks for different keys run concurrently", async () => {
  const order: string[] = [];
  await Promise.all([
    enqueue("a", async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
    }),
    enqueue("b", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("b");
    }),
  ]);
  // b finishes first because its delay is shorter — proves they ran
  // in parallel, not serialized.
  expect(order).toEqual(["b", "a"]);
});

test("failed task does not break the chain", async () => {
  const results: string[] = [];
  const failed = enqueue("k", async () => {
    throw new Error("boom");
  });
  await failed.catch(() => results.push("caught"));
  await enqueue("k", async () => {
    results.push("after");
  });
  expect(results).toEqual(["caught", "after"]);
});

test("queue cleans up empty keys", async () => {
  await enqueue("ephemeral", async () => {
    // no-op
  });
  // microtask boundary for the .finally cleanup
  await new Promise((r) => setTimeout(r, 0));
  const snap = getQueueSnapshot();
  expect(snap.activeKeys).not.toContain("ephemeral");
});

test("feishuChatKey lane variants are distinct", () => {
  expect(feishuChatKey("b1")).toBe("feishu:b1");
  expect(feishuChatKey("b1", "control")).toBe("feishu:b1:control");
  expect(feishuChatKey("b1", "btw")).toBe("feishu:b1:btw");
});

test("control lane runs concurrently with main lane", async () => {
  const order: string[] = [];
  await Promise.all([
    enqueue(feishuChatKey("b1"), async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("main");
    }),
    enqueue(feishuChatKey("b1", "control"), async () => {
      order.push("control");
    }),
  ]);
  // Control runs first (no wait) — proves the lane bypassed the main chain
  expect(order).toEqual(["control", "main"]);
});
