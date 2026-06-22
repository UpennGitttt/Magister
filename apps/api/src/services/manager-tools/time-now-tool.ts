export function executeTimeNowTool(input?: { now?: () => Date }) {
  const current = input?.now ? input.now() : new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return {
    isoTime: current.toISOString(),
    localTime: current.toLocaleString("sv-SE", {
      hour12: false,
    }),
    timezone,
  };
}
