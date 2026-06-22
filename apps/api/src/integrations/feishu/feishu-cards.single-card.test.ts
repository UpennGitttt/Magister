import { describe, expect, it } from "bun:test";
import {
  buildSingleTurnCardInitial,
  buildFinalCard,
  renderAnswerBody,
  renderToolsBody,
  ANSWER_ELEMENT,
  TOOLS_BODY_ELEMENT,
  TOOLS_PANEL_ELEMENT,
  type TurnState,
} from "./feishu-cards";

describe("buildSingleTurnCardInitial", () => {
  it("declares collapsible tools panel + answer element with tuned streaming", () => {
    const card = buildSingleTurnCardInitial({ title: "🧠 Leader", summary: "[Working…]" });
    expect(card.schema).toBe("2.0");
    const cfg = card.config as Record<string, any>;
    expect(cfg.streaming_mode).toBe(true);
    expect(cfg.streaming_config.print_step.default).toBe(4);
    expect(cfg.streaming_config.print_frequency_ms.default).toBe(30);

    const els = card.body.elements as any[];
    const panel = els.find((e) => e.element_id === TOOLS_PANEL_ELEMENT);
    expect(panel.tag).toBe("collapsible_panel");
    expect(panel.expanded).toBe(false);
    const toolsBody = panel.elements.find((e: any) => e.element_id === TOOLS_BODY_ELEMENT);
    expect(toolsBody.tag).toBe("markdown");
    const answer = els.find((e) => e.element_id === ANSWER_ELEMENT);
    expect(answer.tag).toBe("markdown");
    expect(answer.content).toBe("⏳ Thinking…");
  });
});

describe("renderAnswerBody", () => {
  it("returns placeholder when empty, answer text otherwise", () => {
    expect(renderAnswerBody({ answer: "", tools: [], media: [] })).toBe("⏳ Thinking…");
    expect(renderAnswerBody({ answer: "hello", tools: [], media: [] })).toBe("hello");
  });
});

describe("renderToolsBody", () => {
  const tools: TurnState["tools"] = [
    { toolUseId: "t1", icon: "🔧", name: "bash", argsInline: "ls -la", resultInline: "exit 0" },
    { toolUseId: "t2", icon: "📖", name: "read_file", argsInline: "config.ts", resultInline: null },
  ];
  it("off → empty marker (panel suppressed by session, but renderer is safe)", () => {
    expect(renderToolsBody({ answer: "", tools, media: [] }, "off")).toBe("（暂无）");
  });
  it("low → call lines only, with count header", () => {
    const out = renderToolsBody({ answer: "", tools, media: [] }, "low");
    expect(out).toContain("**2 个工具**");
    expect(out).toContain("🔧 `bash` · ls -la");
    expect(out).not.toContain("exit 0");
  });
  it("high → call lines + result sub-line", () => {
    const out = renderToolsBody({ answer: "", tools, media: [] }, "high");
    expect(out).toContain("🔧 `bash` · ls -la");
    expect(out).toContain("↳ exit 0");
  });
});

describe("buildFinalCard", () => {
  it("streaming off, footer summary, inline image element appended after answer", () => {
    const card = buildFinalCard({
      state: {
        answer: "结果如下",
        tools: [{ toolUseId: "t1", icon: "🔧", name: "bash", argsInline: "bun test", resultInline: "exit 0" }],
        media: [{ kind: "image", imageKey: "img_xyz", filename: "chart.png" }],
      },
      verboseLevel: "high",
      footer: "✅ done",
      template: "green",
    });
    const cfg = card.config as Record<string, any>;
    expect(cfg.streaming_mode).toBe(false);
    expect((card.header as any).template).toBe("green");
    const els = card.body.elements as any[];
    const answer = els.find((e) => e.element_id === "answer");
    expect(answer.content).toContain("结果如下");
    expect(answer.content).toContain("*✅ done*");
    const img = els.find((e) => e.tag === "img");
    expect(img.img_key).toBe("img_xyz");
  });

  it("verboseLevel off with non-empty tools → no collapsible_panel element", () => {
    const card = buildFinalCard({
      state: {
        answer: "答案",
        tools: [{ toolUseId: "t1", icon: "🔧", name: "bash", argsInline: "ls", resultInline: "exit 0" }],
        media: [],
      },
      verboseLevel: "off",
    });
    const els = card.body.elements as any[];
    expect(els.some((e) => e.tag === "collapsible_panel")).toBe(false);
  });

  it("no footer → answer content equals renderAnswerBody output, summary is 'Done'", () => {
    const state: TurnState = { answer: "纯文字", tools: [], media: [] };
    const card = buildFinalCard({ state, verboseLevel: "low" });
    const els = card.body.elements as any[];
    const answer = els.find((e) => e.element_id === ANSWER_ELEMENT);
    expect(answer.content).toBe(renderAnswerBody(state));
    expect(answer.content).not.toMatch(/^\*.+\*$/);
    const cfg = card.config as Record<string, any>;
    expect(cfg.summary.content).toBe("Done");
  });

  it("kind: file media item → markdown element with 📎 and filename", () => {
    const card = buildFinalCard({
      state: {
        answer: "done",
        tools: [],
        media: [{ kind: "file", filename: "report.pdf" }],
      },
      verboseLevel: "low",
    });
    const els = card.body.elements as any[];
    const fileEl = els.find((e) => e.tag === "markdown" && typeof e.content === "string" && e.content.includes("📎"));
    expect(fileEl).toBeTruthy();
    expect(fileEl.content).toContain("report.pdf");
  });
});
