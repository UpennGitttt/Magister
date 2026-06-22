import { Link, useNavigate, useParams } from "react-router-dom";

import { ChangeReviewPanel } from "../components/chat/ChangeReviewPanel";
import "../styles/chat.css";

export function ChangeReviewPage() {
  const { wid, taskId } = useParams<{ wid?: string; taskId?: string }>();
  const navigate = useNavigate();
  const sessionHref = taskId
    ? wid
      ? `/w/${encodeURIComponent(wid)}/sessions/${encodeURIComponent(taskId)}`
      : `/sessions/${encodeURIComponent(taskId)}`
    : "/sessions";

  return (
    <div className="page change-review-page">
      <header className="page-header change-review-page__header">
        <div>
          <h1 className="page-header__title">Patch Reviews</h1>
          <p className="page-header__desc">
            Review, approve, apply, or supersede isolated subagent patches outside the chat surface.
          </p>
        </div>
        <div className="page-header__actions">
          <Link className="change-review-page__back" to={sessionHref}>
            Back to session
          </Link>
        </div>
      </header>

      <ChangeReviewPanel
        mode="workspace"
        taskId={taskId ?? null}
        onWorkspaceClose={() => {
          if (window.opener) window.close();
          navigate(sessionHref);
        }}
      />
    </div>
  );
}
