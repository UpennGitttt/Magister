import { parseManagerDecision, type ManagerDecision } from "./manager-decision-schema";

export type ManagerDecisionFallbackReason =
  | "missing_output"
  | "invalid_json"
  | "invalid_decision"
  | "artifact_file_unreadable";

export type ManagerDecisionSourceKind = "artifact_file" | "artifact_summary" | "artifact_title";

export type ManagerDecisionExtraction = {
  parsedDecision: ManagerDecision | null;
  rawOutput: string | null;
  fallbackReason: ManagerDecisionFallbackReason | null;
  sourceKind: ManagerDecisionSourceKind;
  sourceDegraded: boolean;
  sourceUnavailableReason: "artifact_file_unreadable" | null;
};

function extractJsonCandidates(text: string) {
  const trimmed = text.trim();
  const candidates = [trimmed];

  const fencedMatches = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of fencedMatches) {
    const fencedBody = match[1]?.trim();
    if (fencedBody) {
      candidates.push(fencedBody);
    }
  }

  return candidates.filter((candidate, index, array) => candidate.length > 0 && array.indexOf(candidate) === index);
}

function tryParseManagerDecision(candidate: string) {
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

export function extractManagerDecisionOutput(value: string | null | undefined): ManagerDecisionExtraction {
  const rawOutput = value?.trim() ?? null;
  if (!rawOutput) {
    return {
      parsedDecision: null,
      rawOutput: null,
      fallbackReason: "missing_output",
      sourceKind: "artifact_file",
      sourceDegraded: false,
      sourceUnavailableReason: null,
    };
  }

  const candidates = extractJsonCandidates(rawOutput);
  let sawJsonParseCandidate = false;

  for (const candidate of candidates) {
    const parsed = tryParseManagerDecision(candidate);
    if (parsed === null) {
      continue;
    }

    sawJsonParseCandidate = true;
    const decision = parseManagerDecision(parsed);
    if (decision) {
      return {
        parsedDecision: decision,
        rawOutput,
        fallbackReason: null,
        sourceKind: "artifact_file",
        sourceDegraded: false,
        sourceUnavailableReason: null,
      };
    }
  }

  const hasJsonParseCandidate = candidates.some((candidate) => {
    try {
      JSON.parse(candidate);
      return true;
    } catch {
      return false;
    }
  });

  return {
    parsedDecision: null,
    rawOutput,
    fallbackReason: hasJsonParseCandidate || sawJsonParseCandidate ? "invalid_decision" : "invalid_json",
    sourceKind: "artifact_file",
    sourceDegraded: false,
    sourceUnavailableReason: null,
  };
}
