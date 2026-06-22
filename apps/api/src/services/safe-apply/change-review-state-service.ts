import { readFile } from "node:fs/promises";

import type { ExecutionEventInsert } from "@magister/db";

import type { ChangeReviewRow } from "../../repositories/change-review-repository";
import {
  ChangeReviewRepository,
  isChangeReviewUniqueConstraintError,
  type RecordChangeReviewDecisionInput,
} from "../../repositories/change-review-repository";
import { ArtifactRepository } from "../../repositories/artifact-repository";
import { ExecutionEventRepository } from "../../repositories/execution-event-repository";
import type {
  ChangeReviewDraft,
  ChangedFileSummary,
  ExecutionSandboxMetadata,
  McpToolRisk,
  SastAdvisoryResult,
  StaticGateResult,
  VerificationEvidence,
} from "./safe-apply-types";

type ArtifactReader = Pick<ArtifactRepository, "getById">;
type ExecutionEventWriter = {
  create(input: ExecutionEventInsert): Promise<unknown>;
};

// `canonicalJson` was previously imported from the audit service to
// produce stable, key-sorted JSON for hash inputs. With the HMAC
// audit chain removed (2026-05-15) we no longer need canonical sort
// for hashing; plain JSON.stringify is sufficient for the stored
// `*_json` columns (the diff hash itself is computed by git, not by
// us, so canonicalization doesn't affect collision behaviour).
function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

const EXECUTION_SANDBOX_MODES = new Set(["off", "optional", "required"] as const);
const EXECUTION_SANDBOX_PROVIDERS = new Set(["none", "bubblewrap"] as const);
const EXECUTION_SANDBOX_STATUSES = new Set(["disabled", "unavailable", "available", "active"] as const);
const EXECUTION_SANDBOX_NETWORKS = new Set(["host", "disabled", "unknown"] as const);
const EXECUTION_SANDBOX_MAIN_WORKSPACE = new Set(["not_isolated", "read_only", "hidden", "unknown"] as const);
const EXECUTION_SANDBOX_RUNTIME_WORKSPACE = new Set(["host_writable", "sandbox_writable", "unknown"] as const);
const EXECUTION_SANDBOX_HOME_TMP = new Set(["host", "isolated", "unknown"] as const);
export type MaterializeChangeReviewInput = {
  reviewDraftArtifactId: string;
  diffArtifactId?: string | null;
  gateArtifactId?: string | null;
  sourceEventId?: string | null;
  now?: () => Date;
  actorId?: string | null;
  changeReviewRepository?: ChangeReviewRepository;
  artifactRepository?: ArtifactReader;
  executionEventRepository?: ExecutionEventWriter;
};

export type MaterializePendingChangeReviewDraftsInput = {
  taskId?: string;
  limit?: number;
  changeReviewRepository?: ChangeReviewRepository;
  artifactRepository?: ArtifactReader;
  executionEventRepository?: ExecutionEventRepository;
};

