import "../test-setup";
import { describe, expect, test } from "bun:test";

import { formatRuntimeLabel } from "./runtimeLabels";

describe("formatRuntimeLabel", () => {
  test("maps the internal built-in runtime value to the Magister brand", () => {
    expect(formatRuntimeLabel("ucm")).toBe("Magister");
    expect(formatRuntimeLabel(null)).toBe("Magister");
  });

  test("keeps CLI runtimes readable", () => {
    expect(formatRuntimeLabel("codex")).toBe("CODEX");
    expect(formatRuntimeLabel("opencode")).toBe("OPENCODE");
    expect(formatRuntimeLabel("claude-code")).toBe("Claude Code");
  });
});
