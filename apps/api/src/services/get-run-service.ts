import {
  materializeRunSummary,
  type RunSummary,
} from "./materialize-run-summary-service";

export async function getRunSummary(runId: string): Promise<RunSummary | null> {
  return materializeRunSummary(runId);
}
