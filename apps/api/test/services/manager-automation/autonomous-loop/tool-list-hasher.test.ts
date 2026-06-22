/**
 * Spec §4.5 — content-hash short-circuit for the per-turn tool-list
 * reload path. These tests pin the determinism guarantees the loop
 * relies on to keep the provider's prompt cache warm.
 */
import { expect, test } from "bun:test";
import { z } from "zod";

import type { LeaderTool } from "../../../../src/services/manager-automation/autonomous-loop/autonomous-types";
import {
  computeToolListDiff,
  hashToolsList,
  stableStringify,
} from "../../../../src/services/manager-automation/autonomous-loop/tool-list-hasher";

function makeTool(name: string, opts: { description?: string; schema?: Record<string, unknown> } = {}): LeaderTool {
  return {
    name,
    description: opts.description ?? `${name} description`,
    inputSchema: z.record(z.string(), z.unknown()),
    ...(opts.schema ? { inputJsonSchemaOverride: opts.schema } : {}),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    async call() {
      return { data: "" };
    },
  };
}

test("hashToolsList: sort-independent (order doesn't affect hash)", () => {
  const a = makeTool("a-tool");
  const b = makeTool("b-tool");
  expect(hashToolsList([a, b])).toBe(hashToolsList([b, a]));
});

test("hashToolsList: stable across object-key order (canonical JSON)", () => {
  // Mirror the same skill twice but built differently to provoke key-order
  // drift if `stableStringify` were ever omitted.
  const t1 = makeTool("t");
  const t2: LeaderTool = {
    name: t1.name,
    inputSchema: t1.inputSchema,
    ...(t1.description !== undefined ? { description: t1.description } : {}),
    isPlanSafe: () => false,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async call() {
      return { data: "" };
    },
  };
  expect(hashToolsList([t1])).toBe(hashToolsList([t2]));
});

test("hashToolsList: ignores wire-irrelevant fields (lambda identity)", () => {
  // Two tools that differ ONLY in their isConcurrencySafe lambda identity
  // — the wire shape (name + description + schema) is unchanged. Hash
  // must NOT shift, else MCP reconnects (which re-create the lambdas)
  // would invalidate the prompt cache for no reason.
  const a = makeTool("dup");
  const b: LeaderTool = {
    name: a.name,
    ...(a.description !== undefined ? { description: a.description } : {}),
    inputSchema: a.inputSchema,
    isConcurrencySafe: () => true,    // different from a
    isReadOnly: () => true,           // different from a
    isPlanSafe: () => true,           // different from a
    async call() {
      return { data: "" };
    },
  };
  expect(hashToolsList([a])).toBe(hashToolsList([b]));
});

test("hashToolsList: surfaces real description change", () => {
  const before = makeTool("t", { description: "old description" });
  const after = makeTool("t", { description: "new description" });
  expect(hashToolsList([before])).not.toBe(hashToolsList([after]));
});

test("hashToolsList: surfaces real schema change", () => {
  const before = makeTool("t", { schema: { type: "object", properties: { x: { type: "string" } } } });
  const after = makeTool("t", { schema: { type: "object", properties: { y: { type: "string" } } } });
  expect(hashToolsList([before])).not.toBe(hashToolsList([after]));
});

test("hashToolsList: covers derived Zod schema when no override is supplied", () => {
  // Codex review #1 — both anthropic-plugin and openai-compat fall
  // back to `z.toJSONSchema(tool.inputSchema)` when no override is
  // present. The hasher must reflect that fallback so two tools that
  // differ only in their Zod schema produce different hashes (else
  // hot-reload silently misses a real change → cache stays warm on
  // semantically-different tools, model sees a stale tool spec).
  const before: LeaderTool = {
    name: "x",
    description: "same",
    inputSchema: z.object({ alpha: z.string() }),
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    async call() { return { data: "" }; },
  };
  const after: LeaderTool = {
    name: "x",
    description: "same",
    inputSchema: z.object({ alpha: z.string(), beta: z.number() }),  // added field
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isPlanSafe: () => false,
    async call() { return { data: "" }; },
  };
  expect(hashToolsList([before])).not.toBe(hashToolsList([after]));
});

test("hashToolsList: surfaces real tool added / removed", () => {
  const list1 = [makeTool("a"), makeTool("b")];
  const list2 = [makeTool("a"), makeTool("b"), makeTool("c")];
  expect(hashToolsList(list1)).not.toBe(hashToolsList(list2));
});

test("computeToolListDiff: empty when lists are identical by name", () => {
  const list = [makeTool("a"), makeTool("b")];
  const diff = computeToolListDiff(list, list);
  expect(diff.added).toEqual([]);
  expect(diff.removed).toEqual([]);
});

test("computeToolListDiff: reports added and removed name sets", () => {
  const prev = [makeTool("a"), makeTool("b"), makeTool("c")];
  const next = [makeTool("b"), makeTool("c"), makeTool("d"), makeTool("e")];
  const diff = computeToolListDiff(prev, next);
  expect(diff.added).toEqual(["d", "e"]);
  expect(diff.removed).toEqual(["a"]);
});

test("stableStringify: produces same output regardless of key insertion order", () => {
  const a = { foo: 1, bar: 2, baz: { z: 9, y: 8, x: 7 } };
  const b = { baz: { x: 7, y: 8, z: 9 }, bar: 2, foo: 1 };
  expect(stableStringify(a)).toBe(stableStringify(b));
});
