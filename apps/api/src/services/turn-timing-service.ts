type TimingEvent = {
  type: string;
  requestId?: string | null;
  occurredAt: Date;
  payloadJson?: string | null;
};

export type TurnTiming = {
  startedAtMs: number;
  completedAtMs: number;
  wallMs: number;
  pausedMs: number;
  elapsedMs: number;
};

function readPayload(payloadJson?: string | null): Record<string, unknown> {
  if (!payloadJson) return {};
  try {
    const parsed = JSON.parse(payloadJson) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function clampDuration(ms: number): number {
  return Math.max(0, Math.floor(ms));
}

function mergedIntervalDuration(
  intervals: Array<{ startMs: number; endMs: number }>,
  lowerBoundMs: number,
  upperBoundMs: number,
): number {
  const normalized = intervals
    .map((interval) => ({
      startMs: Math.max(lowerBoundMs, interval.startMs),
      endMs: Math.min(upperBoundMs, interval.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  let total = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (const interval of normalized) {
    if (currentStart === null || currentEnd === null) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }

    if (interval.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.endMs);
      continue;
    }

    total += clampDuration(currentEnd - currentStart);
    currentStart = interval.startMs;
    currentEnd = interval.endMs;
  }

  if (currentStart !== null && currentEnd !== null) {
    total += clampDuration(currentEnd - currentStart);
  }

  return total;
}

export function calculateTurnTiming(input: {
  requestId: string;
  startedAtMs: number;
  completedAtMs: number;
  events: TimingEvent[];
}): TurnTiming {
  const activePauses = new Map<string, number>();
  const pauseIntervals: Array<{ startMs: number; endMs: number }> = [];

  const events = input.events
    .filter((event) => event.requestId === input.requestId)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  for (const event of events) {
    const payload = readPayload(event.payloadJson);
    const approvalId = typeof payload.approvalId === "string" ? payload.approvalId : null;
    if (!approvalId) continue;

    if (event.type === "leader.approval_requested") {
      if (!activePauses.has(approvalId)) {
        activePauses.set(approvalId, event.occurredAt.getTime());
      }
    } else if (event.type === "leader.approval_resolved") {
      const started = activePauses.get(approvalId);
      if (started === undefined) continue;
      pauseIntervals.push({
        startMs: started,
        endMs: event.occurredAt.getTime(),
      });
      activePauses.delete(approvalId);
    }
  }

  for (const started of activePauses.values()) {
    pauseIntervals.push({
      startMs: started,
      endMs: input.completedAtMs,
    });
  }

  const wallMs = clampDuration(input.completedAtMs - input.startedAtMs);
  const pausedMs = mergedIntervalDuration(
    pauseIntervals,
    input.startedAtMs,
    input.completedAtMs,
  );
  const clampedPausedMs = Math.min(pausedMs, wallMs);
  return {
    startedAtMs: input.startedAtMs,
    completedAtMs: input.completedAtMs,
    wallMs,
    pausedMs: clampedPausedMs,
    elapsedMs: Math.max(0, wallMs - clampedPausedMs),
  };
}
