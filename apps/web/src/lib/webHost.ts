export const DEFAULT_WEB_HOST = "127.0.0.1";

export function resolveWebHost(env: { [name: string]: string | undefined } = process.env): string {
  const host = env.WEB_HOST?.trim();
  return host || DEFAULT_WEB_HOST;
}

export function isLocalWebHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}