export async function materializeChangeReviewFromDraft(
  input: MaterializeChangeReviewInput,
): Promise<ChangeReviewRow> {
  const changeReviewRepository = input.changeReviewRepository ?? new ChangeReviewRepository();
  const artifactRepository = input.artifactRepository ?? new ArtifactRepository();
  const executionEventRepository = input.executionEventRepository ?? new ExecutionEventRepository();

  const existing = await changeReviewRepository.getByDraftArtifactId(input.reviewDraftArtifactId);
  if (existing) {
    return existing;
  }

  const draftArtifact = await artifactRepository.getById(input.reviewDraftArtifactId);
  if (!draftArtifact || draftArtifact.artifactType !== "change_review_draft") {
    throw new Error(`Change review draft artifact not found: ${input.reviewDraftArtifactId}`);
  }

  let draft: ChangeReviewDraft;
  try {
    draft = validateChangeReviewDraft(
      JSON.parse(await readFile(draftArtifact.storageRef, "utf8")),
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Malformed change review draft")) {
      throw error;
    }
    throw new Error(`Malformed change review draft: ${error instanceof Error ? error.message : String(error)}`);
  }

  const now = input.now?.() ?? new Date();
  const diffArtifactId = input.diffArtifactId ?? draft.diffArtifact.artifactId;
  const gateArtifactId = input.gateArtifactId ?? null;
  // Empty diffs (0 added + 0 removed) auto-resolve to
  // "not_required". A headless agent that produced no patch has
  // nothing the reviewer can usefully approve or reject — surfacing
  // it as `pending` forces the operator to manually clear noise
  // entries that have no concrete action. We still create the review
  // row (so the run shows up in audit + change-review history); it
  // just doesn't block the queue.
  const decisionState =
    draft.gate.risk === "AUTO_OK" || draft.diffArtifact.isEmpty ? "not_required" : "pending";

  // Phase 1 of the Leader-driven review autonomy RFC.
  // Decide assignee at creation time. For terminal decisionStates
  // (`not_required`, the only one we set automatically here) the
  // assignee is irrelevant — the queue doesn't surface those — so we
  // always keep them on `'user'` for audit consistency. For genuinely
  // pending reviews, the router reads the workspace policy and
  // returns either 'user' (default in `hitl` mode) or 'leader' (only
  // when the workspace has opted in AND the diff is router-safe).
  let assignee: "user" | "leader" = "user";
  let assigneeSetBy: string | null = null;
  let routerReason: string | null = null;
  if (decisionState === "pending") {
    try {
      const { WorkspaceRepository } = await import("../../repositories/workspace-repository");
      const { routeAssignment, parseWorkspacePolicy } = await import("./review-assignment-router");
      const workspace = await new WorkspaceRepository().getById(draft.workspaceId);
      const policy = parseWorkspacePolicy(workspace?.reviewPolicyJson ?? null);
      const decision = routeAssignment(
        {
          changedFilesJson: canonicalJson(draft.diffArtifact.changedFiles),
          permissionMode: draft.runtimeSecurity.permissionMode,
          sandboxMode: draft.runtimeSecurity.sandboxMode,
          runtimeWorkspaceStrategy: draft.runtimeSecurity.runtimeWorkspaceStrategy,
        },
        policy,
      );
      assignee = decision.assignee;
      assigneeSetBy = decision.setBy;
      routerReason = decision.reason;
    } catch (error) {
      // Router failures are non-fatal — we just keep the default
      // (user-owned) so the review still lands somewhere it can be
      // acted on. Logged so we notice if the path is broken.
      console.warn(
        "[change-review-state] assignment router failed; defaulting to user",
        error,
      );
    }
  }

  const createInput = {
    taskId: draft.taskId,
    roleRuntimeId: draft.roleRuntimeId ?? null,
    workspaceId: draft.workspaceId,
    sourceEventId: input.sourceEventId ?? null,
    reviewDraftArtifactId: input.reviewDraftArtifactId,
    diffArtifactId,
    gateArtifactId,
    runtimeSource: draft.runtimeSecurity.runtimeSource,
    permissionMode: draft.runtimeSecurity.permissionMode,
    executorCommand: draft.runtimeSecurity.commandPath,
    sandboxMode: draft.runtimeSecurity.sandboxMode,
    argvFlagsJson: canonicalJson(draft.runtimeSecurity.argvFlags),
    permissionSignalsJson: canonicalJson(draft.runtimeSecurity.permissionSignals),
    envPermissionHintsJson: canonicalJson(draft.runtimeSecurity.envPermissionHints),
    runtimeWorkspaceStrategy: draft.runtimeSecurity.runtimeWorkspaceStrategy,
    mcpToolRiskJson: canonicalJson(draft.mcpToolRisk ?? []),
    sastAdvisoryJson: draft.sastAdvisory ? canonicalJson(draft.sastAdvisory) : null,
    executionSandboxJson: draft.runtimeSecurity.executionSandbox
      ? canonicalJson(draft.runtimeSecurity.executionSandbox)
      : null,
    sideEffectWarningJson: draft.sideEffectWarning ? canonicalJson(draft.sideEffectWarning) : null,
    baseRevision: draft.diffArtifact.baseRevision ?? null,
    diffHash: draft.diffArtifact.diffHash,
    diffAlgorithmJson: canonicalJson(draft.diffArtifact.diffAlgorithm),
    changedFilesJson: canonicalJson(draft.diffArtifact.changedFiles),
    addedLines: draft.diffArtifact.addedLines,
    removedLines: draft.diffArtifact.removedLines,
    isEmpty: draft.diffArtifact.isEmpty,
    risk: draft.gate.risk,
    riskReasonsJson: canonicalJson(draft.gate.reasons),
    verificationJson: canonicalJson(draft.verification),
    reviewerVerdictsJson: "[]",
    decisionState,
    decisionReason: null,
    decidedBy: null,
    decidedAt: null,
    applyState: "not_applied",
    appliedAt: null,
    assignee,
    assigneeSetBy,
    reviewerVerdictArtifactId: null,
    leaderApplyCommitSha: null,
    createdAt: now,
    updatedAt: now,
    actorType: "system",
    actorId: input.actorId ?? null,
  } as const;

  let review: ChangeReviewRow;
  try {
    review = await changeReviewRepository.createFromDraft(createInput);
  } catch (error) {
    if (isChangeReviewUniqueConstraintError(error)) {
      const existingAfterRace = await changeReviewRepository.getByDraftArtifactId(
        input.reviewDraftArtifactId,
      );
      if (existingAfterRace) {
        return existingAfterRace;
      }
    }
    throw error;
  }

  await executionEventRepository.create({
    id: `event_${crypto.randomUUID()}`,
    type: "safe_apply.change_review_created",
    taskId: review.taskId,
    roleRuntimeId: review.roleRuntimeId,
    workspaceId: review.workspaceId,
    artifactId: input.reviewDraftArtifactId,
    severity: review.risk === "HUMAN_REQUIRED" ? "warn" : "info",
    payloadJson: JSON.stringify({
      reviewId: review.id,
      reviewDraftArtifactId: input.reviewDraftArtifactId,
      diffArtifactId,
      gateArtifactId,
      risk: review.risk,
      decisionState: review.decisionState,
      diffHash: review.diffHash,
      assignee: review.assignee,
      assigneeSetBy: review.assigneeSetBy,
      routerReason,
    }),
    occurredAt: now,
  });

  // If this review landed in Leader's inbox, hand it
  // off to Leader's autonomous loop. The bridge writes a task_mailbox
  // row + (when the worker is idle) re-enqueues the task so a
  // DONE-status task can wake up and decide. With all workspaces in
  // their default `hitl` mode this branch never executes — the
  // router unconditionally returns `'user'`.
  if (assignee === "leader" && decisionState === "pending") {
    try {
      const { notifyLeaderOfAssignedReview } = await import("./leader-review-inbox-bridge");
      const changedFiles = draft.diffArtifact.changedFiles ?? [];
      await notifyLeaderOfAssignedReview({
        reviewId: review.id,
        taskId: review.taskId,
        workspaceId: review.workspaceId,
        addedLines: review.addedLines,
        removedLines: review.removedLines,
        changedFileCount: Array.isArray(changedFiles) ? changedFiles.length : 0,
        risk: review.risk,
        routerReason: routerReason ?? "(none)",
      });
    } catch (error) {
      console.error(
        "[change-review-state] leader inbox bridge failed",
        review.id,
        error,
      );
    }
  }

  return review;
}

