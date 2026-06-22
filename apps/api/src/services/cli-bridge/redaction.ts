/**
 * Redact sensitive fields from external MCP server `raw` blobs before
 * exposing them via `/cli-bridge/scan` or `/cli-bridge/drift`. Without
 * this, the API surface broadcasts every CLI's auth headers (including
 * Bearer tokens) — a real leak when Magister is accessed via Tailscale tunnel
 * or any non-loopback bind.
 *
 * Strategy:
 *   - Walk all `headers.*` fields → replace values with "[REDACTED]"
 *   - Walk all `env.*` / `environment.*` fields → same
 *   - Top-level string values matching common secret prefixes
 *     (sk-, sk-ant-, ghp_, gho_, ghs_, ghu_, ghr_, xoxb-, xoxp-,
 *     AKIA[A-Z0-9]{16}, "Bearer ...") → replace
 *
 * Filesystem reads stay unredacted for debugging; only the wire-out
 * shape is sanitized.
 */

const SECRET_VALUE_RE =
  /^(?:sk-[a-zA-Z0-9_-]{16,}|sk-ant-[a-zA-Z0-9_-]{16,}|ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}|ghs_[a-zA-Z0-9]{20,}|ghu_[a-zA-Z0-9]{20,}|ghr_[a-zA-Z0-9]{20,}|xoxb-[a-zA-Z0-9-]+|xoxp-[a-zA-Z0-9-]+|AKIA[A-Z0-9]{16}|Bearer\s+\S{12,})/i;

/**
 * Sensitive top-level keys whose values should always be redacted
 * regardless of value shape. Lower-cased for case-insensitive match.
 */
const SENSITIVE_KEYS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-amz-security-token",
]);
const SENSITIVE_CONTAINERS = new Set(["headers", "env", "environment"]);

const REDACTED = "[REDACTED]";

function redactString(s: string): string {
  return SECRET_VALUE_RE.test(s) ? REDACTED : s;
}

function redactAllStrings(value: unknown): unknown {
  if (typeof value === "string") return REDACTED;
  if (Array.isArray(value)) return value.map(redactAllStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactAllStrings(v);
    return out;
  }
  return value;
}

function redactRecord(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (SENSITIVE_CONTAINERS.has(k.toLowerCase())) {
      out[k] = redactAllStrings(v);
      continue;
    }
    if (typeof v === "string") {
      // Sensitive key → blanket redact regardless of value
      if (SENSITIVE_KEYS.has(k.toLowerCase())) {
        out[k] = REDACTED;
      } else {
        out[k] = redactString(v);
      }
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = redactRecord(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Redact a single MCP-config blob. Returns a new object; doesn't mutate.
 */
export function redactMcpConfig<T extends Record<string, unknown>>(raw: T): T {
  return redactRecord(raw) as T;
}
