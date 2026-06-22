import { test, expect } from "bun:test";

import { summarizeToolInputForEvent } from "../../../../src/services/manager-automation/autonomous-loop/tool-execution";

// Regression coverage for kimi review's Bug B: the prior
// `JSON.stringify(input).slice(0, 500)` approach could cut mid-string
// or mid-object and yield invalid JSON. The helper truncates string
// fields individually, keeping the result a structurally valid
// object that downstream parsers can rely on.

test("preserves small inputs unchanged", () => {
  const input = { role: "coder", goal: "implement X" };
  const out = summarizeToolInputForEvent(input);
  expect(out).toEqual(input);
});

test("caps long string fields without breaking the surrounding object", () => {
  const longGoal = "G".repeat(5000);
  const input = { role: "coder", goal: longGoal };
  const out = summarizeToolInputForEvent(input) as { role: string; goal: string };
  expect(out.role).toBe("coder");
  expect(out.goal.length).toBeLessThan(longGoal.length);
  expect(out.goal.endsWith("…")).toBe(true);
  // Result must still serialize to valid JSON (the whole point).
  expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
});

test("recurses into nested objects and arrays", () => {
  const input = {
    a: "short",
    b: { c: "X".repeat(5000), d: [1, 2, 3] },
    e: ["q", "Y".repeat(5000)],
  };
  const out = summarizeToolInputForEvent(input) as Record<string, any>;
  expect(out.a).toBe("short");
  expect(out.b.c.endsWith("…")).toBe(true);
  expect(out.b.d).toEqual([1, 2, 3]);
  expect(out.e[0]).toBe("q");
  expect(out.e[1].endsWith("…")).toBe(true);
});

test("caps overly long arrays with a count tail", () => {
  const input = { items: Array.from({ length: 50 }, (_, i) => `item-${i}`) };
  const out = summarizeToolInputForEvent(input) as { items: unknown[] };
  expect(out.items.length).toBe(21); // 20 + the "+30 more" sentinel
  expect(out.items[20]).toBe("…+30 more");
});

test("primitives and null pass through", () => {
  expect(summarizeToolInputForEvent(null)).toBe(null);
  expect(summarizeToolInputForEvent(42)).toBe(42);
  expect(summarizeToolInputForEvent(true)).toBe(true);
  expect(summarizeToolInputForEvent("plain")).toBe("plain");
});

test("very deep nesting is truncated to avoid pathological input", () => {
  // Build a 10-deep nested object.
  let nested: any = { leaf: "x" };
  for (let i = 0; i < 10; i++) nested = { down: nested };
  const out = summarizeToolInputForEvent(nested);
  // Should not throw / loop forever; some inner levels become undefined.
  expect(() => JSON.stringify(out)).not.toThrow();
});
