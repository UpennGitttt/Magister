import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { resolveInsideWorkspace } from "./workspace-path";

export async function executeListDirTool(input: {
  workspaceDir: string;
  path?: string;
}) {
  const relativePath = input.path?.trim() || ".";
  const result = await resolveInsideWorkspace(input.workspaceDir, relativePath, { intent: "read" });
  if (!result.ok) {
    throw new Error("Path must stay inside the current workspace");
  }
  const resolvedPath = result.resolved;
  const names = await readdir(resolvedPath);
  const entries = await Promise.all(
    names.sort().map(async (name) => {
      const resolvedEntry = resolve(resolvedPath, name);
      const entryStats = await stat(resolvedEntry);
      return {
        name,
        type: entryStats.isDirectory() ? "dir" : "file",
        size: entryStats.isFile() ? entryStats.size : undefined,
      };
    }),
  );

  return {
    path: relativePath,
    entries,
  };
}
