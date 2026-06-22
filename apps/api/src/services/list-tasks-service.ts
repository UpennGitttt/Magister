import { TaskRepository } from "../repositories/task-repository";
import {
  materializeTaskSummary,
  type TaskSummary,
} from "./materialize-task-summary-service";

export async function listTaskSummaries(opts?: {
  workspaceId?: string | null;
}): Promise<TaskSummary[]> {
  const taskRepository = new TaskRepository();
  const allTasks = await taskRepository.listAll();
  // Path A — workspace filter. Null/undefined returns everything
  // (used by stats / cross-workspace queries). When set, the picker
  // is asking for "tasks belonging to workspace X."
  const filtered = opts?.workspaceId
    ? allTasks.filter((task) => task.workspaceId === opts.workspaceId)
    : allTasks;

  const summaries = await Promise.all(
    filtered.map((task) => materializeTaskSummary(task.id)),
  );

  return summaries
    .filter((summary): summary is TaskSummary => summary !== null)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}
