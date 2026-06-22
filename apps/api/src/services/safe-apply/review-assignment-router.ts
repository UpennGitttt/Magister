// Phase 1 (§5.2) of the Leader-driven review autonomy
// RFC. Pure function: given a freshly-created change_review row + the
// workspace's review policy doc, decide who owns this review.
//
// 'user'   = today's HITL behaviour. Operator sees it in the panel.
// 'leader' = Leader's inbox. Leader's autonomous loop wakes up next
//            turn and decides via the read/reject/escalate tools
//            (apply tool deferred to Phase 1b-3 / RFC v3).
//
// The router NEVER maintains its own high-risk path list. It reuses
// `isHighRiskPath` from static-gate-service so the two policy
// surfaces (static gate HUMAN_REQUIRED reasons + this router's
// assignee decision) cannot drift apart. Codex v1 review BLOCKER 1
// caught a parallel list that was already missing 10+ patterns. The
// per-pattern fixtures in `is-high-risk-path.test.ts` lock the list
// to a single source of truth.

import type { ChangeReviewRow } from "../../repositories/change-review-repository";
import { isHighRiskPath } from "./static-gate-service";

export type ReviewPolicyDoc = {
  version: number;
  mode: "hitl" | "leader-driven";
  alwaysEscalatePaths?: string[];
};

export type RouterDecision = {
  assignee: "leader" | "user";
  setBy: "router";
  reason: string;
};

const MAX_KNOWN_POLICY_VERSION = 1;

export function parseWorkspacePolicy(json: string | null | undefined): ReviewPolicyDoc {
  // Defensive parsing: an unset / malformed / future-versioned policy
  // doc all degrade to "hitl" so we fail safe.
  if (!json) return { version: 1, mode: "hitl" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { version: 1, mode: "hitl" };
  }
  if (!isRecord(parsed)) return { version: 1, mode: "hitl" };
  const version =
    typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : 1;
  // Codex v2 review HIGH on policy versioning (RFC §9.Q11): if we
  // encounter a doc from a future Magister build, escalate. Don't
  // pretend we understand a newer schema.
  if (version > MAX_KNOWN_POLICY_VERSION) {
    return { version, mode: "hitl" };
  }
  const mode = parsed.mode === "leader-driven" ? "leader-driven" : "hitl";
  const alwaysEscalatePaths = Array.isArray(parsed.alwaysEscalatePaths)
    ? parsed.alwaysEscalatePaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    : undefined;
  return {
    version,
    mode,
    ...(alwaysEscalatePaths ? { alwaysEscalatePaths } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ChangedFile = { path: string };

function parseChangedFiles(json: string): ChangedFile[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): ChangedFile | null => {
        if (typeof entry === "string") return { path: entry };
        if (isRecord(entry) && typeof entry.path === "string") return { path: entry.path };
        return null;
      })
      .filter((entry): entry is ChangedFile => entry !== null);
  } catch {
    return [];
  }
}

function matchesAnyGlob(files: ChangedFile[], patterns: string[]): boolean {
  // Phase 1 supports plain substring or directory-prefix matching to
  // keep the policy surface small. Full glob is a Phase 2 add when we
  // wire a workspace policy editor UI.
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return files.some((f) => f.path.toLowerCase().includes(normalized));
  });
}

// Inputs the router needs. Carved out as a structural type so unit
// tests don't have to construct an entire ChangeReviewRow.
export type RouteAssignmentInput = {
  changedFilesJson: ChangeReviewRow["changedFilesJson"];
  permissionMode: ChangeReviewRow["permissionMode"];
  sandboxMode: ChangeReviewRow["sandboxMode"];
  runtimeWorkspaceStrategy: ChangeReviewRow["runtimeWorkspaceStrategy"];
};

export function routeAssignment(
  review: RouteAssignmentInput,
  policy: ReviewPolicyDoc,
): RouterDecision {
  // 1. Workspace mode hard override — `hitl` always wins, even over a
  //    notionally-safe diff. Operator's opt-out is non-negotiable.
  if (policy.mode === "hitl") {
    return { assignee: "user", setBy: "router", reason: "workspace_policy:hitl" };
  }

  // 2. Static-gate high-risk paths — single source of truth, see
  //    static-gate-service.ts `isHighRiskPath`.
  const changedFiles = parseChangedFiles(review.changedFilesJson);
  const highRiskHits = changedFiles.filter((f) => isHighRiskPath(f.path));
  if (highRiskHits.length > 0) {
    const sample = highRiskHits
      .slice(0, 5)
      .map((h) => h.path)
      .join(", ");
    const suffix = highRiskHits.length > 5 ? ` (+${highRiskHits.length - 5} more)` : "";
    return {
      assignee: "user",
      setBy: "router",
      reason: `static_gate_high_risk: ${sample}${suffix}`,
    };
  }

  // 3. Workspace-configured always-escalate paths (additive, never
  //    subtractive).
  if (policy.alwaysEscalatePaths && matchesAnyGlob(changedFiles, policy.alwaysEscalatePaths)) {
    return { assignee: "user", setBy: "router", reason: "workspace_policy:always_escalate" };
  }

  // 4. Sandbox / permission risk gradient (not covered by path matcher).
  if (review.sandboxMode === "danger-full-access") {
    return { assignee: "user", setBy: "router", reason: "danger_full_access" };
  }
  if (review.permissionMode === "headless" && review.runtimeWorkspaceStrategy === "workspace_root") {
    // headless on workspace_root means the teammate could touch anything
    // — escalate even if no listed high-risk path was hit this time.
    return { assignee: "user", setBy: "router", reason: "headless_on_workspace_root" };
  }

  // 5. Default: Leader's inbox.
  return { assignee: "leader", setBy: "router", reason: "default" };
}
