import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  applyChangeReview,
  discardChangeReview,
  decideChangeReview,
  getChangeReview,
  getChangeReviewDiff,
  getTaskChangeReviews,
} from "../../lib/api";
import type {
  ChangeReviewDecisionState,
  ChangeReviewDetail,
  ChangeReviewDiffPreview,
  ChangeReviewSummary,
} from "../../lib/types";
import { ApiError } from "../../lib/request";

const CHANGE_REVIEW_POLL_MS = 5_000;
const TERMINAL_TASK_STATES = new Set(["DONE", "PR_OPEN", "MERGE_WAITING", "FAILED", "CANCELLED"]);

type Decision = "approve" | "reject" | "request_revision" | "discard";
type ChangeReviewPanelMode = "embedded" | "workspace";

// Render a unified-diff patch with line-level + / - / hunk coloring.
// Renders each line as its own <span> with a class so reviewers can
// actually read the diff. Lines starting with `diff --git`, `index `,
// `---`, `+++` are treated as headers; `@@` as hunk markers; `+` /
// `-` as added / removed (but not the file-header `+++` / `---`
// double-prefix forms). Everything else is context.
function diffLineClass(line: string): string {
  if (line.startsWith("diff --git") || line.startsWith("index ")) return "diff-line-meta";
  if (line.startsWith("---") || line.startsWith("+++")) return "diff-line-meta";
  if (line.startsWith("@@")) return "diff-line-hunk";
  if (line.startsWith("+")) return "diff-line-add";
  if (line.startsWith("-")) return "diff-line-del";
  return "diff-line-ctx";
}

function DiffPatchLines({ patch }: { patch: string }) {
  // split on \n keeping behavior bounded — patches are already
  // truncated upstream when too large (`diff.truncated`).
  const lines = patch.split("\n");
  return (
    <code>
      {lines.map((line, idx) => (
        <span key={idx} className={diffLineClass(line)}>
          {line}
          {idx < lines.length - 1 ? "\n" : ""}
        </span>
      ))}
    </code>
  );
}