export async function materializeChangeReviewFromDraftBestEffort(
  input: MaterializeChangeReviewInput,
): Promise<ChangeReviewRow | null> {
  try {
    return await materializeChangeReviewFromDraft(input);
  } catch (error) {
    logBestEffortMaterializationFailure(error);
    await emitMaterializationFailedEvent({
      reviewDraftArtifactId: input.reviewDraftArtifactId,
      taskId: null,
      roleRuntimeId: null,
      workspaceId: null,
      error,
      ...(input.executionEventRepository
        ? { executionEventRepository: input.executionEventRepository }
        : {}),
    });
    return null;
  }
}

export async function materializePendingChangeReviewDrafts(
  input: MaterializePendingChangeReviewDraftsInput = {},
): Promise<{ created: number; skipped: number; failed: number }> {
  const changeReviewRepository = input.changeReviewRepository ?? new ChangeReviewRepository();
  const executionEventRepository = input.executionEventRepository ?? new ExecutionEventRepository();
  const events = input.taskId
    ? await executionEventRepository.listByTaskIdAndType(
        input.taskId,
        "safe_apply.review_draft_created",
        input.limit,
      )
    : await executionEventRepository.listByType(
        "safe_apply.review_draft_created",
        input.limit,
      );

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const event of events) {
    const payload = parseJsonObject(event.payloadJson);
    const reviewDraftArtifactId = stringOrNull(payload.reviewDraftArtifactId);
    if (!reviewDraftArtifactId) {
      skipped += 1;
      continue;
    }
    const existing = await changeReviewRepository.getByDraftArtifactId(reviewDraftArtifactId);
    if (existing) {
      skipped += 1;
      continue;
    }

    try {
      await materializeChangeReviewFromDraft({
        reviewDraftArtifactId,
        ...(stringOrNull(payload.diffArtifactId)
          ? { diffArtifactId: stringOrNull(payload.diffArtifactId) }
          : {}),
        ...(stringOrNull(payload.gateArtifactId)
          ? { gateArtifactId: stringOrNull(payload.gateArtifactId) }
          : {}),
        sourceEventId: event.id,
        changeReviewRepository,
        ...(input.artifactRepository ? { artifactRepository: input.artifactRepository } : {}),
        executionEventRepository,
      });
      created += 1;
    } catch (error) {
      failed += 1;
      await emitMaterializationFailedEvent({
        reviewDraftArtifactId,
        taskId: event.taskId,
        roleRuntimeId: event.roleRuntimeId,
        workspaceId: event.workspaceId,
        error,
        executionEventRepository,
      });
    }
  }

  return { created, skipped, failed };
}

