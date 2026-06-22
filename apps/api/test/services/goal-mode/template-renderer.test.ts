import { describe, expect, test } from "bun:test";

import { renderTemplate } from "../../../src/services/goal-mode/template-renderer";

describe("renderTemplate", () => {
  test("substitutes a simple {{ var }} placeholder", () => {
    const out = renderTemplate("continuation", {
      objective: "refactor auth",
      budgetLines: "- Tokens: 100",
      goalIdSection: "",
      planSection: "",
      blockerSection: "",
      softSteerSection: "",
    });
    expect(out).toContain("refactor auth");
    expect(out).toContain("- Tokens: 100");
  });

  test("budget_limit template focuses on wrap-up, omits the audit section", () => {
    const out = renderTemplate("budget_limit", {
      objective: "anything",
      budgetLines: "- Tokens: 5000 / 1000 budget",
      planSection: "",
    });
    expect(out).toContain("token budget exhausted");
    // budget_limit should NOT include the standard audit prompt — the
    // "Decide" section belongs in continuation.md, not here. The point
    // of separating the templates is that wrap-up state gets a focused
    // prompt without the "is it done? prove it" framing.
    expect(out).not.toContain("Decide: is the objective achieved");
    expect(out).not.toContain("Trivial goals");
  });

  test("unknown placeholder is left as-is (not deleted, not crashed)", () => {
    // Render with vars that miss `softSteerSection` → the literal
    // `{{ softSteerSection }}` stays in output. This is intentional:
    // a missing var should be greppable, not silently dropped.
    const out = renderTemplate("continuation", {
      objective: "x",
      budgetLines: "y",
      goalIdSection: "",
      planSection: "",
      blockerSection: "",
      // softSteerSection deliberately omitted
    });
    // Either the placeholder remains (strict behavior), or it's
    // substituted with empty. Current behavior: remains. Test pins it.
    expect(out).toMatch(/\{\{\s*softSteerSection\s*\}\}/);
  });

  test("renders the goal-continuation sentinel at the start", () => {
    const out = renderTemplate("continuation", {
      objective: "x",
      budgetLines: "y",
      goalIdSection: "",
      planSection: "",
      blockerSection: "",
      softSteerSection: "",
    });
    expect(out.startsWith("<<goal_continuation>>")).toBe(true);
  });
});
