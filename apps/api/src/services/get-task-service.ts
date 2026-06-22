import {
  materializeTaskSummary,
  type TaskSummary,
} from "./materialize-task-summary-service";

export async function getTaskSummary(taskId: string): Promise<TaskSummary | null> {
  return materializeTaskSummary(taskId);
}
