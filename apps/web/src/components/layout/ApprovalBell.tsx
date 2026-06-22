import { useCallback, useEffect, useRef, useState } from "react";

import { useWebSocket } from "../../hooks/useWebSocket";
import { request } from "../../lib/request";
import { useToastStore } from "../../stores/toastStore";
import "./ApprovalBell.css";

/**
 * ApprovalBell — pending-approval surface in the global topbar.
 *
 * - Bell glyph + red badge with count when approvals.length > 0.
 * - Click → dropdown lists each pending approval with inline
 *   `[Approve]` / `[Reject]` buttons. Resolution hits the spec'd
 *   DB-approval endpoints first (POST /approvals/:id/approve|reject);
 *   on 404 (in-memory command-gate approvals) falls back to the
 *   in-memory `/approvals/:id/resolve` route the bash-gate uses.
 *   This keeps the bell working for both approval families.
 * - Auto-refreshes on WS `approval.*` events.
 *
 * Spec: `docs/specs/2026-05-16-ui-redesign-p3-spec.md` §6.2.
 */

type PendingApproval = {
  id: string;
  taskId: string;
  toolName: string;
  summary?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: number;
  // Spec §1 V1.1: when the leader's bash tool requests
  // `sandbox_permissions: "require_escalated"` with a `prefix_rule`,
  // the approval payload carries `toolArgs.escalation` so the dialog
  // can surface a 3rd "Approve + save rule" button. Shape mirrors
  // what `manager-tools-adapter.ts:bash` writes into the payload.
  //
  // v4.3 update: the enum now includes "use_default" + "with_additional_permissions".
  // The "Approve + save rule" affordance below is INTENTIONALLY gated on
  // "require_escalated" only — request_permissions / with_additional_permissions
  // grants are batch-grant semantics that don't fit the argv-prefix rule
  // shape, so they auto-degrade to "Approve / Reject" without Save Rule.
  // The codex Slice-3 review noted this; current behavior is correct.
  toolArgs?: {
    command?: string;
    escalation?: {
      sandbox_permissions?: "default" | "use_default" | "with_additional_permissions" | "require_escalated";
      justification?: string;
      proposed_prefix_rule?: string[];
      proposed_scope?: "global" | "project" | "session";
      project_path?: string;
      request_kind?: "request_permissions";
    };
  };
};

function extractEscalation(a: PendingApproval): {
  prefix: string[];
  scope: string;
  justification: string;
} | null {
  const escalation = a.toolArgs?.escalation;
  if (!escalation) return null;
  // Gate: Save Rule ONLY applies to require_escalated bash with a proposed
  // prefix. v4.3 batch grants (with_additional_permissions, request_permissions)
  // skip this code path — they're persisted via the trust ledger, not as
  // argv-prefix rules.
  if (escalation.sandbox_permissions !== "require_escalated") return null;
  const prefix = escalation.proposed_prefix_rule;
  if (!Array.isArray(prefix) || prefix.length === 0) return null;
  return {
    prefix,
    scope: escalation.proposed_scope ?? "project",
    justification: escalation.justification ?? "",
  };
}

function shortTaskRef(taskId: string): string {
  // Magister task IDs are slugs like `task-mp7qdz5q-er143r` — no sequential
  // numbers. Show the last 6 alphanumerics for a stable visual handle
  // (mockup had `#093` but that was a fiction; real IDs have no such
  // index). Prefix with `…` to signal it's a tail, not a full id.
  const slug = taskId.replace(/[^a-zA-Z0-9]/g, "");
  if (slug.length <= 8) return slug || taskId;
  return `…${slug.slice(-6)}`;
}

function approvalSummary(a: PendingApproval): string {
  if (a.summary && a.summary.trim()) return a.summary.trim();
  if (a.toolName) return `${a.toolName} request`;
  return "Approval required";
}

