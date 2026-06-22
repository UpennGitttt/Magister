import "./Skeleton.css";

/**
 * Skeleton — pure-CSS placeholder bars for loading state.
 *
 * Props:
 *   - `lines` how many bars to render (default 3).
 *   - `width` optional CSS width applied to the container.
 *
 * `prefers-reduced-motion: reduce` disables the subtle pulse animation;
 * the bars stay as static grey blocks.
 *
 * Spec: docs/specs/2026-05-16-ui-redesign-p3-spec.md §6.4.
 */
export function Skeleton({
  lines = 3,
  width,
  className,
}: {
  lines?: number;
  width?: string;
  className?: string;
}) {
  const count = Math.max(1, lines);
  return (
    <div
      className={`magister-skeleton${className ? ` ${className}` : ""}`}
      style={width ? { width } : undefined}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="magister-skeleton__line"
          style={{ width: i === count - 1 ? "70%" : "100%" }}
        />
      ))}
    </div>
  );
}
