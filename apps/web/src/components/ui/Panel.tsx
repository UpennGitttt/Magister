import type { ReactNode } from "react";
import "./Panel.css";

/**
 * Panel — bordered card matching the P3 dashboard work-queue look.
 *
 * Slots:
 *   - `title`    (required) heading text, Geist 15px / 600
 *   - `subtitle` (optional) one-line description below the title
 *   - `actions`  (optional) right-side slot in the head (refresh
 *                buttons, filters, etc.)
 *   - `footer`   (optional) bottom row inside the panel border
 *   - children   the body content
 *
 * Spec: §4.4 + §5.2 of
 * docs/specs/2026-05-16-ui-redesign-p3-spec.md.
 */
export function Panel({
  title,
  subtitle,
  actions,
  footer,
  children,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`magister-panel${className ? ` ${className}` : ""}`}>
      <header className="magister-panel__head">
        <div className="magister-panel__head-text">
          <h3 className="magister-panel__title">{title}</h3>
          {subtitle ? <p className="magister-panel__subtitle">{subtitle}</p> : null}
        </div>
        {actions ? <div className="magister-panel__actions">{actions}</div> : null}
      </header>
      {children ? <div className="magister-panel__body">{children}</div> : null}
      {footer ? <footer className="magister-panel__foot">{footer}</footer> : null}
    </section>
  );
}
