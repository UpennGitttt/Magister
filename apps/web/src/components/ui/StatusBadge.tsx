export type StatusBadgeVariant = "success" | "warning" | "danger" | "primary" | "neutral";

/**
 * Status badge — pill with an optional colored leading dot.
 *
 * Per P3 spec (§4.4 of docs/specs/2026-05-16-ui-redesign-p3-spec.md)
 * the five variants map onto the P3 accent palette when the Phase 1
 * Dashboard restyle lands:
 *
 *   success → --sage   (live / running / positive)
 *   warning → --ochre  (blocked / parked / warning)
 *   danger  → --red    (failed / destructive)
 *   primary → --blue   (queued / informational)
 *   neutral → --paper-3 (table head / inert)
 *
 * Today the badge resolves through legacy tokens (`--success`,
 * `--warning`, …) in `layout.css`. Phase 1 will swap those rules onto
 * the P3 palette without changing this component's API.
 */
export function StatusBadge({
  label,
  variant = "neutral",
  dot,
}: {
  label: string;
  variant?: StatusBadgeVariant;
  dot?: boolean;
}) {
  return (
    <span className={`status-badge status-badge--${variant}`}>
      {dot && <span className="status-badge__dot" aria-hidden="true" />}
      {label}
    </span>
  );
}