export async function recordChangeReviewDecision(input: {
  reviewId: string;
  decision: "approve" | "reject" | "request_revision";
  reason?: string | null;
  expectedDiffHash?: string | null;
  actorId?: string | null;
  changeReviewRepository?: ChangeReviewRepository;
  executionEventRepository?: ExecutionEventRepository;
}): Promise<{ review: ChangeReviewRow; idempotent: boolean }> {
  const changeReviewRepository = input.changeReviewRepository ?? new ChangeReviewRepository();
  const executionEventRepository = input.executionEventRepository ?? new ExecutionEventRepository();
  const decisionState = decisionToState(input.decision);

  const result = await changeReviewRepository.recordDecision({
    reviewId: input.reviewId,
    decisionState,
    reason: input.reason ?? null,
    actorId: input.actorId ?? null,
    expectedDiffHash: input.expectedDiffHash ?? null,
  } satisfies RecordChangeReviewDecisionInput);

  if (!result.idempotent) {
    await executionEventRepository.create({
      id: `event_${crypto.randomUUID()}`,
      type: "safe_apply.change_review_decision_recorded",
      taskId: result.review.taskId,
      roleRuntimeId: result.review.roleRuntimeId,
      workspaceId: result.review.workspaceId,
      severity: decisionState === "approved" ? "info" : "warn",
      payloadJson: JSON.stringify({
        reviewId: result.review.id,
        decisionState,
        diffHash: result.review.diffHash,
      }),
      occurredAt: result.review.decidedAt ?? new Date(),
    });
  }

  return result;
}

