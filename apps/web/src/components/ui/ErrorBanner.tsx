import "./ErrorBanner.css";

/**
 * ErrorBanner — red-soft inline error notice with optional retry link.
 *
 * Props:
 *   - `title`   required headline.
 *   - `message` optional detail.
 *   - `code`    optional uppercase mono prefix (e.g. "ERR_FETCH").
 *   - `onRetry` optional handler — renders a sage "Retry" affordance.
 *
 * Spec: docs/specs/2026-05-16-ui-redesign-p3-spec.md §6.4.
 */
export function ErrorBanner({
  title,
  message,
  code,
  onRetry,
  className,
}: {
  title: string;
  message?: string;
  code?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div className={`magister-error-banner${className ? ` ${className}` : ""}`} role="alert">
      <div className="magister-error-banner__body">
        <p className="magister-error-banner__title">{title}</p>
        {message ? (
          <p className="magister-error-banner__message">
            {code ? <span className="magister-error-banner__code">{code}</span> : null}
            {message}
          </p>
        ) : null}
      </div>
      {onRetry ? (
        <button type="button" className="magister-error-banner__retry" onClick={onRetry}>
          Retry →
        </button>
      ) : null}
    </div>
  );
}
