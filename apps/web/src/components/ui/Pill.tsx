import type { ReactNode } from "react";
import "./Pill.css";

export type PillTone = "sage" | "ochre" | "red" | "blue" | "neutral";

/**
 * Pill — small uppercase mono tag.
 *
 * Used for source tags (WEB / CLI / FEISHU), state badges,
 * source-kind badges. Replaces ad-hoc inline styling currently
 * duplicated across BoardPage / DashboardPage / SkillList.
 *
 * Spec: §4.4 + §5.2/5.4 of
 * docs/specs/2026-05-16-ui-redesign-p3-spec.md.
 */
export function Pill({
  tone = "neutral",
  children,
}: {
  tone?: PillTone;
  children: ReactNode;
}) {
  return <span className={`magister-pill magister-pill--${tone}`}>{children}</span>;
}