export function toChangeReviewSummary(row: ChangeReviewRow) {
  const riskReasons = parseJsonArray<{ code?: unknown }>(row.riskReasonsJson);
  const sideEffectWarning = row.sideEffectWarningJson
    ? parseJsonObject(row.sideEffectWarningJson)
    : null;

  return {
    id: row.id,
    taskId: row.taskId,
    roleRuntimeId: row.roleRuntimeId,
    runtimeSource: row.runtimeSource,
    permissionMode: row.permissionMode,
    runtimeWorkspaceStrategy: row.runtimeWorkspaceStrategy,
    risk: row.risk,
    decisionState: row.decisionState,
    applyState: row.applyState,
    diffHash: row.diffHash,
    baseRevision: row.baseRevision,
    changedFiles: parseJsonArray<ChangedFileSummary>(row.changedFilesJson),
    addedLines: row.addedLines,
    removedLines: row.removedLines,
    reasonCodes: riskReasons
      .map((reason) => (typeof reason.code === "string" ? reason.code : null))
      .filter((code): code is string => Boolean(code)),
    sideEffectWarningCode:
      sideEffectWarning && typeof sideEffectWarning.code === "string"
        ? sideEffectWarning.code
        : null,
    // Phase 1 review-autonomy fields. Without these the
    // operator's panel can't distinguish leader-assigned reviews from
    // their own and can't render the leader auto-commit SHA. Default
    // assignee='user' for old rows so existing behavior is unchanged.
    assignee: row.assignee ?? "user",
    assigneeSetBy: row.assigneeSetBy ?? null,
    leaderApplyCommitSha: row.leaderApplyCommitSha ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toChangeReviewDetail(row: ChangeReviewRow) {
  return {
    ...toChangeReviewSummary(row),
    artifactIds: {
      reviewDraftArtifactId: row.reviewDraftArtifactId,
      diffArtifactId: row.diffArtifactId,
      gateArtifactId: row.gateArtifactId,
    },
    runtimeSecurity: {
      runtimeSource: row.runtimeSource,
      commandPath: row.executorCommand,
      argvFlags: parseJsonArray<string>(row.argvFlagsJson),
      sandboxMode: row.sandboxMode,
      permissionMode: row.permissionMode,
      permissionSignals: parseJsonArray<string>(row.permissionSignalsJson),
      envPermissionHints: parseJsonArray<string>(row.envPermissionHintsJson),
      runtimeWorkspaceStrategy: row.runtimeWorkspaceStrategy,
      executionSandbox: parseStoredExecutionSandboxMetadata(row.executionSandboxJson),
    },
    diffAlgorithm: parseJsonObject(row.diffAlgorithmJson),
    riskReasons: parseJsonArray<StaticGateResult["reasons"][number]>(row.riskReasonsJson),
    verification: parseJsonArray<VerificationEvidence>(row.verificationJson),
    mcpToolRisk: parseJsonArray<McpToolRisk>(row.mcpToolRiskJson),
    sastAdvisory: row.sastAdvisoryJson ? parseJsonObject(row.sastAdvisoryJson) as SastAdvisoryResult : null,
    reviewerVerdicts: parseJsonArray<unknown>(row.reviewerVerdictsJson),
    sideEffectWarning: row.sideEffectWarningJson ? parseJsonObject(row.sideEffectWarningJson) : null,
  };
}

function validateChangeReviewDraft(value: unknown): ChangeReviewDraft {
  if (!isRecord(value)) {
    throw new Error("Malformed change review draft: root is not an object");
  }
  if (typeof value.taskId !== "string" || value.taskId.length === 0) {
    throw new Error("Malformed change review draft: missing taskId");
  }
  if (typeof value.workspaceId !== "string" || value.workspaceId.length === 0) {
    throw new Error("Malformed change review draft: missing workspaceId");
  }
  if (!isRecord(value.runtimeSecurity)) {
    throw new Error("Malformed change review draft: missing runtimeSecurity");
  }
  if (!isRecord(value.diffArtifact)) {
    throw new Error("Malformed change review draft: missing diffArtifact");
  }
  if (!isRecord(value.gate)) {
    throw new Error("Malformed change review draft: missing gate");
  }
  if (value.gate.risk !== "AUTO_OK" && value.gate.risk !== "HUMAN_REQUIRED") {
    throw new Error("Malformed change review draft: invalid gate risk");
  }
  if (!Array.isArray(value.gate.reasons)) {
    throw new Error("Malformed change review draft: missing gate reasons");
  }
  const diff = value.diffArtifact;
  if (
    typeof diff.artifactId !== "string" ||
    typeof diff.diffHash !== "string" ||
    !Array.isArray(diff.changedFiles) ||
    typeof diff.addedLines !== "number" ||
    typeof diff.removedLines !== "number" ||
    typeof diff.isEmpty !== "boolean" ||
    !isRecord(diff.diffAlgorithm)
  ) {
    throw new Error("Malformed change review draft: invalid diff artifact");
  }
  const security = value.runtimeSecurity;
  if (
    typeof security.runtimeSource !== "string" ||
    !Array.isArray(security.argvFlags) ||
    !Array.isArray(security.permissionSignals) ||
    !Array.isArray(security.envPermissionHints) ||
    typeof security.permissionMode !== "string" ||
    typeof security.runtimeWorkspaceStrategy !== "string"
  ) {
    throw new Error("Malformed change review draft: invalid runtime security");
  }
  if (!Array.isArray(value.verification)) {
    throw new Error("Malformed change review draft: missing verification");
  }
  if (value.mcpToolRisk !== undefined && !Array.isArray(value.mcpToolRisk)) {
    throw new Error("Malformed change review draft: invalid mcpToolRisk");
  }
  if (value.sastAdvisory !== undefined && value.sastAdvisory !== null && !isRecord(value.sastAdvisory)) {
    throw new Error("Malformed change review draft: invalid sastAdvisory");
  }
  const executionSandbox = parseExecutionSandboxMetadata(security.executionSandbox ?? null);
  if (security.executionSandbox !== undefined && security.executionSandbox !== null && !executionSandbox) {
    throw new Error("Malformed change review draft: invalid executionSandbox");
  }

  const draft = value as ChangeReviewDraft;
  return {
    ...draft,
    runtimeSecurity: {
      ...draft.runtimeSecurity,
      executionSandbox,
    },
    mcpToolRisk: Array.isArray(value.mcpToolRisk) ? value.mcpToolRisk as McpToolRisk[] : [],
    sastAdvisory: isRecord(value.sastAdvisory) ? value.sastAdvisory as SastAdvisoryResult : null,
  };
}

function decisionToState(decision: "approve" | "reject" | "request_revision") {
  switch (decision) {
    case "approve":
      return "approved";
    case "reject":
      return "rejected";
    case "request_revision":
      return "revision_requested";
  }
}

async function emitMaterializationFailedEvent(input: {
  reviewDraftArtifactId: string;
  taskId: string | null;
  roleRuntimeId: string | null;
  workspaceId: string | null;
  error: unknown;
  executionEventRepository?: ExecutionEventWriter;
}) {
  const executionEventRepository = input.executionEventRepository ?? new ExecutionEventRepository();
  try {
    await executionEventRepository.create({
      id: `event_${crypto.randomUUID()}`,
      type: "safe_apply.change_review_materialization_failed",
      taskId: input.taskId,
      roleRuntimeId: input.roleRuntimeId,
      workspaceId: input.workspaceId,
      artifactId: input.reviewDraftArtifactId,
      severity: "warn",
      payloadJson: JSON.stringify({
        reviewDraftArtifactId: input.reviewDraftArtifactId,
        error: input.error instanceof Error ? input.error.message : String(input.error),
      }),
      occurredAt: new Date(),
    });
  } catch (eventError) {
    console.error("[safe-apply] failed to emit materialization failure event", eventError);
  }
}

function logBestEffortMaterializationFailure(error: unknown) {
  console.error("[safe-apply] change review materialization failed", error);
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseStoredExecutionSandboxMetadata(value: string | null | undefined): ExecutionSandboxMetadata | null {
  if (!value) return null;
  try {
    return parseExecutionSandboxMetadata(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function parseExecutionSandboxMetadata(value: unknown): ExecutionSandboxMetadata | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !isRecord(value.filesystem)) return null;

  const mode = enumValue(value.mode, EXECUTION_SANDBOX_MODES);
  const provider = enumValue(value.provider, EXECUTION_SANDBOX_PROVIDERS);
  const status = enumValue(value.status, EXECUTION_SANDBOX_STATUSES);
  const network = enumValue(value.network, EXECUTION_SANDBOX_NETWORKS);
  const mainWorkspace = enumValue(
    value.filesystem.mainWorkspace,
    EXECUTION_SANDBOX_MAIN_WORKSPACE,
  );
  const runtimeWorkspace = enumValue(
    value.filesystem.runtimeWorkspace,
    EXECUTION_SANDBOX_RUNTIME_WORKSPACE,
  );
  const home = enumValue(value.filesystem.home, EXECUTION_SANDBOX_HOME_TMP);
  const tmp = enumValue(value.filesystem.tmp, EXECUTION_SANDBOX_HOME_TMP);
  if (
    !mode ||
    !provider ||
    !status ||
    !network ||
    !mainWorkspace ||
    !runtimeWorkspace ||
    !home ||
    !tmp
  ) {
    return null;
  }
  if (value.commandPath !== null && value.commandPath !== undefined && typeof value.commandPath !== "string") {
    return null;
  }
  if (value.reason !== null && value.reason !== undefined && typeof value.reason !== "string") {
    return null;
  }

  return {
    mode,
    provider,
    status,
    commandPath: typeof value.commandPath === "string" ? value.commandPath : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    network,
    filesystem: {
      mainWorkspace,
      runtimeWorkspace,
      home,
      tmp,
    },
  };
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>): T | null {
  return typeof value === "string" && allowed.has(value as T) ? value as T : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type ReviewDecisionResult = {
  decision: "approved" | "rejected" | "revision_requested" | "timeout" | "aborted";
  reason?: string;
};

export async function waitForReviewDecision(
  reviewId: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    repo?: { getById: (id: string) => Promise<{ decisionState: string; decisionReason: string | null } | null> };
  } = {},
): Promise<ReviewDecisionResult> {
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const repo = opts.repo ?? new ChangeReviewRepository();

  while (true) {
    const row = await repo.getById(reviewId);
    if (!row) return { decision: "aborted" };

    const state = row.decisionState;
    if (state === "approved") return { decision: "approved" };
    if (state === "rejected") {
      return row.decisionReason
        ? { decision: "rejected", reason: row.decisionReason }
        : { decision: "rejected" };
    }
    if (state === "revision_requested") {
      return row.decisionReason
        ? { decision: "revision_requested", reason: row.decisionReason }
        : { decision: "revision_requested" };
    }

    if (opts.signal?.aborted) return { decision: "aborted" };
    if (Date.now() >= deadline) return { decision: "timeout" };

    await new Promise((r) => setTimeout(r, 1000));
  }
}
