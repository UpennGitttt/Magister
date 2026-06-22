export function formatRuntimeLabel(runtimeType: string | null | undefined): string {
  const normalized = (runtimeType ?? "ucm").trim().toLowerCase();
  if (normalized === "ucm" || normalized.length === 0) return "Magister";
  if (normalized === "claude-code") return "Claude Code";
  return normalized.toUpperCase();
}
