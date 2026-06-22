const COLORS = ["#635bff", "#16a34a", "#f59e0b", "#dc2626", "#0891b2", "#7c3aed"];
export function AgentAvatar({ name, size = 36 }: { name: string; size?: number }) {
  const initial = name.charAt(0).toUpperCase();
  const colorIndex = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % COLORS.length;
  return (
    <div className="agent-avatar" style={{
      width: size, height: size, borderRadius: size / 2,
      background: COLORS[colorIndex], color: "white",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontSize: size * 0.4, fontWeight: 600,
    }}>
      {initial}
    </div>
  );
}
