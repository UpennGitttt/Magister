import type { ReactNode } from "react";
import "./EmptyState.css";

type CtaButton = { label: string; onClick: () => void };
type CtaLink = { label: string; href: string };

function isLinkCta(cta: CtaButton | CtaLink): cta is CtaLink {
  return (cta as CtaLink).href !== undefined;
}

/**
 * EmptyState — centered placeholder for empty lists or panels.
 *
 * Props:
 *   - `icon`        optional mono glyph (e.g. "◇", "▦"). Renders large + muted.
 *   - `title`       required headline.
 *   - `description` optional helper line below the title.
 *   - `cta`         optional call-to-action; either a button (with `onClick`)
 *                   or a link (with `href`).
 *   - `compact`     true → tighter vertical padding for inline list slots.
 *
 * Spec: docs/specs/2026-05-16-ui-redesign-p3-spec.md §6.4.
 */
export function EmptyState({
  icon,
  title,
  description,
  cta,
  compact,
  className,
}: {
  icon?: string;
  title: string;
  description?: ReactNode;
  cta?: CtaButton | CtaLink;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={`magister-empty-state${compact ? " magister-empty-state--compact" : ""}${className ? ` ${className}` : ""}`}
      role="status"
    >
      {icon ? (
        <span className="magister-empty-state__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="magister-empty-state__title">{title}</p>
      {description ? <p className="magister-empty-state__description">{description}</p> : null}
      {cta ? (
        isLinkCta(cta) ? (
          <a className="magister-empty-state__cta" href={cta.href}>
            {cta.label} →
          </a>
        ) : (
          <button type="button" className="magister-empty-state__cta" onClick={cta.onClick}>
            {cta.label} →
          </button>
        )
      ) : null}
    </div>
  );
}
