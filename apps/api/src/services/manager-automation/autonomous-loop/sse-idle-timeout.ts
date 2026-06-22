/**
 * Idle-timeout guard for streaming reads.
 *
 * `reader.read()` on a provider SSE stream only rejects on a transport
 * error or an explicit AbortSignal. If the upstream (or an intermediary
 * gateway) accepts the connection, emits some bytes, then goes silent
 * WITHOUT closing the socket — common with relay gateways during long
 * "thinking" phases — `read()` never settles. The leader loop consuming
 * it via `for await` then freezes indefinitely: process alive, request
 * stuck, nothing logged.
 *
 * This wrapper races each read against an idle timer. If no chunk
 * arrives within `idleMs`, it rejects with a tagged error so the caller
 * falls into its existing network-error path (retry / model fallback)
 * — and, with the model_error detail change, the failure is recorded.
 *
 * The timer is reset per read (it bounds *inter-chunk* silence, not the
 * total stream duration), so a slow-but-progressing stream is fine.
 */
export const SSE_IDLE_TIMEOUT_MESSAGE = "SSE idle timeout";

/** Default: 120s of total silence between chunks before we give up. */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000;

interface MinimalReader {
  read: () => Promise<ReadableStreamReadResult<Uint8Array>>;
}

export async function readWithIdleTimeout(
  reader: MinimalReader,
  idleMs: number = DEFAULT_SSE_IDLE_TIMEOUT_MS,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${SSE_IDLE_TIMEOUT_MESSAGE} (no data for ${idleMs}ms)`));
    }, idleMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
