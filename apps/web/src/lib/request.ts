type ApiEnvelope<T> = {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    [extra: string]: unknown;
  };
};

/** Default request timeout. Browser fetch has no default timeout — a
 *  hung connection can leave a UI in "Still sending..." state forever,
 *  with the stop button stuck because the promise never settles.
 *
 *  Defaults split:
 *   - 30s for write methods (POST/PUT/PATCH/DELETE) — typical work
 *     should complete in <5s; 30s gives slow networks headroom while
 *     still bounding the worst case.
 *   - 60s for GETs — list endpoints can be slow under load; conservative.
 *
 *  Caller can pass `timeoutMs: 0` to disable for legitimately long
 *  operations (SSE establishment, /tasks with big attachment, etc).
 *  Caller can also pass their own `signal` — we wire ours together
 *  with theirs via the timeout AbortController. */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Error class that preserves the full envelope's `error` payload —
 *  use `err instanceof ApiError` to read structured fields like
 *  `references[]` on a 409. Existing callers that just read
 *  `err.message` keep working. */
export class ApiError extends Error {
  readonly code: string | undefined;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  constructor(opts: {
    message: string;
    code?: string;
    status: number;
    details?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = "ApiError";
    this.code = opts.code;
    this.status = opts.status;
    this.details = opts.details;
  }
}

export type RequestOptions = RequestInit & {
  /** Override the default timeout (ms). Pass 0 to disable.
   *  Negative or non-finite values are treated the same as omitting
   *  (uses method default). */
  timeoutMs?: number;
};

/** Resolve the effective timeout in ms.
 *
 *  - `undefined` → method default (30s write, 60s read)
 *  - `0` → explicitly disabled (no timeout)
 *  - finite positive → that exact value
 *  - negative / NaN / Infinity → reject as invalid; fall back to default
 *
 *  Returns 0 when timeout should be disabled, positive ms otherwise.
 */
function resolveTimeoutMs(override: number | undefined, method: string): number {
  const defaultTimeout = WRITE_METHODS.has(method) ? DEFAULT_WRITE_TIMEOUT_MS : DEFAULT_READ_TIMEOUT_MS;
  if (override === undefined) return defaultTimeout;
  if (override === 0) return 0;
  if (!Number.isFinite(override) || override < 0) {
    if (typeof console !== "undefined") {
      console.warn(`[request] invalid timeoutMs=${override}; using ${defaultTimeout}ms default`);
    }
    return defaultTimeout;
  }
  return override;
}

/** Manually compose two AbortSignals into one.
 *
 *  Used when AbortSignal.any is unavailable (Safari < 17.4, Chrome <
 *  116, FF < 124). Aborts as soon as EITHER source aborts and forwards
 *  the reason. The codex reviewer caught the original fallback path
 *  silently dropping the caller's signal — exported contract said
 *  "we compose your signal with ours" but the fallback only used ours.
 */
function combineSignalsFallback(a: AbortSignal, b: AbortSignal): AbortSignal {
  const ctrl = new AbortController();
  const abortOnce = (source: AbortSignal) => {
    if (!ctrl.signal.aborted) {
      // The reason may be undefined on some browsers; fall through to
      // the source signal's name.
      ctrl.abort((source as AbortSignal & { reason?: unknown }).reason);
    }
  };
  if (a.aborted) abortOnce(a);
  else a.addEventListener("abort", () => abortOnce(a), { once: true });
  if (b.aborted) abortOnce(b);
  else b.addEventListener("abort", () => abortOnce(b), { once: true });
  return ctrl.signal;
}

export async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  // Only declare a JSON content-type when we actually send a body.
  // Bodyless POSTs (refresh, cancel, …) with `content-type:
  // application/json` trip Fastify's FST_ERR_CTP_EMPTY_JSON_BODY 400
  // because Fastify's content-type parser refuses an empty payload it
  // was told to JSON-parse.
  const hasBody = init?.body !== undefined && init.body !== null;
  const method = (init?.method ?? "GET").toUpperCase();
  const timeoutMs = resolveTimeoutMs(init?.timeoutMs, method);