// Sustained-outage suppression: the bell polls every 15s + every
// `approval.*` WS event. Without a guard, a backend outage would
// produce one error toast every poll cycle. Track the last error
// toast time and suppress new ones for `ERROR_TOAST_COOLDOWN_MS`.
// On the next successful poll we reset the timestamp so a future
// outage gets a fresh toast.
const ERROR_TOAST_COOLDOWN_MS = 5 * 60 * 1000; // 5 min

export function ApprovalBell() {
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const lastLoadErrorToastAt = useRef<number>(0);

  const load = useCallback(async () => {
    try {
      const data = await request<{ items?: PendingApproval[] }>(
        "/approvals/pending",
      );
      setApprovals(data.items ?? []);
      // Reset the suppression window once a poll succeeds so the next
      // outage gets a fresh toast instead of being silenced.
      lastLoadErrorToastAt.current = 0;
    } catch (err) {
      // Fail soft — leave previous list. Bell badge stale is preferable
      // to a thrash where it disappears and reappears on transient
      // network blips. Surface the error via toast on first failure +
      // every 5 min thereafter so sustained outages don't flood.
      const now = Date.now();
      if (now - lastLoadErrorToastAt.current < ERROR_TOAST_COOLDOWN_MS) return;
      lastLoadErrorToastAt.current = now;
      const message = err instanceof Error ? err.message : String(err);
      useToastStore.getState().push({
        kind: "error",
        title: "Failed to refresh approvals",
        body: message,
      });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(load, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const count = approvals.length;

  useEffect(() => {
    if (count === 0) setOpen(false);
  }, [count]);

  // WS subscription: any event whose type starts with `approval.`
  // OR `leader.approval_` triggers a refetch. The two prefixes cover
  // the two emit sites — `approval-service` (web-card route) emits
  // `approval.resolved`; `command-approval-service` (bash/MCP gated
  // path) emits `leader.approval_requested` / `leader.approval_resolved`.
  // Previously this only matched `approval.*`, so an approval
  // gated/resolved through the command-service path never refreshed
  // the bell — operator saw a stale counter until the 30s interval
  // poll. Cheap (one HTTP call per event burst).
  useWebSocket({
    onEvent: (event) => {
      if (typeof event.type !== "string") return;
      if (event.type.startsWith("approval.") || event.type.startsWith("leader.approval_")) {
        void load();
      }
    },
  });

  // Close popover on outside click + Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popoverRef.current) return;
      if (!popoverRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const resolve = useCallback(
    async (id: string, kind: "approve" | "reject" | "approve-save") => {
      setPendingIds((prev) => new Set(prev).add(id));
      try {
        // Spec §1 V1.1: the `approve-save` variant uses the /resolve
        // route exclusively because save_rule is a command-approval-
        // service feature and the DB-approval endpoints don't carry
        // the escalation metadata it needs. Plain approve/reject still
        // tries the DB endpoints first for legacy compat.
        if (kind === "approve-save") {
          // The resolve route returns `data.ruleSave: { status:
          // "persisted" | "skipped" | "failed", error? }`. When save_rule
          // was requested but the server refused to persist (banned prefix
          // re-validation, malformed metadata, etc.) we have to tell the
          // user — otherwise the optimistic UI removal makes it look like
          // the rule was saved.
          const resp = await request<{
            ruleSave?: { status: "persisted" | "skipped" | "failed"; error?: string };
          }>(`/approvals/${encodeURIComponent(id)}/resolve`, {
            method: "POST",
            body: JSON.stringify({
              decision: "approved",
              save_rule: true,
            }),
          });
          if (resp?.ruleSave?.status === "failed") {
            useToastStore.getState().push({
              kind: "warning",
              title: "Approved, but rule not saved",
              body: resp.ruleSave.error
                ?? "Server refused to persist the prefix rule. The command was still approved for this run.",
            });
          }
        } else {
          // Try the DB-approval endpoints from the spec first. These
          // 404 for in-memory command-gate approvals — fall back to the
          // /resolve route (same shape, different body) for those.
          try {
            await request(`/approvals/${encodeURIComponent(id)}/${kind}`, {
              method: "POST",
              body: JSON.stringify({ source: "web" }),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes("not_found") || message.includes("404")) {
              await request(`/approvals/${encodeURIComponent(id)}/resolve`, {
                method: "POST",
                body: JSON.stringify({
                  decision: kind === "approve" ? "approved" : "rejected",
                }),
              });
            } else {
              throw err;
            }
          }
        }
        // Optimistic remove; the next WS event or interval poll
        // reconciles if the server says otherwise.
        setApprovals((prev) => prev.filter((a) => a.id !== id));
      } catch (err) {
        // Stay open; user can retry. Surface the failure so they
        // know the click didn't take effect.
        const message = err instanceof Error ? err.message : String(err);
        useToastStore.getState().push({
          kind: "error",
          title: "Failed to resolve approval",
          body: message,
        });
      } finally {
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [],
  );

  const buttonLabel = count > 0
    ? `Command approvals (${count} pending)`
    : "No command approvals pending";

  return (
    <div className="magister-approval-bell" ref={popoverRef}>
      <button
        type="button"
        className="magister-approval-bell__btn"
        aria-label={buttonLabel}
        aria-expanded={count > 0 ? open : false}
        aria-haspopup={count > 0 ? "dialog" : undefined}
        title={count > 0 ? "Command approvals" : "No command approvals pending"}
        data-empty={count === 0 ? "true" : undefined}
        onClick={() => {
          if (count > 0) setOpen((v) => !v);
        }}
      >
        <span className="magister-approval-bell__glyph" aria-hidden="true">
          ⚑
        </span>
        {count > 0 ? (
          <span className="magister-approval-bell__badge" aria-hidden="true">
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>

      {open && count > 0 ? (
        <div
          className="magister-approval-bell__popover"
          role="dialog"
          aria-label="Command approvals"
        >
          <header className="magister-approval-bell__head">
            <span>Command Approvals</span>
            <span className="magister-approval-bell__count">{count}</span>
          </header>
          <ul className="magister-approval-bell__list">
            {approvals.map((a) => {
              const busy = pendingIds.has(a.id);
              const escalation = extractEscalation(a);
              return (
                <li key={a.id} className="magister-approval-bell__row">
                  <div className="magister-approval-bell__row-text">
                    <code className="magister-approval-bell__tool">
                      {a.toolName || "tool"}
                    </code>
                    <span className="magister-approval-bell__summary">
                      {approvalSummary(a)}
                    </span>
                    <code
                      className="magister-approval-bell__taskref"
                      title={a.taskId}
                    >
                      {shortTaskRef(a.taskId)}
                    </code>
                    {escalation ? (
                      <div className="magister-approval-bell__escalation">
                        <span className="magister-approval-bell__escalation-label">
                          Save as rule:
                        </span>
                        <code className="magister-approval-bell__escalation-prefix">
                          {escalation.prefix.join(" ")}
                        </code>
                        <span className="magister-approval-bell__escalation-scope">
                          ({escalation.scope})
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="magister-approval-bell__actions">
                    {escalation ? (
                      <button
                        type="button"
                        className="magister-btn magister-btn--approve-save"
                        onClick={() => void resolve(a.id, "approve-save")}
                        disabled={busy}
                        title={`Approve and persist "${escalation.prefix.join(" ")}" as a ${escalation.scope}-scope rule so matching future commands auto-pass.`}
                      >
                        {busy ? "…" : "Approve + save rule"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="magister-btn magister-btn--approve"
                      onClick={() => void resolve(a.id, "approve")}
                      disabled={busy}
                    >
                      {busy ? "…" : "Approve once"}
                    </button>
                    <button
                      type="button"
                      className="magister-btn magister-btn--reject"
                      onClick={() => void resolve(a.id, "reject")}
                      disabled={busy}
                    >
                      Reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