export function ChangeReviewPanel({
  taskId,
  taskState,
  mode = "embedded",
  onWorkspaceClose,
  onActionableCountChange,
}: {
  taskId: string | null;
  taskState?: string | null;
  mode?: ChangeReviewPanelMode;
  onWorkspaceClose?: () => void;
  // Second arg breaks `count` into the two phases the operator needs
  // to distinguish: how many patch reviews are pending a decision
  // (approve / reject / supersede) vs. how many have been approved but
  // not yet applied. Callers that only care about the total can use the first arg.
  onActionableCountChange?: (
    count: number,
    breakdown: { toDecide: number; toApply: number; total: number },
  ) => void;
}) {
  const [summaries, setSummaries] = useState<ChangeReviewSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [dismissedListError, setDismissedListError] = useState<string | null>(null);
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ChangeReviewDetail | null>(null);
  const [diff, setDiff] = useState<ChangeReviewDiffPreview | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionInFlight, setDecisionInFlight] = useState<Decision | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyInFlight, setApplyInFlight] = useState(false);
  const [collapsedActionKey, setCollapsedActionKey] = useState<string | null>(null);
  const taskIdRef = useRef(taskId);
  const mountedRef = useRef(true);
  const detailRequestSeq = useRef(0);
  const dialogRef = useRef<HTMLElement | null>(null);
  const lastOpenerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    taskIdRef.current = taskId;
  }, [taskId]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCurrentTask = useCallback((expectedTaskId: string | null) => {
    return mountedRef.current && taskIdRef.current === expectedTaskId;
  }, []);

  const loadSummaries = useCallback(async (showLoading = false) => {
    if (!taskId) {
      setSummaries([]);
      setLoaded(false);
      setListError(null);
      setDismissedListError(null);
      return;
    }
    const requestTaskId = taskId;
    if (showLoading) {
      setLoading(true);
      setLoaded(false);
    }
    try {
      const reviews = await getTaskChangeReviews(requestTaskId);
      if (!isCurrentTask(requestTaskId)) return;
      setSummaries(reviews);
      setListError(null);
      setDismissedListError(null);
    } catch (error) {
      if (!isCurrentTask(requestTaskId)) return;
      setListError(errorMessage(error));
    } finally {
      if (!isCurrentTask(requestTaskId)) return;
      setLoaded(true);
      if (showLoading) setLoading(false);
    }
  }, [isCurrentTask, taskId]);

  useEffect(() => {
    setSummaries([]);
    setSelectedReviewId(null);
    setDetail(null);
    setDiff(null);
    setNote("");
    setDecisionError(null);
    setApplyError(null);
    setCollapsedActionKey(null);
    setDetailError(null);
    setDismissedListError(null);
    void loadSummaries(true);
  }, [loadSummaries]);

  const shouldPoll = useMemo(() => {
    if (!taskId) return false;
    const hasPending = summaries.some((review) => review.decisionState === "pending");
    const normalizedState = taskState?.trim().toUpperCase() ?? "";
    return hasPending || (normalizedState.length > 0 && !TERMINAL_TASK_STATES.has(normalizedState));
  }, [summaries, taskId, taskState]);

  // Patch reviews that still need operator attention: pending
  // decisions, or already-approved reviews waiting to be applied.
  // rejected / superseded / not_required / approved+applied are terminal noise.
  const actionBreakdown = useMemo(() => {
    let toDecide = 0;
    let toApply = 0;
    for (const review of summaries) {
      if (review.decisionState === "pending") toDecide += 1;
      else if (review.decisionState === "approved" && review.applyState === "not_applied") toApply += 1;
    }
    return { toDecide, toApply, total: toDecide + toApply };
  }, [summaries]);
  const actionableCount = actionBreakdown.total;
  const actionableReviews = useMemo(
    () => summaries.filter(isActionableReview),
    [summaries],
  );
  const primaryActionReview = actionableReviews[0] ?? null;
  const actionKey = useMemo(
    () => actionableReviews
      .map((review) => `${review.id}:${review.decisionState}:${review.applyState}:${review.diffHash}`)
      .join("|"),
    [actionableReviews],
  );
  const actionSummaryText = actionBreakdownText(actionBreakdown).replace(/\.$/, "");
  const isActionBarCollapsed = actionableCount > 0 && actionKey.length > 0 && collapsedActionKey === actionKey;

  useEffect(() => {
    onActionableCountChange?.(actionableCount, actionBreakdown);
  }, [actionableCount, actionBreakdown, onActionableCountChange]);

  useEffect(() => {
    if (mode !== "workspace" || selectedReviewId || summaries.length === 0) return;
    const firstReview = summaries.find(isActionableReview) ?? summaries[0] ?? null;
    if (!firstReview) return;
    void openReview(firstReview.id, null);
  }, [mode, selectedReviewId, summaries]);

  useEffect(() => {
    if (!shouldPoll) return;
    const poll = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        void loadSummaries(false);
      }
    };
    const intervalId = window.setInterval(poll, CHANGE_REVIEW_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [loadSummaries, shouldPoll]);

  const closeReview = useCallback(() => {
    detailRequestSeq.current += 1;
    setSelectedReviewId(null);
    setDetail(null);
    setDiff(null);
    setNote("");
    setDecisionError(null);
    setApplyError(null);
    setDetailError(null);
    setDetailLoading(false);
    setDecisionInFlight(null);
    setApplyInFlight(false);
    window.setTimeout(() => {
      lastOpenerRef.current?.focus();
    }, 0);
  }, []);

  const dismissListError = useCallback(() => {
    if (listError) setDismissedListError(listError);
    setListError(null);
  }, [listError]);

  useLayoutEffect(() => {
    if (!selectedReviewId || mode === "workspace") return;
    dialogRef.current?.focus();
  }, [mode, selectedReviewId]);

  useEffect(() => {
    if (!selectedReviewId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || decisionInFlight !== null || applyInFlight) return;
      event.preventDefault();
      closeReview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [applyInFlight, closeReview, decisionInFlight, selectedReviewId]);

  if (!taskId) return null;
  if (mode !== "workspace") {
    if (!loaded && !loading) return null;
    if (summaries.length === 0 && !listError) return null;
  }

  const selectedSummary = selectedReviewId
    ? summaries.find((review) => review.id === selectedReviewId) ?? null
    : null;
  const selected = detail ?? selectedSummary;
  const visibleListError = listError && dismissedListError !== listError ? listError : null;

  async function openReview(reviewId: string, opener: HTMLButtonElement | null) {
    const requestTaskId = taskId;
    const requestSeq = detailRequestSeq.current + 1;
    detailRequestSeq.current = requestSeq;
    lastOpenerRef.current = opener;
    setSelectedReviewId(reviewId);
    setDetail(null);
    setDiff(null);
    setNote("");
    setDecisionError(null);
    setApplyError(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const [nextDetail, nextDiff] = await Promise.all([
        getChangeReview(reviewId),
        getChangeReviewDiff(reviewId),
      ]);
      if (!isCurrentTask(requestTaskId) || detailRequestSeq.current !== requestSeq) return;
      setDetail(nextDetail);
      setDiff(nextDiff);
    } catch (error) {
      if (!isCurrentTask(requestTaskId) || detailRequestSeq.current !== requestSeq) return;
      if (isApiErrorStatus(error, 404)) {
        setListError(errorMessage(error));
        closeReview();
        void loadSummaries(false);
        return;
      }
      setDetailError(errorMessage(error));
    } finally {
      if (!isCurrentTask(requestTaskId) || detailRequestSeq.current !== requestSeq) return;
      setDetailLoading(false);
    }
  }

  async function refreshDetail(reviewId: string) {
    const requestTaskId = taskId;
    const requestSeq = detailRequestSeq.current + 1;
    detailRequestSeq.current = requestSeq;
    try {
      const nextDetail = await getChangeReview(reviewId);
      if (!isCurrentTask(requestTaskId) || detailRequestSeq.current !== requestSeq) return;
      setDetail(nextDetail);
      setDetailError(null);
    } catch (error) {
      if (!isCurrentTask(requestTaskId) || detailRequestSeq.current !== requestSeq) return;
      if (isApiErrorStatus(error, 404)) {
        setListError(errorMessage(error));
        closeReview();
        void loadSummaries(false);
        return;
      }
      setDetailError(errorMessage(error));
    }
  }

  async function submitDecision(decision: Exclude<Decision, "discard">) {
    if (!detail || applyInFlight) return;
    const trimmedNote = note.trim();
    if (decision !== "approve" && trimmedNote.length === 0) {
      setDecisionError("A note is required to reject or request revision.");
      return;
    }

    setDecisionError(null);
    setApplyError(null);
    setDecisionInFlight(decision);
    try {
      const result = await decideChangeReview(detail.id, {
        decision,
        expectedDiffHash: detail.diffHash,
        ...(trimmedNote ? { reason: trimmedNote } : {}),
      });
      setSummaries((current) => mergeSummary(current, result.review));
      setDetail((current) => (current ? { ...current, ...result.review } : current));

      if (decision === "approve") {
        try {
          const applyResult = await applyChangeReview(detail.id, {
            expectedDiffHash: detail.diffHash,
          });
          setSummaries((current) => mergeSummary(current, applyResult.review));
          setDetail((current) => (current ? { ...current, ...applyResult.review } : current));
        } catch (applyErr) {
          console.warn("[change-review] auto-apply after approve failed:", applyErr);
        }
      }

      await Promise.all([loadSummaries(false), refreshDetail(result.review.id)]);
    } catch (error) {
      setDecisionError(errorMessage(error));
      if (detail) void Promise.all([loadSummaries(false), refreshDetail(detail.id)]);
    } finally {
      setDecisionInFlight(null);
    }
  }

  async function submitApply() {
    if (!detail || decisionInFlight !== null || applyInFlight) return;

    setDecisionError(null);
    setApplyError(null);
    setApplyInFlight(true);
    try {
      const result = await applyChangeReview(detail.id, {
        expectedDiffHash: detail.diffHash,
      });
      setSummaries((current) => mergeSummary(current, result.review));
      setDetail((current) => (current ? { ...current, ...result.review } : current));
      await Promise.all([loadSummaries(false), refreshDetail(result.review.id)]);
    } catch (error) {
      setApplyError(errorMessage(error));
      if (detail) void Promise.all([loadSummaries(false), refreshDetail(detail.id)]);
    } finally {
      setApplyInFlight(false);
    }
  }

  // Supersede an approved-not-applied row that the server apply
  // preflight already marked as not currently applicable.
  async function submitDiscard() {
    if (!detail || decisionInFlight !== null || applyInFlight) return;
    setDecisionError(null);
    setApplyError(null);
    setDecisionInFlight("discard");
    try {
      const result = await discardChangeReview(detail.id);
      setSummaries((current) => mergeSummary(current, result.review));
      setDetail((current) => (current ? { ...current, ...result.review } : current));
      await loadSummaries(false);
      closeReview();
    } catch (error) {
      setDecisionError(errorMessage(error));
      if (detail) void Promise.all([loadSummaries(false), refreshDetail(detail.id)]);
    } finally {
      setDecisionInFlight(null);
    }
  }

  function renderDetailDialog(inWorkspace = false) {
    if (!selectedReviewId) {
      return inWorkspace ? (
        <section className="change-review-workspace__empty" aria-label="Patch Review Detail">
          <h2>No patch selected</h2>
          <p>Select a patch review from the queue.</p>
        </section>
      ) : null;
    }

    const frame = (
      <section
        ref={dialogRef}
        className={`change-review-dialog${inWorkspace ? " change-review-workspace__detail" : ""}`}
        role={inWorkspace ? "region" : "dialog"}
        {...(!inWorkspace ? { "aria-modal": true } : {})}
        aria-label="Patch Review Detail"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
          <header className="change-review-dialog__header">
            <div>
              <h2>Patch Review Detail</h2>
              {selected ? (
                <code className="change-review-dialog__hash" title={selected.diffHash}>
                  {shortHash(selected.diffHash)}
                </code>
              ) : null}
            </div>
            <button
              type="button"
              className="change-review-dialog__close"
              aria-label={inWorkspace ? "Close patch review detail" : "Close patch review dialog"}
              disabled={!inWorkspace && (decisionInFlight !== null || applyInFlight)}
              onClick={inWorkspace && onWorkspaceClose ? onWorkspaceClose : closeReview}
            >
              ×
            </button>
          </header>

          <div className="change-review-dialog__body">
            {detailLoading ? (
              <div className="change-review-dialog__placeholder">Loading review...</div>
            ) : null}
            {detailError ? (
              <div className="change-review-panel__alert" role="alert">
                {detailError}
              </div>
            ) : null}

            {selected ? (
              <div className="change-review-dialog__summary">
                <span>{selected.runtimeSource}</span>
                <span>{selected.permissionMode}</span>
                <span>{selected.runtimeWorkspaceStrategy}</span>
                <span>{decisionLabel(selected.decisionState)}</span>
                <span>{applyLabel(selected.applyState)}</span>
                <span>+{selected.addedLines} / -{selected.removedLines}</span>
              </div>
            ) : null}

            {detail ? (
              <section className="change-review-dialog__section" aria-label="Changed files">
                <h3>Changed Files</h3>
                <div className="change-review-dialog__files">
                  {detail.changedFiles.map((file) => (
                    <code key={file.path} title={file.path}>
                      {file.path} +{file.additions}/-{file.deletions}
                    </code>
                  ))}
                </div>
              </section>
            ) : null}

            {detail?.riskReasons.length ? (
              <section className="change-review-dialog__section" aria-label="Risk reasons">
                <h3>Risk Reasons</h3>
                <ul className="change-review-dialog__reasons">
                  {detail.riskReasons.map((reason, index) => (
                    <li key={`${reason.code ?? "risk"}:${index}`}>
                      <code>{reason.code ?? "risk"}</code>
                      {reason.message ? <span>{reason.message}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {detail?.sastAdvisory && detail.sastAdvisory.status !== "skipped" ? (
              <section className="change-review-dialog__section" aria-label="SAST advisory">
                <h3>SAST Advisory</h3>
                <dl className="change-review-dialog__metadata">
                  <div>
                    <dt>Scanner</dt>
                    <dd>{detail.sastAdvisory.scanner}</dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{detail.sastAdvisory.status}</dd>
                  </div>
                  {detail.sastAdvisory.reason ? (
                    <div>
                      <dt>Reason</dt>
                      <dd>{detail.sastAdvisory.reason}</dd>
                    </div>
                  ) : null}
                </dl>
                {detail.sastAdvisory.findings.length > 0 ? (
                  <ul className="change-review-dialog__reasons">
                    {detail.sastAdvisory.findings.slice(0, 5).map((finding, index) => (
                      <li key={`${finding.ruleId}:${finding.path}:${finding.line ?? "?"}:${index}`}>
                        <code>{finding.ruleId}</code>
                        <span>
                          {finding.severity} · {findingLocation(finding)}
                        </span>
                        <span>{finding.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ) : null}

            {detail ? (
              <section className="change-review-dialog__section" aria-label="Runtime metadata">
                <h3>Runtime Metadata</h3>
                <dl className="change-review-dialog__metadata">
                  <div>
                    <dt>Command</dt>
                    <dd>{detail.runtimeSecurity.commandPath ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Sandbox</dt>
                    <dd>{detail.runtimeSecurity.sandboxMode ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>Workspace</dt>
                    <dd>{detail.runtimeSecurity.runtimeWorkspaceStrategy}</dd>
                  </div>
                  <div>
                    <dt>Execution Sandbox</dt>
                    <dd>{formatExecutionSandbox(detail.runtimeSecurity.executionSandbox ?? null)}</dd>
                  </div>
                  <div>
                    <dt>Flags</dt>
                    <dd>{detail.runtimeSecurity.argvFlags.join(" ") || "-"}</dd>
                  </div>
                </dl>
              </section>
            ) : null}

            {diff ? (
              <pre className="change-review-dialog__diff" aria-label="Diff preview" tabIndex={0}>
                <DiffPatchLines patch={diff.patch} />
              </pre>
            ) : null}
            {diff?.truncated ? (
              <div className="change-review-dialog__placeholder">
                Preview truncated at {formatBytes(diff.maxBytes)} of {formatBytes(diff.byteLength)}.
              </div>
            ) : null}

            <label className="change-review-dialog__note">
              <span>Note</span>
              <textarea
                value={note}
                onChange={(event) => {
                  setNote(event.target.value);
                  setDecisionError(null);
                  setApplyError(null);
                }}
                rows={3}
              />
            </label>

            {decisionError ? (
              <div className="change-review-panel__alert" role="alert">
                {decisionError}
              </div>
            ) : null}
          </div>

          {/* Apply preflight banner. The server precomputes whether the
              reviewed patch can still land against the current workspace;
              when it cannot, surface the exact reason before the operator
              wastes a click on Apply. */}
          {detail?.applicability && detail.applicability.applicable === false ? (
            <div className="change-review-panel__alert change-review-panel__alert--stale" role="status">
              <strong>{applicabilityBlockTitle(detail.applicability)}</strong> {detail.applicability.reason}
              {detail.decisionState === "approved" ? applicabilityActionHint(detail.applicability) : null}
            </div>
          ) : null}

          <footer className="change-review-dialog__actions">
            {applyError ? (
              <div className="change-review-panel__alert" role="alert">
                {applyError}
              </div>
            ) : null}
            {detail?.decisionState === "approved" && detail.applyState === "not_applied" ? (
              <button
                type="button"
                className="change-review-dialog__action change-review-dialog__action--primary"
                disabled={
                  !detail ||
                  detailLoading ||
                  decisionInFlight !== null ||
                  applyInFlight ||
                  detail.applicability?.applicable === false
                }
                onClick={() => void submitApply()}
                title={
                  detail?.applicability?.applicable === false
                    ? detail.applicability.reason
                    : undefined
                }
              >
                {applyInFlight ? "Applying..." : "Apply patch to workspace"}
              </button>
            ) : null}
            {/* Supersede button for approved-not-applied rows that the server
                says cannot currently be applied. Without this, an operator
                who approved a now-blocked review has no way to clear the
                row — Apply is disabled and Reject is only for pending rows. */}
            {detail?.decisionState === "approved"
              && detail.applyState === "not_applied"
              && detail.applicability?.applicable === false ? (
              <button
                type="button"
                className="change-review-dialog__action change-review-dialog__action--danger"
                disabled={!detail || detailLoading || decisionInFlight !== null || applyInFlight}
                onClick={() => void submitDiscard()}
                title={detail.applicability.reason}
              >
                {decisionInFlight === "discard" ? "Superseding..." : discardBlockedReviewLabel(detail.applicability)}
              </button>
            ) : null}
            <button
              type="button"
              className="change-review-dialog__action"
              disabled={!detail || detailLoading || decisionInFlight !== null || applyInFlight || detail.decisionState !== "pending"}
              onClick={() => void submitDecision("request_revision")}
            >
              {decisionInFlight === "request_revision" ? "Saving..." : "Request revision"}
            </button>
            <button
              type="button"
              className="change-review-dialog__action change-review-dialog__action--danger"
              disabled={!detail || detailLoading || decisionInFlight !== null || applyInFlight || detail.decisionState !== "pending"}
              onClick={() => void submitDecision("reject")}
            >
              {decisionInFlight === "reject" ? "Saving..." : "Reject"}
            </button>
            <button
              type="button"
              className="change-review-dialog__action change-review-dialog__action--primary"
              disabled={!detail || detailLoading || decisionInFlight !== null || applyInFlight || detail.decisionState !== "pending"}
              onClick={() => void submitDecision("approve")}
            >
              {decisionInFlight === "approve" ? "Applying..." : "Approve & Apply"}
            </button>
          </footer>
        </section>
    );

    if (inWorkspace) return frame;

    return (
      <div
        className="change-review-dialog-backdrop"
        onMouseDown={() => {
          if (decisionInFlight === null && !applyInFlight) closeReview();
        }}
      >
        {frame}
      </div>
    );
  }

  function renderWorkspace() {
    return (
      <section className="change-review-workspace" aria-label="Patch Review Workspace">
        <aside className="change-review-workspace__queue" aria-label="Patch review queue">
          <div className="change-review-workspace__queue-header">
            <div>
              <span className="change-review-bar__eyebrow">Patch Review</span>
              <strong>{actionHeadline(actionableCount)}</strong>
            </div>
            <button
              type="button"
              className="change-review-dialog__action"
              disabled={loading}
              onClick={() => void loadSummaries(true)}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {visibleListError ? (
            <div className="change-review-panel__alert change-review-panel__alert--inline" role="alert">
              <strong>Patch reviews unavailable</strong>
              <span>{visibleListError}</span>
              <button type="button" onClick={dismissListError}>
                Dismiss
              </button>
            </div>
          ) : null}

          {loading && !loaded ? (
            <div className="change-review-workspace__empty">Loading patch reviews...</div>
          ) : null}

          {loaded && summaries.length === 0 && !visibleListError ? (
            <div className="change-review-workspace__empty">No patch reviews for this session.</div>
          ) : null}

          {summaries.length > 0 ? (
            <div className="change-review-workspace__list">
              {summaries.map((review) => (
                <button
                  key={review.id}
                  type="button"
                  className={`change-review-workspace__item${
                    review.id === selectedReviewId ? " change-review-workspace__item--selected" : ""
                  }`}
                  aria-pressed={review.id === selectedReviewId}
                  onClick={(event) => void openReview(review.id, event.currentTarget)}
                >
                  <span className="change-review-workspace__item-title">
                    {review.changedFiles[0]?.path ?? review.id}
                  </span>
                  <span className="change-review-workspace__item-meta">
                    {decisionLabel(review.decisionState)} · {applyLabel(review.applyState)}
                  </span>
                  <span className="change-review-workspace__item-stat">
                    +{review.addedLines} / -{review.removedLines}
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </aside>
        <div className="change-review-workspace__main">
          {renderDetailDialog(true)}
        </div>
      </section>
    );
  }

  if (mode === "workspace") {
    return renderWorkspace();
  }

  const showBar = actionableCount > 0 || Boolean(visibleListError);
  if (!showBar && !selectedReviewId) return null;

  return (
    <>
      {showBar && isActionBarCollapsed && !visibleListError ? (
        <button
          type="button"
          className="change-review-pill"
          aria-label="Show patch review bar"
          onClick={() => setCollapsedActionKey(null)}
        >
          Patch Review · {actionSummaryText}
        </button>
      ) : null}
      {showBar && (!isActionBarCollapsed || visibleListError) ? (
        <section
          className={`change-review-bar${visibleListError ? " change-review-bar--error" : ""}`}
          aria-label="Patch Reviews"
        >
          {visibleListError ? (
            <div className="change-review-bar__copy" role="alert">
              <span className="change-review-bar__eyebrow">Patch Review</span>
              <strong>Patch reviews unavailable</strong>
              <span>{visibleListError}</span>
            </div>
          ) : (
            <>
              <div className="change-review-bar__copy">
                <span className="change-review-bar__eyebrow">Patch Review</span>
                <strong>{actionHeadline(actionableCount)}</strong>
                <span>{actionBreakdownText(actionBreakdown)}</span>
              </div>
              {loading ? <span className="change-review-bar__meta">Refreshing</span> : null}
              <button
                type="button"
                className="change-review-bar__action"
                disabled={!primaryActionReview}
                onClick={(event) => {
                  if (!primaryActionReview) return;
                  void openReview(primaryActionReview.id, event.currentTarget);
                }}
              >
                Review patch
              </button>
              <button
                type="button"
                className="change-review-bar__dismiss"
                aria-label="Collapse patch review bar"
                onClick={() => {
                  if (actionKey.length > 0) setCollapsedActionKey(actionKey);
                }}
              >
                ×
              </button>
            </>
          )}
          {visibleListError ? (
            <button
              type="button"
              className="change-review-bar__dismiss"
              aria-label="Dismiss patch review alert"
              onClick={dismissListError}
            >
              ×
            </button>
          ) : null}
        </section>
      ) : null}
      {renderDetailDialog()}
    </>
  );
}

function mergeSummary(current: ChangeReviewSummary[], next: ChangeReviewSummary) {
  let found = false;
  const merged = current.map((review) => {
    if (review.id !== next.id) return review;
    found = true;
    return next;
  });
  return found ? merged : [next, ...merged];
}

function decisionLabel(state: ChangeReviewDecisionState) {
  switch (state) {
    case "approved":
      return "Approved for apply";
    case "not_required":
      return "Auto OK";
    case "rejected":
      return "Rejected";
    case "superseded":
      return "Superseded";
    case "revision_requested":
      return "Revision requested";
    case "pending":
    default:
      return "Review required";
  }
}

function applyLabel(state: ChangeReviewSummary["applyState"]) {
  switch (state) {
    case "applied":
      return "Applied";
    case "applying":
      return "Applying…";
    case "apply_failed":
      return "Apply failed";
    case "partially_applied":
      return "Partial — manual fix required";
    case "not_applied":
    default:
      return "Not applied";
  }
}

function isActionableReview(review: ChangeReviewSummary): boolean {
  return review.decisionState === "pending"
    || (review.decisionState === "approved" && review.applyState === "not_applied");
}

function actionHeadline(count: number): string {
  return `${count} patch review${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} action`;
}

function actionBreakdownText(breakdown: { toDecide: number; toApply: number }): string {
  const parts: string[] = [];
  if (breakdown.toDecide > 0) {
    parts.push(`${breakdown.toDecide} to review`);
  }
  if (breakdown.toApply > 0) {
    parts.push(`${breakdown.toApply} to apply`);
  }
  return parts.join(" · ");
}

type ApplyApplicabilityBlock = Extract<NonNullable<ChangeReviewDetail["applicability"]>, { applicable: false }>;

function isBaseRevisionApplicabilityIssue(applicability: ApplyApplicabilityBlock): boolean {
  return applicability.code.startsWith("base_revision");
}

function applicabilityBlockTitle(applicability: ApplyApplicabilityBlock): string {
  return isBaseRevisionApplicabilityIssue(applicability) ? "Stale patch." : "Cannot apply patch.";
}

function applicabilityActionHint(applicability: ApplyApplicabilityBlock) {
  if (isBaseRevisionApplicabilityIssue(applicability)) {
    return <> Re-run the agent against the current HEAD or supersede this patch.</>;
  }
  return <> Resolve the workspace state or supersede this patch if it has been replaced.</>;
}

function discardBlockedReviewLabel(_applicability: ApplyApplicabilityBlock): string {
  return "Supersede patch";
}

function shortHash(hash: string) {
  return hash.length <= 16 ? hash : `${hash.slice(0, 12)}...`;
}

function formatExecutionSandbox(
  sandbox: ChangeReviewDetail["runtimeSecurity"]["executionSandbox"] | null,
) {
  if (!sandbox) return "-";
  const base = `${sandbox.mode}/${sandbox.provider}/${sandbox.status}`;
  return sandbox.reason ? `${base} (${sandbox.reason})` : base;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function findingLocation(finding: NonNullable<ChangeReviewDetail["sastAdvisory"]>["findings"][number]) {
  return `${finding.path}${finding.line === null ? "" : `:${finding.line}`}`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed.";
}

function isApiErrorStatus(error: unknown, status: number) {
  return error instanceof ApiError && error.status === status;
}