  // Compose caller's AbortSignal (if any) with our timeout signal so
  // either source can abort the fetch. AbortSignal.any is widely
  // supported in modern browsers (Chrome 116+, FF 124+, Safari 17.4+);
  // for older runtimes we fall through to a manual two-signal merge so
  // the caller's signal still takes effect.
  const timeoutController = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = timeoutController
    ? setTimeout(() => timeoutController.abort(), timeoutMs)
    : null;
  let signal: AbortSignal | undefined;
  if (timeoutController && init?.signal) {
    signal = typeof AbortSignal.any === "function"
      ? AbortSignal.any([init.signal, timeoutController.signal])
      : combineSignalsFallback(init.signal, timeoutController.signal);
  } else if (timeoutController) {
    signal = timeoutController.signal;
  } else if (init?.signal) {
    signal = init.signal;
  }

  // CRITICAL: the timeout must cover BOTH the connect/headers phase
  // (await fetch) AND the body-read phase (await response.text()).
  // Earlier draft cleared the timer in the fetch-only try/finally,
  // which left `response.text()` unbounded — a server that returns
  // headers but stalls the body would still hang the UI. Now the
  // single try wraps both steps; the timer clears only after parsing
  // succeeds OR an error propagates. (codex GPT-5.5 review BLOCKER.)
  let response: Response;
  let rawBody: string;
  try {
    try {
      response = await fetch(`/api${path}`, {
        ...init,
        ...(signal ? { signal } : {}),
        headers: {
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      if ((err as DOMException | undefined)?.name === "AbortError") {
        if (timeoutController?.signal.aborted) {
          throw new ApiError({
            message: `Request timeout (${timeoutMs}ms): ${path} — server not responding or network error, please retry.`,
            status: 0,
            code: "request_timeout",
          });
        }
        throw err; // caller aborted; bubble up as-is
      }
      throw new Error("Unable to connect to API service. Please check that the server is running.");
    }

    try {
      rawBody = await response.text();
    } catch (err) {
      if ((err as DOMException | undefined)?.name === "AbortError") {
        if (timeoutController?.signal.aborted) {
          throw new ApiError({
            message: `Response body timeout (${timeoutMs}ms): ${path} — connection stalled, please retry.`,
            status: 0,
            code: "response_body_timeout",
          });
        }
        throw err;
      }
      throw new Error("Unable to read response body. Please check your network connection.");
    }
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }

  let payload: ApiEnvelope<T> | undefined;
  if (rawBody.trim()) {
    try {
      payload = JSON.parse(rawBody) as ApiEnvelope<T>;
    } catch {
      // Fall through — non-JSON body, surfaced via the fallback below.
    }
  }

  if (!response.ok || !payload?.ok || payload.data === undefined) {
    // Prefer the envelope's error message; otherwise build something
    // diagnostic from status + truncated body so callers can debug
    // (e.g. Fastify's FST_ERR_CTP_EMPTY_JSON_BODY arrives as a non-
    // envelope 400 — without status+snippet we'd just say "request failed").
    if (payload?.error?.message) {
      const { code, message, ...rest } = payload.error;
      throw new ApiError({
        message,
        code,
        status: response.status,
        ...(Object.keys(rest).length > 0 ? { details: rest } : {}),
      });
    }
    const snippet = rawBody.trim().slice(0, 200);
    throw new ApiError({
      message: `Request failed: ${path} (HTTP ${response.status})${snippet ? ` — ${snippet}` : ""}`,
      status: response.status,
    });
  }

  return payload.data;
}

export async function requestList<T>(path: string): Promise<T[]> {
  const payload = await request<unknown>(path);

  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (payload && typeof payload === "object") {
    const candidate = payload as Record<string, unknown>;
    if (Array.isArray(candidate.items)) {
      return candidate.items as T[];
    }

    if (Array.isArray(candidate.providers)) {
      return candidate.providers as T[];
    }

    if (Array.isArray(candidate.models)) {
      return candidate.models as T[];
    }

    if (Array.isArray(candidate.bindings)) {
      return candidate.bindings as T[];
    }
  }

  return [];
}
