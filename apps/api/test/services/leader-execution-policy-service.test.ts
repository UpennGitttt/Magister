import { describe, expect, test } from "bun:test";
import { classifyExecutionPolicy, isHighRiskPath, buildExecutionPolicyPrompt, buildSystemPromptWithPolicy, countChangedLines, evaluateToolCallAgainstExecutionPolicy, updateExecutionPolicyAfterTool, getEnforcementLevel, isCodeMutatingBash, modeIsEnforcedAtLevel, escalateToDelegated } from "../../src/services/leader-execution-policy-service";

describe("isHighRiskPath", () => {
  test("flags agent-loop, migrations, secrets, restart scripts; not ordinary paths", () => {
    expect(isHighRiskPath("apps/api/src/services/manager-automation/autonomous-loop/tool-execution.ts")).toBe(true);
    expect(isHighRiskPath("apps/api/src/services/manager-automation/teammate-system-prompts.ts")).toBe(true);
    expect(isHighRiskPath("packages/db/src/schema.ts")).toBe(true);
    expect(isHighRiskPath("config/executors.json")).toBe(true);
    expect(isHighRiskPath("config/secrets.json")).toBe(true);
    expect(isHighRiskPath("scripts/restart.sh")).toBe(true);
    expect(isHighRiskPath("apps/web/src/components/Button.tsx")).toBe(false);
    expect(isHighRiskPath("docs/notes.md")).toBe(false);
  });
});

describe("classifyExecutionPolicy", () => {
  const base = { source: "web" as const, availableRoles: ["coder", "reviewer", "architect", "lander"] };
  test("plain question → direct_answer, no delegation", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "what does this function do?" });
    expect(p.mode).toBe("direct_answer");
    expect(p.constraints.mustDelegate).toBe(false);
  });
  test("explicit no-delegate phrase → direct_override", () => {
    expect(classifyExecutionPolicy({ ...base, prompt: "你自己做，不要 subagent" }).mode).toBe("direct_override");
    expect(classifyExecutionPolicy({ ...base, prompt: "leader 直接改这个" }).mode).toBe("direct_override");
  });
  test("review/audit/no-modify → review_only, no code writes", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "review only, do not modify anything" });
    expect(p.mode).toBe("review_only");
    expect(p.constraints.allowCodeWriteTools).toBe(false);
    expect(p.constraints.mustDelegate).toBe(true);
  });
  test("explicit role mention sets suggestedRoleHint but NOT a hard role field", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "让 coder 修这个 bug" });
    expect(p.mode).toBe("delegated_coding");
    expect(p.constraints.mustDelegate).toBe(true);
    expect(p.constraints.suggestedRoleHint).toBe("coder");
    expect((p.constraints as any).requiredRole).toBeUndefined();
  });
  test("role mention for a non-existent role still mustDelegate (hint advisory only)", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "让 ghostrole 处理" });
    expect(p.constraints.mustDelegate).toBe(true);
    expect(p.constraints.suggestedRoleHint).toBe("ghostrole");
  });
  test("explicit commit/restart → ops_direct", () => {
    expect(classifyExecutionPolicy({ ...base, prompt: "commit and restart prod" }).mode).toBe("ops_direct");
  });
  test("vague 'fix the recall bug' → delegated_coding", () => {
    expect(classifyExecutionPolicy({ ...base, prompt: "fix the recall pipeline bug" }).mode).toBe("delegated_coding");
  });
  test("tiny targeted edit → direct_simple with 30-line / 2-file budget", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "change the timeout constant in config.ts to 5000" });
    expect(p.mode).toBe("direct_simple");
    expect(p.constraints.maxChangedLines).toBe(30);
    expect(p.constraints.maxWriteFiles).toBe(2);
  });
  test("role name matches on word boundary — 'encoder' must NOT trigger the 'coder' role", () => {
    // Regression: substring containment used to misclassify "encoder"/"decoder" as a
    // mention of the "coder" role and over-route to delegated_coding.
    const p = classifyExecutionPolicy({ ...base, prompt: "change the encoder constant in a.ts to 5000" });
    expect(p.mode).toBe("direct_simple");
    expect(p.constraints.suggestedRoleHint).toBeUndefined();
    const q = classifyExecutionPolicy({ ...base, prompt: "what does the decoder do?" });
    expect(q.mode).toBe("direct_answer");
    // A real word-boundary mention still routes to delegation:
    const r = classifyExecutionPolicy({ ...base, prompt: "have coder implement this" });
    expect(r.mode).toBe("delegated_coding");
    expect(r.constraints.suggestedRoleHint).toBe("coder");
  });
});

