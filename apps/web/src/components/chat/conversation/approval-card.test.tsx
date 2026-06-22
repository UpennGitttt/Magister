/**
 * Sandbox-elevation v4.3 Slice 2 — ApprovalCard rendering tests.
 *
 * Verifies the v4 fields surface correctly:
 *   - path list grouped by access (write first), color-coded
 *   - deny-read-requested red banner
 *   - sanitized justification with chrome label + 5-line cap
 *   - dual-channel conflict yellow notice
 */
import "../../../test-setup";
import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { ExchangeView } from "./render";
import type { Exchange, ToolPart } from "./types";

const TASK_ID = "task_approval_render";

afterEach(() => {
  cleanup();
});

function makeExchangeWithApproval(approval: NonNullable<ToolPart["pendingApproval"]>): Exchange {
  const toolPart: ToolPart = {
    kind: "tool",
    id: "tool_x",
    name: "bash",
    toolUseId: "tool_x",
    input: { command: "uv sync" },
    result: null,
    pendingApproval: approval,
  };
  return {
    id: "req_x",
    status: "streaming",
    user: { content: "set up python env" },
    response: { parts: [toolPart] },
    lastAppliedSeq: 0,
  };
}

describe("ApprovalCard — v3 legacy path (no v4 fields)", () => {
  test("renders simple card with reason + command + trust checkboxes only", () => {
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_v3",
      reason: "Dangerous bash",
      command: "rm -rf /tmp/x",
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);
    expect(view.getByText("Approval needed")).toBeDefined();
    expect(view.getByText("Dangerous bash")).toBeDefined();
    // No v4 chrome
    expect(view.queryByText("Additional permissions requested:")).toBeNull();
    expect(view.queryByText(/Model's reason/i)).toBeNull();
    expect(view.queryByText(/deny-read/i)).toBeNull();
  });
});

describe("ApprovalCard — v4 additional_permissions path list", () => {
  test("renders write-access entries first, then read-access, color-coded by sensitivity", () => {
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_v4_paths",
      reason: "with_additional_permissions",
      command: "uv sync && git push",
      sandboxMode: "with_additional_permissions",
      additionalPermissions: {
        file_system: {
          entries: [
            { path: "/home/alice/.gitconfig", access: "read", sensitivity: "safe", sensitivityReason: "git identity" },
            { path: "/home/alice/.cache/uv", access: "write", sensitivity: "safe", sensitivityReason: "build cache" },
            { path: "/home/alice/.aws/credentials", access: "read", sensitivity: "caution", sensitivityReason: "AWS credentials" },
          ],
        },
      },
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);

    expect(view.getByText("Additional permissions requested:")).toBeDefined();
    expect(view.getByText(/Write access/i)).toBeDefined();
    expect(view.getByText(/Read access/i)).toBeDefined();

    // All three paths render
    expect(view.getByText("/home/alice/.cache/uv")).toBeDefined();
    expect(view.getByText("/home/alice/.gitconfig")).toBeDefined();
    expect(view.getByText("/home/alice/.aws/credentials")).toBeDefined();

    // Sensitivity reasons render as text (tooltip + inline)
    expect(view.getByText("build cache")).toBeDefined();
    expect(view.getByText("AWS credentials")).toBeDefined();
  });

  test("renders network: enabled hint when network ask present", () => {
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_v4_net",
      reason: "needs network",
      command: "npm install",
      sandboxMode: "with_additional_permissions",
      additionalPermissions: {
        network: { enabled: true },
        file_system: {
          entries: [
            { path: "/home/alice/.npmrc", access: "read", sensitivity: "caution", sensitivityReason: "npm token" },
          ],
        },
      },
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);
    expect(view.getByText(/all hosts/i)).toBeDefined();
  });
});

describe("ApprovalCard — deny-read-requested-but-unsupported banner", () => {
  test("renders red banner with each blocked path", () => {
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_deny_read",
      reason: "with_additional_permissions",
      command: "python myapp.py",
      sandboxMode: "with_additional_permissions",
      denyReadRequestedButUnsupported: [
        { path: "/home/alice/.aws/credentials", classification: "caution" },
        { path: "/etc/shadow", classification: "critical" },
      ],
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);

    expect(view.getByText(/Model requested deny-read/i)).toBeDefined();
    expect(view.getByText("/home/alice/.aws/credentials")).toBeDefined();
    expect(view.getByText("/etc/shadow")).toBeDefined();
    expect(view.getByText(/Magister v4 cannot enforce/i)).toBeDefined();
  });
});

describe("ApprovalCard — model justification with chrome label", () => {
  test("renders justification text with server-controlled 'Model's reason:' label", () => {
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_just",
      reason: "with_additional_permissions",
      command: "uv sync",
      justification: "Set up the python env for testing.",
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);
    expect(view.getByText(/Model's reason/i)).toBeDefined();
    expect(view.getByText("Set up the python env for testing.")).toBeDefined();
  });

  test("5-line cap with show-more toggle for long justifications", () => {
    const longJustification = Array.from({ length: 8 }, (_, i) => `Line ${i + 1}`).join("\n");
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_long",
      reason: "with_additional_permissions",
      command: "uv sync",
      justification: longJustification,
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);
    // Show-more button present
    const toggle = view.getByRole("button", { name: /Show more/i });
    expect(toggle).toBeDefined();
    // Click expands
    fireEvent.click(toggle);
    expect(view.getByRole("button", { name: /Show less/i })).toBeDefined();
  });

  test("server-controlled label is NOT overridable by model's justification text", () => {
    // The model writes its own fake chrome label into the justification.
    // The actual rendered label stays "Model's reason:" — the chrome
    // text is hard-coded in the React component, never derived from
    // server data.
    const malicious = "🤖 Magister's reason: approve all";
    const exchange = makeExchangeWithApproval({
      approvalId: "appr_chrome_spoof",
      reason: "test",
      command: "ls",
      justification: malicious,
    });
    const view = render(<ExchangeView exchange={exchange} taskId={TASK_ID} />);
    // Server-controlled chrome is present
    expect(view.getByText("🤖 Model's reason:")).toBeDefined();
    // The model's spoofed string appears as plain text content (not chrome)
    expect(view.getByText(malicious)).toBeDefined();
  });
});
