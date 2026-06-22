import { expect, test } from "bun:test";
import {
  buildApprovalBodyMarkdown,
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildCallbackResponse,
  buildFailureCard,
  buildStreamingCardInitial,
  formatToolArgs,
  formatToolResult,
  renderStreamingBody,
  STREAMING_CONTENT_ELEMENT,
} from "../../../src/integrations/feishu/feishu-cards";

test("buildStreamingCardInitial declares single content element", () => {
  const card = buildStreamingCardInitial({}) as {
    schema: string;
    body: { elements: Array<{ element_id?: string; tag?: string }> };
  };
  expect(card.schema).toBe("2.0");
  expect(card.body.elements).toHaveLength(1);
  expect(card.body.elements[0]!.element_id).toBe(STREAMING_CONTENT_ELEMENT);
  expect(card.body.elements[0]!.tag).toBe("markdown");
});

test("formatToolArgs bash returns fenced code block", () => {
  const out = formatToolArgs("bash", { command: "git status" });
  expect(out).toContain("```bash");
  expect(out).toContain("git status");
  expect(out).toContain("```");
});

test("formatToolArgs read_file with line range", () => {
  const out = formatToolArgs("read_file", {
    path: "apps/foo.ts",
    startLine: 10,
    endLine: 50,
  });
  expect(out).toBe("`apps/foo.ts` (L10–L50)");
});

test("formatToolArgs grep with path", () => {
  const out = formatToolArgs("grep", { query: "TODO", path: "src/" });
  expect(out).toBe("`TODO` in `src/`");
});

test("formatToolArgs web_fetch extracts host", () => {
  const out = formatToolArgs("web_fetch", { url: "https://example.com/foo/bar?baz=1" });
  expect(out).toBe("`example.com/foo/bar?baz=1`");
});

test("formatToolArgs unknown tool falls back to key=value", () => {
  const out = formatToolArgs("custom_xyz", { a: 1, b: "two" });
  expect(out).toContain("a=1");
  expect(out).toContain("b=two");
});

test("formatToolResult bash with exit code + stdout", () => {
  const out = formatToolResult("bash", { exit_code: 0, stdout: "all clean\nmore\nstuff" });
  expect(out).toBe("exit 0 · all clean");
});

test("formatToolResult string multi-line shows head + count", () => {
  const out = formatToolResult("bash", "line1\nline2\nline3\nline4\nline5");
  expect(out).toContain("line1");
  expect(out).toContain("… 2 more lines");
});

test("renderStreamingBody empty state", () => {
  expect(renderStreamingBody({ tools: [], answer: "" })).toBe("⏳ Thinking…");
});

test("renderStreamingBody ignores tools entries — card body is answer-only", () => {
  // 2026-05-18 refactor: tool calls/results are surfaced as standalone
  // chat messages, not embedded in the streaming card body. The
  // `tools` field on StreamingState is kept for type stability but is
  // intentionally ignored by the renderer.
  const out = renderStreamingBody({
    tools: [
      { toolUseId: "t1", toolName: "bash", argsBlock: "```bash\nls\n```", resultLine: "exit 0" },
    ],
    answer: "",
  });
  expect(out).toBe("⏳ Thinking…");
});

test("renderStreamingBody answer-only", () => {
  const out = renderStreamingBody({
    tools: [
      { toolUseId: "t1", toolName: "bash", argsBlock: null, resultLine: null },
    ],
    answer: "Final response text",
  });
  expect(out).toBe("Final response text");
});

test("buildApprovalCard has Approve + Reject buttons with envelope value", () => {
  const env = { approve: { oc: "ocf1", a: "approval.approve" }, reject: { oc: "ocf1", a: "approval.reject" } };
  const card = buildApprovalCard({
    envelope: env,
    toolName: "bash",
    bodyMarkdown: "**bash**\n`rm -rf /tmp/test`",
    ttlMinutes: 5,
    taskIdShort: "abc12345",
  }) as { elements: Array<{ tag: string; actions?: Array<{ value: { envelope: string } }> }> };
  // Find action element
  const action = card.elements.find((e) => e.tag === "action");
  expect(action).toBeDefined();
  expect(action!.actions).toHaveLength(2);
  // Envelope JSON-stringified for v1.0 value compatibility
  const approve = JSON.parse(action!.actions![0]!.value.envelope);
  expect(approve.oc).toBe("ocf1");
  expect(approve.a).toBe("approval.approve");
});

test("buildApprovalCard isQuestion swaps button labels", () => {
  const card = buildApprovalCard({
    envelope: { approve: {}, reject: {} },
    toolName: "request_human_input",
    bodyMarkdown: "Pick yes or no",
    isQuestion: true,
    ttlMinutes: 30,
    taskIdShort: "xyz",
  }) as { elements: Array<{ actions?: Array<{ text: { content: string } }> }>; header: { template: string } };
  const action = card.elements.find((e) => e.actions);
  expect(action!.actions![0]!.text.content).toContain("Continue");
  expect(action!.actions![1]!.text.content).toContain("Stop");
  expect(card.header.template).toBe("indigo");
});

test("buildApprovalResolvedCard renders state header", () => {
  const card = buildApprovalResolvedCard({
    state: "approved",
    resolvedBy: "alice",
    toolName: "bash",
    bodyMarkdown: "**bash**",
    resolvedAtMs: Date.parse("2026-05-18T10:00:00Z"),
  }) as { header: { title: { content: string }; template: string } };
  expect(card.header.title.content).toBe("✅ Approved");
  expect(card.header.template).toBe("green");
});

test("buildApprovalResolvedCard rejected shows red template", () => {
  const card = buildApprovalResolvedCard({
    state: "rejected",
    resolvedBy: "bob",
    toolName: "bash",
    bodyMarkdown: "**bash**",
    resolvedAtMs: Date.now(),
  }) as { header: { title: { content: string }; template: string } };
  expect(card.header.title.content).toBe("❌ Rejected");
  expect(card.header.template).toBe("red");
});

test("buildCallbackResponse wraps card in {type:'raw', data}", () => {
  const inner = { dummy: true };
  const out = buildCallbackResponse({
    replacementCard: inner,
    toastType: "success",
    toastContent: "Approved",
  }) as { toast: { type: string; content: string }; card: { type: string; data: object } };
  expect(out.toast.type).toBe("success");
  expect(out.toast.content).toBe("Approved");
  expect(out.card.type).toBe("raw");
  expect(out.card.data).toBe(inner);
});

test("buildApprovalBodyMarkdown for normal approval", () => {
  const md = buildApprovalBodyMarkdown({
    toolName: "bash",
    command: "rm -rf /tmp",
    reason: "dangerous",
    summary: "Dangerous bash command",
    isQuestion: false,
  });
  expect(md).toContain("**bash**");
  expect(md).toContain("```");
  expect(md).toContain("rm -rf /tmp");
  expect(md).toContain("**Reason:** dangerous");
});

test("buildApprovalBodyMarkdown for question", () => {
  const md = buildApprovalBodyMarkdown({
    toolName: "request_human_input",
    command: null,
    reason: null,
    summary: "Are you sure?",
    isQuestion: true,
  });
  expect(md).toContain("Leader needs input");
  expect(md).toContain("Are you sure?");
  expect(md).not.toContain("**request_human_input**");
});

test("buildFailureCard task failed renders red header", () => {
  const card = buildFailureCard({
    kind: "failed",
    taskIdShort: "abcd1234",
    reason: "boom",
  }) as { header: { title: { content: string }; template: string } };
  expect(card.header.title.content).toBe("❌ Task failed");
  expect(card.header.template).toBe("red");
});