describe("buildExecutionPolicyPrompt", () => {
  test("delegated_coding addendum tells leader to delegate WITHOUT naming a required role, lists available roles", () => {
    const policy = classifyExecutionPolicy({ source: "web", availableRoles: ["coder", "reviewer"], prompt: "implement X across the pipeline" });
    const out = buildExecutionPolicyPrompt(policy, ["coder", "reviewer", "architect"]);
    expect(out).toContain("Mode: delegated_coding");
    expect(out).toMatch(/choose the best-fit/i);
    expect(out).toContain("coder"); // lists available roles
    expect(out).not.toMatch(/spawn_teammate role="coder"/); // does NOT hardcode a required role
  });
  test("direct_simple addendum states the 30-line / 2-file budget", () => {
    const policy = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "change the constant in a.ts" });
    const out = buildExecutionPolicyPrompt(policy, []);
    expect(out).toContain("Mode: direct_simple");
    expect(out).toContain("30");
  });
  test("ops_direct and direct_override produce concrete addenda", () => {
    const ops = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "commit and restart prod" });
    expect(buildExecutionPolicyPrompt(ops, [])).toContain("Mode: ops_direct");
    const ovr = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "你自己做，不要 subagent" });
    expect(buildExecutionPolicyPrompt(ovr, [])).toContain("Mode: direct_override");
  });
  test("review_only addendum says READ-ONLY and permits review/synthesis, does NOT say 'do not implement, review, or investigate'", () => {
    const policy = classifyExecutionPolicy({ source: "web", availableRoles: ["reviewer", "architect"], prompt: "review only, do not modify anything" });
    const out = buildExecutionPolicyPrompt(policy, ["reviewer", "architect"]);
    expect(out).toContain("Mode: review_only");
    expect(out).toMatch(/READ-ONLY/);
    // must mention the ability to synthesize / spawn investigation teammates
    expect(out).toMatch(/synthesi/i);
    expect(out).toMatch(/review|investigat/i);
    // must NOT contain the generic delegate wording that forbids reviewing
    expect(out).not.toContain("do not implement, review, or investigate it directly");
  });
});

describe("countChangedLines", () => {
  test("write_file counts non-empty content lines; edit_file = max(old,new) spans", () => {
    expect(countChangedLines("write_file", { path: "a.ts", content: "a\nb\nc" })).toBe(3);
    expect(countChangedLines("edit_file", { path: "a.ts", oldString: "x", newString: "y\nz\nw\nq" })).toBe(4);
  });
});

