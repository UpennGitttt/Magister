import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const cssByFile = new Map<string, string>();

function css(file: string): string {
  let content = cssByFile.get(file);
  if (!content) {
    content = readFileSync(join(import.meta.dir, file), "utf8");
    cssByFile.set(file, content);
  }
  return content;
}

function ruleBodies(file: string, selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Array.from(css(file).matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g")))
    .map((match) => match[1] ?? "");
}

describe("mobile session drawer close button", () => {
  test("centers the close glyph inside a square touch target", () => {
    const body = ruleBodies("chat.css", ".chat-page__mobile-close-btn").join("\n");

    expect(body).toContain("display: inline-flex");
    expect(body).toContain("align-items: center");
    expect(body).toContain("justify-content: center");
    expect(body).toContain("width: var(--touch-target-min, 40px)");
    expect(body).toContain("height: var(--touch-target-min, 40px)");
  });
});

describe("close icon alignment audit", () => {
  const iconButtons = [
    ["chat.css", ".chat-page__mobile-bar-btn"],
    ["chat.css", ".chat-page__session-search-clear"],
    ["chat.css", ".change-review-dialog__close"],
    ["chat.css", ".chat-send-error__dismiss"],
    ["chat.css", ".chat-input-bar__attachment-remove"],
    ["chat.css", ".teammate-drawer__close"],
    ["chat.css", ".slash-menu__close"],
    ["../components/layout/NewTaskButton.css", ".magister-new-task-dialog__close"],
    ["../components/ui/ToastStack.css", ".magister-toast__close"],
    ["../components/trace/FullTraceModal.css", ".trace-modal-close"],
    ["sidebar.css", ".modal-header button"],
  ] as const;

  for (const [file, selector] of iconButtons) {
    test(`${selector} centers its glyph`, () => {
      const body = ruleBodies(file, selector).join("\n");

      expect(body).toContain("display: inline-flex");
      expect(body).toContain("align-items: center");
      expect(body).toContain("justify-content: center");
      expect(body).toContain("line-height: 1");
    });
  }
});

describe("sessions panel header layout", () => {
  test("keeps session counts in a bounded column beside the new button", () => {
    const panelHead = ruleBodies("chat.css", ".chat-page__panel-head").join("\n");
    const title = ruleBodies("chat.css", ".chat-page__panel-head-title").join("\n");
    const actions = ruleBodies("chat.css", ".chat-page__panel-head-actions").join("\n");

    expect(panelHead).toContain("display: grid");
    expect(panelHead).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(title).toContain("flex-wrap: wrap");
    expect(actions).toContain("display: flex");
    expect(actions).not.toContain("display: contents");
  });
});

describe("conversation attention strip density", () => {
  test("keeps approval and change-review chrome compact above the transcript", () => {
    const narrative = ruleBodies("chat.css", ".chat-workbench-narrative").join("\n");
    const reviewBar = ruleBodies("chat.css", ".change-review-bar").join("\n");

    expect(narrative).toContain("margin: 6px 16px 0");
    expect(narrative).toContain("padding: 7px 10px");
    expect(reviewBar).toContain("border-top: 1px solid var(--border)");
    expect(reviewBar).toContain("padding: 8px 16px");
  });
});
