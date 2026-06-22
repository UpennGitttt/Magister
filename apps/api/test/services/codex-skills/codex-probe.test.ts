/**
 * Codex skill probe parser tests. The two-layer parse (JSON ->
 * skills_instructions text -> regex) is the fragile part of the
 * design; these tests pin format expectations so a codex CLI
 * version bump that breaks the parser surfaces in CI rather than
 * in production.
 *
 * The real probe spawns codex; we test the pure parser by
 * exercising the helpers directly. The orchestrator's fallback
 * path is covered by a failing-probe scenario.
 */
import { expect, test } from "bun:test";

import { findSkillsBlock, parseSkillEntries } from "../../../src/services/codex-skills/codex-probe";

// Fixture imitates the JSON shape codex 0.128.0 emits — specifically
// the developer-role message containing <skills_instructions>.
// (Kimi review M3 — tests now drive the real exported parser; if
// production regex drifts, these assertions break.)

const FIXTURE_BASIC = JSON.stringify([
  {
    type: "message",
    role: "developer",
    content: [
      { type: "input_text", text: "<permissions instructions>...</permissions instructions>" },
      { type: "input_text", text: "<apps_instructions>...</apps_instructions>" },
      {
        type: "input_text",
        text: `<skills_instructions>
## Skills
A skill is a set of local instructions...
### Available skills
- imagegen: Generate or edit raster images... (file: /root/.codex/skills/.system/imagegen/SKILL.md)
- openai-docs: Use when... (file: /root/.codex/skills/.system/openai-docs/SKILL.md)
- find-skills: Helps users discover... (file: /root/.agents/skills/find-skills/SKILL.md)
- frontend-design: Frontend design... (file: /root/.agents/skills/frontend-design/SKILL.md)
- superpowers:brainstorming: You MUST use this... (file: /root/.codex/superpowers/skills/brainstorming/SKILL.md)
- superpowers:writing-plans: Use when... (file: /root/.codex/superpowers/skills/writing-plans/SKILL.md)
### How to use skills
- Discovery: ...
</skills_instructions>`,
      },
    ],
  },
  { type: "message", role: "user", content: [] },
]);

test("findSkillsBlock + parseSkillEntries round-trip the documented format", async () => {
  const parsed = JSON.parse(FIXTURE_BASIC);
  const block = findSkillsBlock(parsed);
  expect(block).not.toBeNull();
  if (!block) return;

  const entries = parseSkillEntries(block);
  expect(entries.length).toBe(6);

  const names = entries.map((e) => e.name).sort();
  expect(names).toEqual([
    "find-skills",
    "frontend-design",
    "imagegen",
    "openai-docs",
    "superpowers:brainstorming",
    "superpowers:writing-plans",
  ]);

  const imagegen = entries.find((e) => e.name === "imagegen");
  expect(imagegen?.filePath).toBe("/root/.codex/skills/.system/imagegen/SKILL.md");
  expect(imagegen?.description).toBe("Generate or edit raster images...");
});

test("parser tolerates `)` inside descriptions (kimi review M2)", async () => {
  // Description contains a closing paren. Earlier `[^)]+` regex would
  // truncate the description at the first paren and miss the file path.
  const text = `<skills_instructions>
### Available skills
- weird: Use when (option A) or option B is needed (file: /root/.agents/skills/weird/SKILL.md)
### How to use skills
</skills_instructions>`;
  const entries = parseSkillEntries(text);
  expect(entries.length).toBe(1);
  expect(entries[0]?.name).toBe("weird");
  expect(entries[0]?.description).toBe("Use when (option A) or option B is needed");
  expect(entries[0]?.filePath).toBe("/root/.agents/skills/weird/SKILL.md");
});

test("parser does not split on `###` substring inside description (kimi review C1)", async () => {
  // A description containing `###` shouldn't truncate the section.
  // Earlier `indexOf("###")` would terminate at the first inline
  // occurrence even if it's mid-description, dropping later skills.
  const text = `<skills_instructions>
### Available skills
- syntax: Use ### markdown ### headers responsibly (file: /root/.agents/skills/syntax/SKILL.md)
- second: Should still be parsed (file: /root/.agents/skills/second/SKILL.md)
### How to use skills
</skills_instructions>`;
  const entries = parseSkillEntries(text);
  expect(entries.length).toBe(2);
  expect(entries.map((e) => e.name).sort()).toEqual(["second", "syntax"]);
});

test("parser stops at the next line-anchored `### ` header", async () => {
  // The `How to use` header is on its own line; the parser must
  // still terminate the section there even though prior lines
  // contain `###` substrings.
  const text = `<skills_instructions>
### Available skills
- alpha: First (file: /a)
### How to use skills
- not a skill: should not appear (file: /b)
</skills_instructions>`;
  const entries = parseSkillEntries(text);
  expect(entries.length).toBe(1);
  expect(entries[0]?.name).toBe("alpha");
});

test("findSkillsBlock returns null for malformed JSON shape", async () => {
  expect(findSkillsBlock(null)).toBeNull();
  expect(findSkillsBlock("not an array")).toBeNull();
  expect(findSkillsBlock([])).toBeNull();
  expect(findSkillsBlock([{ role: "user", content: [] }])).toBeNull();
});

test("orchestrator falls back to scan when probe times out", async () => {
  const { __resetCodexSkillsCache, discoverCodexSkills } = await import(
    "../../../src/services/codex-skills/discover-codex-skills"
  );
  __resetCodexSkillsCache();
  // Force probe failure by pointing PATH at /tmp (no codex bin).
  const prevPath = process.env.PATH;
  process.env.PATH = "/tmp";
  try {
    const r = await discoverCodexSkills({ refresh: true });
    expect(r.method).toBe("scan");
    expect(typeof r.fallbackReason).toBe("string");
    // Scan still finds the local pool + .system + superpowers if
    // they exist on this box; the count is non-negative.
    expect(r.totalCount).toBeGreaterThanOrEqual(0);
  } finally {
    process.env.PATH = prevPath;
    __resetCodexSkillsCache();
  }
});