describe("evaluateToolCallAgainstExecutionPolicy", () => {
  const ro = (m: string) => classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: m });
  test("read-only tool always allowed", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("review only"), toolName: "read_file", toolInput: {}, toolIsReadOnly: true, enforcement: "delegated_coding" }).allow).toBe(true);
  });
  test("review_only blocks edit_file (mutating non-bash)", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("review only"), toolName: "edit_file", toolInput: { path: "a.ts", newString: "x" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("review_only blocks an arbitrary mutating tool by capability (e.g. apply_change_review)", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("review only"), toolName: "apply_change_review", toolInput: {}, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("delegated_coding blocks write_file before delegation", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("implement the new pipeline"), toolName: "write_file", toolInput: { path: "a.ts", content: "x" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  const simple = () => classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "change the constant in a.ts" });
  test("direct_simple allows a small edit, blocks >30-line edit (measured)", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: simple(), toolName: "edit_file", toolInput: { path: "a.ts", newString: "y\nz" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(true);
    const big = { path: "a.ts", content: Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n") };
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: simple(), toolName: "write_file", toolInput: big, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("direct_simple blocks high-risk path even if tiny", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: simple(), toolName: "edit_file", toolInput: { path: "config/executors.json", newString: "x" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("direct_simple allows 2nd file, blocks 3rd distinct file this turn", () => {
    const p2 = { ...simple(), counters: { ...simple().counters, writtenPaths: ["a.ts"] } };
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: p2, toolName: "edit_file", toolInput: { path: "b.ts", newString: "x" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(true);
    const p3 = { ...simple(), counters: { ...simple().counters, writtenPaths: ["a.ts", "b.ts"] } };
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: p3, toolName: "edit_file", toolInput: { path: "c.ts", newString: "x" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("direct_simple DENIES code-mutating bash (not line-measurable)", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: simple(), toolName: "bash", toolInput: { command: "sed -i 's/a/b/' a.ts" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("verification bash (bun test) is allowed even in review_only", () => {
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("review only"), toolName: "bash", toolInput: { command: "bun test" }, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(true);
  });
  test("ops_direct allows git commit + restart; review_only blocks git commit", () => {
    const ops = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "commit and restart prod" });
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ops, toolName: "git_commit", toolInput: {}, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(true);
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: ro("review only"), toolName: "git_commit", toolInput: {}, toolIsReadOnly: false, enforcement: "delegated_coding" }).allow).toBe(false);
  });
  test("strict: code-mutating bash blocked in delegated_coding; allowed under ops_direct", () => {
    const del = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "implement X" });
    expect(evaluateToolCallAgainstExecutionPolicy({ policy: del, toolName: "bash", toolInput: { command: "cat > a.ts <<EOF\nx\nEOF" }, toolIsReadOnly: false, enforcement: "strict" }).allow).toBe(false);
  });
});

describe("updateExecutionPolicyAfterTool", () => {
  const simple = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "change a.ts" });
  test("records written path for a mutating tool; increments write count", () => {
    const next = updateExecutionPolicyAfterTool({ policy: simple, toolName: "write_file", toolInput: { path: "a.ts", content: "x" }, toolIsReadOnly: false, toolOutput: {}, isError: false });
    expect(next.counters.writtenPaths).toContain("a.ts");
    expect(next.counters.writeToolCalls).toBe(1);
  });
  test("spawn sets teammateSpawned; read tool increments discovery", () => {
    expect(updateExecutionPolicyAfterTool({ policy: simple, toolName: "spawn_teammate", toolInput: {}, toolIsReadOnly: false, toolOutput: {}, isError: false }).counters.teammateSpawned).toBe(true);
    expect(updateExecutionPolicyAfterTool({ policy: simple, toolName: "read_file", toolInput: {}, toolIsReadOnly: true, toolOutput: {}, isError: false }).counters.discoveryToolCalls).toBe(1);
  });
});

describe("getEnforcementLevel", () => {
  test("defaults to observe; parses known values", () => {
    expect(getEnforcementLevel({})).toBe("observe");
    expect(getEnforcementLevel({ MAGISTER_LEADER_EXECUTION_POLICY_ENFORCEMENT: "off" })).toBe("off");
    expect(getEnforcementLevel({ MAGISTER_LEADER_EXECUTION_POLICY_ENFORCEMENT: "strict" })).toBe("strict");
  });
});

describe("buildSystemPromptWithPolicy", () => {
  test("buildSystemPromptWithPolicy appends the addendum to the base", () => {
    const p = classifyExecutionPolicy({ source: "web", availableRoles: ["coder"], prompt: "implement X" });
    const out = buildSystemPromptWithPolicy("BASE PROMPT", p, ["coder", "reviewer"]);
    expect(out).toContain("BASE PROMPT");
    expect(out).toContain("Execution policy for this turn");
  });
});

describe("escalateToDelegated", () => {
  const simple = classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "change the constant in a.ts" });
  test("escalates mode to delegated_coding with runtime_escalation source", () => {
    const escalated = escalateToDelegated(simple, "direct_simple budget exceeded at runtime");
    expect(escalated.mode).toBe("delegated_coding");
    expect(escalated.source).toBe("runtime_escalation");
    expect(escalated.reason).toBe("direct_simple budget exceeded at runtime");
  });
  test("sets mustDelegate: true and allowCodeWriteTools: false", () => {
    const escalated = escalateToDelegated(simple, "test reason");
    expect(escalated.constraints.mustDelegate).toBe(true);
    expect(escalated.constraints.allowCodeWriteTools).toBe(false);
  });
  test("preserves counters from the original policy", () => {
    const withCounters = updateExecutionPolicyAfterTool({
      policy: simple,
      toolName: "write_file",
      toolInput: { path: "a.ts", content: "x" },
      toolIsReadOnly: false,
      toolOutput: {},
      isError: false,
    });
    const escalated = escalateToDelegated(withCounters, "budget exceeded");
    expect(escalated.counters.writtenPaths).toContain("a.ts");
    expect(escalated.counters.writeToolCalls).toBe(1);
  });
  test("preserves other constraints (e.g. maxWriteFiles) from the original policy", () => {
    const escalated = escalateToDelegated(simple, "budget exceeded");
    expect(escalated.constraints.maxWriteFiles).toBe(simple.constraints.maxWriteFiles);
    expect(escalated.constraints.maxChangedLines).toBe(simple.constraints.maxChangedLines);
  });
  test("does not mutate the original policy", () => {
    escalateToDelegated(simple, "reason");
    expect(simple.mode).toBe("direct_simple");
    expect(simple.constraints.mustDelegate).toBe(false);
  });
});

describe("landing_required classification", () => {
  const base = { source: "web" as const, availableRoles: ["coder", "lander"] };

  test("release/deploy/PR phrasing → landing_required, must delegate, no git_commit", () => {
    for (const p of ["prepare the release", "deploy to prod", "push the PR", "发布上线"]) {
      const pol = classifyExecutionPolicy({ ...base, prompt: p });
      expect(pol.mode).toBe("landing_required");
      expect(pol.constraints.mustDelegate).toBe(true);
      expect(pol.constraints.allowGitCommit).toBe(false);
    }
  });

  test("plain 'commit and restart prod' is still ops_direct, not landing", () => {
    expect(classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "commit and restart prod" }).mode).toBe("ops_direct");
  });

  test("rollout / rollback / ship it / open a PR → landing_required", () => {
    for (const p of ["start the rollout", "rollback the deploy", "ship it", "open a PR for this"]) {
      const pol = classifyExecutionPolicy({ ...base, prompt: p });
      expect(pol.mode).toBe("landing_required");
      expect(pol.constraints.mustDelegate).toBe(true);
    }
  });

  test("landing_required disallows all mutating constraints", () => {
    const pol = classifyExecutionPolicy({ ...base, prompt: "deploy to prod" });
    expect(pol.constraints.allowCodeWriteTools).toBe(false);
    expect(pol.constraints.allowGitCommit).toBe(false);
    expect(pol.constraints.allowOpsBash).toBe(false);
    expect(pol.constraints.mustDelegate).toBe(true);
  });

  test("git_commit is denied in landing_required by evaluateToolCallAgainstExecutionPolicy", () => {
    const pol = classifyExecutionPolicy({ ...base, prompt: "deploy to prod" });
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: pol,
      toolName: "git_commit",
      toolInput: {},
      toolIsReadOnly: false,
      enforcement: "delegated_coding",
    });
    expect(result.allow).toBe(false);
  });

  test("modeIsEnforcedAtLevel landing_required at delegated_coding level is true", () => {
    expect(modeIsEnforcedAtLevel("landing_required", "delegated_coding")).toBe(true);
  });

  test("landing_required source is intake_rules", () => {
    const pol = classifyExecutionPolicy({ ...base, prompt: "prepare the release" });
    expect(pol.source).toBe("intake_rules");
  });
});

