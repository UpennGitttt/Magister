import { describe, expect, test } from "bun:test";

import { groupConsecutiveTools } from "./render";
import type { MediaPart, ModelErrorPart, ResponsePart, TextPart, ToolPart } from "./types";

// Compact factories — keep tests legible.
function text(id: string, content: string, sealed = true): TextPart {
  return { kind: "text", id, content, sealed, buffer: null };
}
function tool(id: string, name: string = "tool", completed = true): ToolPart {
  return {
    kind: "tool",
    id,
    toolUseId: id,
    name,
    input: null,
    result: completed ? { isError: false, output: "ok" } : null,
  };
}
function err(id: string, message = "boom"): ModelErrorPart {
  return { kind: "model-error", id, message };
}
function media(id: string): MediaPart {
  return {
    kind: "media",
    id,
    mediaId: "media_1",
    mediaKind: "image",
    mimeType: "image/png",
    filename: "shot.png",
    sizeBytes: 95,
    url: "/api/tasks/task/media/media_1",
    display: "inline",
  };
}

describe("groupConsecutiveTools", () => {
  test("empty input returns empty output", () => {
    expect(groupConsecutiveTools([])).toEqual([]);
  });

  test("single text part renders as a single 'text' item", () => {
    const r = groupConsecutiveTools([text("t0", "hi")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("text");
  });

  test("single tool part stays ungrouped", () => {
    const r = groupConsecutiveTools([tool("a", "list_dir")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("tool");
  });

  test("two consecutive completed tools group", () => {
    const r = groupConsecutiveTools([tool("a", "list_dir"), tool("b", "read_file")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("tool-group");
    if (r[0]?.kind === "tool-group") expect(r[0].parts).toHaveLength(2);
  });

  test("three+ consecutive completed tools all collapse into the same group", () => {
    const r = groupConsecutiveTools([tool("a"), tool("b"), tool("c")]);
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("tool-group");
    if (r[0]?.kind === "tool-group") expect(r[0].parts).toHaveLength(3);
  });

  test("a running (incomplete) tool breaks a group — incomplete renders solo, neighbors group only with each other", () => {
    const parts: ResponsePart[] = [
      tool("a", "list_dir"),
      tool("b", "read_file", false), // running
      tool("c", "list_dir"),
      tool("d", "read_file"),
    ];
    const r = groupConsecutiveTools(parts);
    // a is alone (only one completed before the running one) → tool
    // b is running → tool
    // c+d → tool-group
    expect(r.map((it) => it.kind)).toEqual(["tool", "tool", "tool-group"]);
  });

  test("text between tool runs creates two separate groups", () => {
    const parts: ResponsePart[] = [
      tool("a"), tool("b"),       // group 1
      text("t1", "explanation"),
      tool("c"), tool("d"), tool("e"), // group 2
    ];
    const r = groupConsecutiveTools(parts);
    expect(r.map((it) => it.kind)).toEqual(["tool-group", "text", "tool-group"]);
    if (r[0]?.kind === "tool-group") expect(r[0].parts).toHaveLength(2);
    if (r[2]?.kind === "tool-group") expect(r[2].parts).toHaveLength(3);
  });

  test("media parts break tool groups and render as their own item", () => {
    const parts: ResponsePart[] = [tool("a"), tool("b"), media("m1"), tool("c"), tool("d")];
    const r = groupConsecutiveTools(parts);
    expect(r.map((it) => it.kind)).toEqual(["tool-group", "media", "tool-group"]);
  });

  test("model-error breaks a group and emits its own item", () => {
    const parts: ResponsePart[] = [tool("a"), tool("b"), err("e1"), tool("c"), tool("d")];
    const r = groupConsecutiveTools(parts);
    expect(r.map((it) => it.kind)).toEqual(["tool-group", "model-error", "tool-group"]);
  });

  test("group key is stable: derived from the first tool's id", () => {
    const r1 = groupConsecutiveTools([tool("a"), tool("b")]);
    const r2 = groupConsecutiveTools([tool("a"), tool("b")]);
    if (r1[0]?.kind === "tool-group" && r2[0]?.kind === "tool-group") {
      expect(r1[0].key).toBe(r2[0].key);
    }
  });
});
