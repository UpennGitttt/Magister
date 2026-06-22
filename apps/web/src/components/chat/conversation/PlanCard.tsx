/**
 * PlanCard — the renderer for a `PlanPart`.
 *
 * Renders the agent-proposed plan as markdown with Approve / Revise /
 * Cancel buttons. Buttons post sentinel tokens via the same
 * `sendTaskMessage` API as a typed message, which the leader-loop
 * preflight detects in `autonomous-loop-service.ts`.
 *
 * Spec: `docs/specs/2026-04-26-plan-mode-spec.md` §10.2.
 */

import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { sendTaskMessage } from "../../../lib/api";
import {
  PLAN_TOKEN_APPROVED,
  PLAN_TOKEN_CANCELLED,
  PLAN_TOKEN_REVISED_PREFIX,
} from "./plan-tokens";
import type { PlanPart } from "./types";

type Props = {
  part: PlanPart;
  taskId: string;
};

const STATUS_LABEL: Record<PlanPart["status"], string> = {
  awaiting_approval: "Awaiting your approval",
  approved: "Approved",
  cancelled: "Cancelled",
  revised: "Revising",
};

const STATUS_TONE: Record<PlanPart["status"], "warning" | "success" | "danger" | "muted"> = {
  awaiting_approval: "warning",
  approved: "success",
  cancelled: "danger",
  revised: "muted",
};

export const PlanCard = memo(function PlanCard({ part, taskId }: Props) {
  const [revising, setRevising] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [submitting, setSubmitting] = useState<null | "approve" | "revise" | "cancel">(null);

  const interactive = part.status === "awaiting_approval";

  async function send(content: string, kind: "approve" | "revise" | "cancel") {
    if (submitting) return;
    setSubmitting(kind);
    try {
      await sendTaskMessage(taskId, content);
      // After successful send, the projector will update PlanPart.status
      // when the matching plan_mode_exited event arrives via SSE — no
      // need to optimistically mutate UI state here.
      if (kind === "revise") {
        setRevising(false);
        setFeedback("");
      }
    } catch {
      // Surface failure inline by leaving the buttons re-enabled. The
      // existing SendErrorBar in ChatPage shows the global error banner.
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="message-row message-row--plan">
      <div className={`plan-card plan-card--${STATUS_TONE[part.status]}`}>
        <div className="plan-card__header">
          <span className="plan-card__title" aria-hidden="true">🧭 Plan</span>
          <span className={`plan-card__status plan-card__status--${STATUS_TONE[part.status]}`}>
            {STATUS_LABEL[part.status]}
          </span>
        </div>

        <div className="plan-card__body markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.plan}</ReactMarkdown>
        </div>

        {part.feedback && (
          <div className="plan-card__feedback">
            <strong>Revision feedback:</strong> {part.feedback}
          </div>
        )}

        {interactive && !revising && (
          <div className="plan-card__actions">
            <button
              type="button"
              className="plan-card__btn plan-card__btn--approve"
              disabled={submitting !== null}
              onClick={() => send(PLAN_TOKEN_APPROVED, "approve")}
            >
              {submitting === "approve" ? "..." : "✓ Approve"}
            </button>
            <button
              type="button"
              className="plan-card__btn plan-card__btn--revise"
              disabled={submitting !== null}
              onClick={() => setRevising(true)}
            >
              ✎ Revise
            </button>
            <button
              type="button"
              className="plan-card__btn plan-card__btn--cancel"
              disabled={submitting !== null}
              onClick={() => send(PLAN_TOKEN_CANCELLED, "cancel")}
            >
              {submitting === "cancel" ? "..." : "✗ Cancel"}
            </button>
          </div>
        )}

        {interactive && revising && (
          <div className="plan-card__revise">
            <textarea
              className="plan-card__revise-field"
              rows={3}
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="What should the plan change? (e.g. 'Skip step 2, batch 3 and 4')"
              autoFocus
            />
            <div className="plan-card__actions">
              <button
                type="button"
                className="plan-card__btn plan-card__btn--approve"
                disabled={submitting !== null || !feedback.trim()}
                onClick={() =>
                  send(`${PLAN_TOKEN_REVISED_PREFIX}${feedback.trim()}`, "revise")
                }
              >
                {submitting === "revise" ? "Sending..." : "Submit revision"}
              </button>
              <button
                type="button"
                className="plan-card__btn plan-card__btn--cancel"
                disabled={submitting !== null}
                onClick={() => {
                  setRevising(false);
                  setFeedback("");
                }}
              >
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}, (prev, next) =>
  prev.part.id === next.part.id
  && prev.part.plan === next.part.plan
  && prev.part.status === next.part.status
  && prev.part.feedback === next.part.feedback
  && prev.taskId === next.taskId);