describe("applyHintsTightenOnly (via classifyExecutionPolicy)", () => {
  test("taskType:coding hint bumps a misread direct_answer toward delegation, never weakens", () => {
    // "what about the parser" → base is direct_answer; coding hint should bump it to delegated_coding
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: ["coder"],
      prompt: "what about the parser",
      taskManagerHints: { taskType: "coding" } as any,
    });
    expect(p.constraints.mustDelegate).toBe(true);
    expect(p.mode).toBe("delegated_coding");
  });

  test("hints never relax an explicit delegated_coding", () => {
    // "implement the pipeline" → base is delegated_coding; conversation hint must not weaken it
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: ["coder"],
      prompt: "implement the pipeline",
      plannerHints: { taskType: "conversation" } as any,
    });
    expect(p.mode).toBe("delegated_coding");
    expect(p.constraints.mustDelegate).toBe(true);
  });

  test("hints do NOT override explicit user direct_override", () => {
    // Override phrase + coding hint — direct_override must survive (user wins)
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: [],
      prompt: "你自己做，不要 subagent",
      taskManagerHints: { taskType: "coding" } as any,
    });
    expect(p.mode).toBe("direct_override");
  });

  test("direct_simple stays permissive even with coding hint (tiny edits ok)", () => {
    // "change the constant in a.ts" → base is direct_simple; coding hint must NOT bump it
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: [],
      prompt: "change the constant in a.ts",
      plannerHints: { taskType: "coding" } as any,
    });
    expect(p.mode).toBe("direct_simple");
    expect(p.constraints.mustDelegate).toBe(false);
  });

  test("needsHuman:true tightens a direct_answer to mustDelegate", () => {
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: [],
      prompt: "summarize the changes",
      plannerHints: { needsHuman: true } as any,
    });
    expect(p.constraints.mustDelegate).toBe(true);
    expect(p.constraints.allowCodeWriteTools).toBe(false);
  });

  test("stopCondition:review_ready tightens direct_answer to mustDelegate", () => {
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: [],
      prompt: "look at the diff",
      taskManagerHints: { stopCondition: "review_ready" } as any,
    });
    expect(p.constraints.mustDelegate).toBe(true);
  });

  test("coordinationAction:assign tightens direct_answer to delegated_coding", () => {
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: ["coder"],
      prompt: "handle the schema changes",
      plannerHints: { coordinationAction: "assign" } as any,
    });
    expect(p.constraints.mustDelegate).toBe(true);
  });

  test("hints do not tighten already-strict review_only", () => {
    // review_only is already mustDelegate:true; adding hints should not break it
    const p = classifyExecutionPolicy({
      source: "web",
      availableRoles: [],
      prompt: "review only, do not modify anything",
      taskManagerHints: { taskType: "coding" } as any,
    });
    expect(p.mode).toBe("review_only");
    expect(p.constraints.mustDelegate).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1: CJK classification regression tests
// ─────────────────────────────────────────────────────────────────────────────
describe("CJK classification (FIX 1)", () => {
  const base = { source: "web" as const, availableRoles: ["coder", "reviewer"] };

  test("中文 code-change '修复这个登录 bug' → delegated_coding, mustDelegate true", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "修复这个登录 bug" });
    expect(p.mode).toBe("delegated_coding");
    expect(p.constraints.mustDelegate).toBe(true);
  });

  test("中文 code-change '实现登录功能' → delegated_coding", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "实现登录功能" });
    expect(p.mode).toBe("delegated_coding");
    expect(p.constraints.mustDelegate).toBe(true);
  });

  test("中文 tiny-edit '把 a.ts 里的超时常量改成 5000' → direct_simple", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "把 a.ts 里的超时常量改成 5000" });
    expect(p.mode).toBe("direct_simple");
    expect(p.constraints.mustDelegate).toBe(false);
  });

  test("English 'fix the recall pipeline bug' still → delegated_coding", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "fix the recall pipeline bug" });
    expect(p.mode).toBe("delegated_coding");
  });

  test("English tiny 'change the timeout constant in config.ts to 5000' still → direct_simple", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "change the timeout constant in config.ts to 5000" });
    expect(p.mode).toBe("direct_simple");
  });

  test("其他 CJK code-change terms: 新增/重构/改造/改一下/实现一下 → delegated_coding", () => {
    for (const prompt of ["新增用户表", "重构这个模块", "改造这个接口", "把这个改一下", "实现一下用户注册"]) {
      const p = classifyExecutionPolicy({ ...base, prompt });
      expect(p.mode).toBe("delegated_coding");
      expect(p.constraints.mustDelegate).toBe(true);
    }
  });

  test("CJK tiny-edit: '把这一行改成 5000' → direct_simple", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "把这一行改成 5000" });
    expect(p.mode).toBe("direct_simple");
  });

  test("CJK tiny-edit: '把单行的配置改了' → direct_simple", () => {
    const p = classifyExecutionPolicy({ ...base, prompt: "把单行的配置改了" });
    expect(p.mode).toBe("direct_simple");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2: interpreter heredoc/stdin bypass regression tests
// ─────────────────────────────────────────────────────────────────────────────
describe("interpreter heredoc/stdin bash classification (FIX 2)", () => {
  const reviewOnlyPolicy = () => classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "review only, do not modify anything" });

  test("python heredoc write in review_only → blocked", () => {
    const cmd = "python - <<'PY'\nopen('a.ts','w').write('x')\nPY";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(false);
  });

  test("python3 heredoc write in review_only → blocked", () => {
    const cmd = "python3 - <<'PY'\nopen('a.ts','w')\nPY";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(false);
  });

  test("node heredoc write in review_only → blocked", () => {
    const cmd = "node - <<'JS'\nrequire('fs').writeFileSync('a.ts','x')\nJS";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(false);
  });

  test("bun heredoc write in review_only → blocked", () => {
    const cmd = "bun - <<'BUN'\nconsole.log('x')\nBUN";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(false);
  });

  test("python stdin mode (python -) in review_only → blocked", () => {
    const cmd = "python - < script.py";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(false);
  });

  test("general heredoc cat > file redirect in delegated_coding → blocked", () => {
    const cmd = "cat > a.ts <<MYEOF\nx\nMYEOF";
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: classifyExecutionPolicy({ source: "web", availableRoles: [], prompt: "implement the new pipeline" }),
      toolName: "bash",
      toolInput: { command: cmd },
      toolIsReadOnly: false,
      enforcement: "delegated_coding",
    });
    expect(result.allow).toBe(false);
  });

  test("bun test (verification) in review_only → still allowed", () => {
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: "bun test" },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(true);
  });

  test("bun run typecheck (verification) in review_only → still allowed", () => {
    const result = evaluateToolCallAgainstExecutionPolicy({
      policy: reviewOnlyPolicy(),
      toolName: "bash",
      toolInput: { command: "bun run typecheck" },
      toolIsReadOnly: false,
      enforcement: "review_only",
    });
    expect(result.allow).toBe(true);
  });

  test("isCodeMutatingBash: python heredoc is mutating", () => {
    expect(isCodeMutatingBash("python - <<'PY'\nopen('a.ts','w')\nPY")).toBe(true);
  });

  test("isCodeMutatingBash: bun test is NOT mutating", () => {
    expect(isCodeMutatingBash("bun test")).toBe(false);
  });

  test("isCodeMutatingBash: general heredoc is mutating", () => {
    expect(isCodeMutatingBash("cat > a.ts <<MYEOF\nx\nMYEOF")).toBe(true);
  });
});

