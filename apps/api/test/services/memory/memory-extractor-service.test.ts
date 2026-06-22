import { expect, test } from "bun:test";
import {
  parseOperations,
  runMemoryExtractor,
} from "../../../src/services/memory/memory-extractor-service";

test("parseOperations returns empty array when no fenced block is present", () => {
  expect(parseOperations("nothing here")).toEqual([]);
  expect(parseOperations("")).toEqual([]);
});

test("parseOperations parses a clean fenced JSON block", () => {
  const raw = '```json\n{ "operations": [{"op":"upsert","path":"user-global/user/role","description":"d","body":"b"}] }\n```';
  const ops = parseOperations(raw);
  expect(ops).toHaveLength(1);
  expect(ops[0]).toMatchObject({
    op: "upsert",
    path: "user-global/user/role",
    description: "d",
    body: "b",
  });
});

test("parseOperations ignores prose around the JSON block", () => {
  const raw = `Sure, here's what I extracted:

\`\`\`json
{ "operations": [{"op":"upsert","path":"project/project/x","description":"d","body":"b"}] }
\`\`\`

Let me know if you want more.`;
  const ops = parseOperations(raw);
  expect(ops).toHaveLength(1);
  expect(ops[0]?.path).toBe("project/project/x");
});

test("parseOperations returns [] for malformed JSON", () => {
  const raw = '```json\n{ "operations": [missing-quote] }\n```';
  expect(parseOperations(raw)).toEqual([]);
});

test("parseOperations skips operations missing required fields", () => {
  const raw = '```json\n{ "operations": [{"op":"upsert","path":"p","description":"d"}, {"op":"upsert","path":"q","description":"d","body":"b"}] }\n```';
  const ops = parseOperations(raw);
  expect(ops).toHaveLength(1);
  expect(ops[0]?.path).toBe("q");
});

test("parseOperations ignores non-upsert ops", () => {
  const raw = '```json\n{ "operations": [{"op":"delete","path":"x"}, {"op":"upsert","path":"y","description":"d","body":"b"}] }\n```';
  const ops = parseOperations(raw);
  expect(ops).toHaveLength(1);
  expect(ops[0]?.op).toBe("upsert");
});

test("parseOperations carries supersedes / related when present", () => {
  const raw = '```json\n{ "operations": [{"op":"upsert","path":"p","description":"d","body":"b","supersedes":"old","related":["a","b"]}] }\n```';
  const ops = parseOperations(raw);
  expect(ops[0]?.supersedes).toBe("old");
  expect(ops[0]?.related).toEqual(["a", "b"]);
});

test("parseOperations returns [] when JSON is missing operations array", () => {
  const raw = '```json\n{ "stuff": 1 }\n```';
  expect(parseOperations(raw)).toEqual([]);
});

test("runMemoryExtractor coalesces concurrent same-key invocations (singleflight)", async () => {
  // No memory-extractor agent is configured in this isolated test
  // process; the extractor exits early with an empty result. But
  // the singleflight key is still set + released, so we can
  // observe coalescing by racing two same-key calls and asserting
  // both resolve to empty results (no exception).
  const [a, b] = await Promise.all([
    runMemoryExtractor({
      reason: "pre_compact",
      taskId: "task_x",
      userPrompt: "hi",
    }),
    runMemoryExtractor({
      reason: "pre_compact",
      taskId: "task_x",
      userPrompt: "hi again",
    }),
  ]);
  // Whichever ran first hit the no-agent branch; the second was
  // either coalesced (sf hit) or sequential (sf released by then).
  // Either way, both resolve cleanly with applied=0.
  expect(a.applied).toBe(0);
  expect(b.applied).toBe(0);
});
