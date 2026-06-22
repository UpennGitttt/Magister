import type { StatusReport } from "../../lib/types";
import { formatRuntimeLabel } from "../../lib/runtimeLabels";

/**
 * Flatten a `StatusReport` into a compact text block for inline
 * rendering in the chat conversation (via SystemPart variant="status").
 *
 * Two-part output:
 *   - `headline` — one short summary line shown in the system-notice
 *     header (e.g. "/status · leader · feat/branch · 2 agents · 1 MCP")
 *   - `detail` — multi-line monospace body with section blocks. The
 *     receiver renders this in a fixed-width font so the agent table
 *     and MCP list align.
 *
 * Mirrors what `StatusPanel.tsx` used to render — workspace + agents
 * + MCP + skills + (when present) the per-session block — but in plain
 * text so it can live in a chat bubble without needing JSX.
 */
export function formatStatusReportForChat(
  report: StatusReport,
  taskId: string | null,
): { headline: string; detail: string } {
  const session = report.currentSession;
  const branch = report.workspace.git.branch ?? "(no git)";
  const leader = report.agents.find((a) => a.roleId === "leader");
  const summaryParts: string[] = ["/status"];
  if (leader?.modelName) {
    summaryParts.push(leader.modelName);
  }
  summaryParts.push(branch);
  summaryParts.push(`${report.agents.length} agents`);
  if (report.mcp.length > 0) {
    summaryParts.push(`${report.mcp.length} MCP`);
  }
  if (session) {
    summaryParts.push(`task ${shortId(session.taskId)}`);
  }
  const headline = summaryParts.join(" · ");

  const lines: string[] = [];

  if (session) {
    lines.push("── current session ──────────────────────────────");
    lines.push(`task        ${session.taskId}`);
    lines.push(`state       ${session.state}`);
    if (session.title) lines.push(`title       ${truncate(session.title, 70)}`);
    if (session.agent) {
      lines.push(
        `agent       ${session.agent.label} (${session.agent.roleId}) · ${
          formatRuntimeLabel(session.agent.runtimeType)
        }`,
      );
      if (session.agent.modelName) {
        lines.push(
          `model       ${session.agent.modelName}${
            session.agent.providerLabel ? ` · ${session.agent.providerLabel}` : ""
          }`,
        );
      }
    }
    const tu = session.tokenUsage;
    if (tu.tracked) {
      lines.push(
        `tokens      in ${formatNumber(tu.inputTokens)} · out ${formatNumber(
          tu.outputTokens,
        )} · ${tu.turnCount} turn${tu.turnCount === 1 ? "" : "s"}${
          tu.models.length > 0 ? ` · ${tu.models.join(", ")}` : ""
        }`,
      );
    } else {
      lines.push(`tokens      (no usage tracked since restart)`);
    }
    lines.push(`started     ${formatIso(session.startedAt)}`);
    lines.push("");
  } else if (taskId) {
    lines.push(`── current session ──`);
    lines.push(`task ${taskId} not found or unavailable.`);
    lines.push("");
  }

  lines.push("── workspace ───────────────────────────────────");
  lines.push(`cwd         ${report.workspace.cwd}`);
  lines.push(
    `branch      ${
      report.workspace.git.branch
        ? `${report.workspace.git.branch}${
            report.workspace.git.isClean === false ? " (dirty)" : ""
          }`
        : "(not a git repo)"
    }`,
  );
  lines.push(
    `AGENTS.md   ${
      report.workspace.agentsFile.found && report.workspace.agentsFile.path
        ? report.workspace.agentsFile.path
        : "(not found)"
    }`,
  );
  if (report.activeWorkspace) {
    lines.push(
      `workspace   ${report.activeWorkspace.label} (${report.activeWorkspace.id})`,
    );
  }
  lines.push("");

  lines.push(`── agents (${report.agents.length}) ────────────────────────────────`);
  const agentRows = report.agents.map((a) => ({
    label: `${a.label}${a.label === a.roleId ? "" : ` (${a.roleId})`}`,
    runtime: formatRuntimeLabel(a.runtimeType),
    model: a.modelName ?? "—",
    provider: a.providerLabel ?? "—",
    skills: String(a.skillsCount),
    mcp: String(a.mcpServersCount),
  }));
  if (agentRows.length === 0) {
    lines.push("(no agents configured)");
  } else {
    const widths = {
      label: Math.max(5, ...agentRows.map((r) => r.label.length)),
      runtime: Math.max(7, ...agentRows.map((r) => r.runtime.length)),
      model: Math.max(5, ...agentRows.map((r) => r.model.length)),
      provider: Math.max(8, ...agentRows.map((r) => r.provider.length)),
    };
    lines.push(
      `${"role".padEnd(widths.label)}  ${"runtime".padEnd(
        widths.runtime,
      )}  ${"model".padEnd(widths.model)}  ${"provider".padEnd(
        widths.provider,
      )}  skills  mcp`,
    );
    for (const r of agentRows) {
      lines.push(
        `${r.label.padEnd(widths.label)}  ${r.runtime.padEnd(
          widths.runtime,
        )}  ${r.model.padEnd(widths.model)}  ${r.provider.padEnd(
          widths.provider,
        )}  ${r.skills.padStart(6)}  ${r.mcp.padStart(3)}`,
      );
    }
  }
  lines.push("");

  lines.push(`── MCP servers (${report.mcp.length}) ─────────────────────────`);
  if (report.mcp.length === 0) {
    lines.push("(none registered — add one in Settings → MCP)");
  } else {
    for (const s of report.mcp) {
      const dot = s.status === "connected" ? "●" : s.status === "error" ? "✗" : "○";
      const tools =
        typeof s.toolCount === "number" ? ` · ${s.toolCount} tools` : "";
      const err = s.lastError ? `  err: ${truncate(s.lastError, 80)}` : "";
      lines.push(`${dot} ${s.name.padEnd(24)}  ${s.status}${tools}${err}`);
    }
  }
  lines.push("");

  lines.push(
    `── skills · ${report.skills.total} attached (github ${report.skills.bySource.github} · manual ${report.skills.bySource.manual}) ──`,
  );

  if (report.activeTasks.length > 0) {
    lines.push("");
    lines.push(
      `── active tasks (${report.activeTasks.length}) ─────────────────────────`,
    );
    for (const t of report.activeTasks) {
      lines.push(
        `${t.state.padEnd(10)}  ${shortId(t.id)}  ${truncate(
          t.title ?? "(untitled)",
          60,
        )}`,
      );
    }
  }

  return { headline, detail: lines.join("\n") };
}

function shortId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function formatNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatIso(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const Y = d.getFullYear();
    const M = String(d.getMonth() + 1).padStart(2, "0");
    const D = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${Y}-${M}-${D} ${h}:${m}`;
  } catch {
    return iso;
  }
}