describe("modeIsEnforcedAtLevel", () => {
  test("off and observe never block any mode", () => {
    const modes = ["direct_answer", "direct_simple", "ops_direct", "delegated_coding",
      "architect_required", "review_only", "landing_required", "direct_override"] as const;
    for (const mode of modes) {
      expect(modeIsEnforcedAtLevel(mode, "off")).toBe(false);
      expect(modeIsEnforcedAtLevel(mode, "observe")).toBe(false);
    }
  });

  test("review_only enforcement level blocks review_only and direct_simple but NOT delegated_coding or others", () => {
    expect(modeIsEnforcedAtLevel("review_only", "review_only")).toBe(true);
    expect(modeIsEnforcedAtLevel("direct_simple", "review_only")).toBe(true);
    expect(modeIsEnforcedAtLevel("delegated_coding", "review_only")).toBe(false);
    expect(modeIsEnforcedAtLevel("architect_required", "review_only")).toBe(false);
    expect(modeIsEnforcedAtLevel("landing_required", "review_only")).toBe(false);
    expect(modeIsEnforcedAtLevel("ops_direct", "review_only")).toBe(false);
    expect(modeIsEnforcedAtLevel("direct_override", "review_only")).toBe(false);
    expect(modeIsEnforcedAtLevel("direct_answer", "review_only")).toBe(false);
  });

  test("delegated_coding enforcement level also blocks delegated_coding, architect_required, landing_required", () => {
    expect(modeIsEnforcedAtLevel("review_only", "delegated_coding")).toBe(true);
    expect(modeIsEnforcedAtLevel("direct_simple", "delegated_coding")).toBe(true);
    expect(modeIsEnforcedAtLevel("delegated_coding", "delegated_coding")).toBe(true);
    expect(modeIsEnforcedAtLevel("architect_required", "delegated_coding")).toBe(true);
    expect(modeIsEnforcedAtLevel("landing_required", "delegated_coding")).toBe(true);
    expect(modeIsEnforcedAtLevel("ops_direct", "delegated_coding")).toBe(false);
    expect(modeIsEnforcedAtLevel("direct_override", "delegated_coding")).toBe(false);
    expect(modeIsEnforcedAtLevel("direct_answer", "delegated_coding")).toBe(false);
  });

  test("strict enforcement level blocks all modes", () => {
    const modes = ["direct_answer", "direct_simple", "ops_direct", "delegated_coding",
      "architect_required", "review_only", "landing_required", "direct_override"] as const;
    for (const mode of modes) {
      expect(modeIsEnforcedAtLevel(mode, "strict")).toBe(true);
    }
  });
});
