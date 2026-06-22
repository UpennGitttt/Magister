import { afterEach, beforeEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  executeRepoStructureTool,
  formatRepoStructureResult,
} from "../../../src/services/manager-tools/repo-structure-tool";

let workspace: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(join(tmpdir(), "magister-repo-struct-"));
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function makeTree(root: string, layout: Record<string, string | null>) {
  for (const [path, content] of Object.entries(layout)) {
    const full = join(root, path);
    if (content === null) {
      await fs.mkdir(full, { recursive: true });
    } else {
      await fs.mkdir(join(full, ".."), { recursive: true });
      await fs.writeFile(full, content);
    }
  }
}

test("executeRepoStructureTool reports isGitRepo=false outside a git checkout", async () => {
  await makeTree(workspace, {
    "src/app.ts": "export const x = 1;\n",
    "README.md": "# hi\n",
  });
  const result = await executeRepoStructureTool({ workspaceDir: workspace });
  expect(result.isGitRepo).toBe(false);
  expect(result.gitFilesHead).toBe("");
  expect(result.topDirsTree).toContain("README.md");
  expect(result.topDirsTree).toContain("src/");
});

test("executeRepoStructureTool returns git ls-files head inside a git repo", async () => {
  await makeTree(workspace, {
    "src/a.ts": "1",
    "src/b.ts": "2",
    "README.md": "3",
  });
  // Make this a real git repo. Tests run sequentially in this file so
  // we don't worry about racing with each other for git config.
  const init = Bun.spawn({
    cmd: ["git", "init", "-q"],
    cwd: workspace,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await init.exited) !== 0) {
    // git not installed; skip
    return;
  }
  await Bun.spawn({
    cmd: ["git", "add", "."],
    cwd: workspace,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const result = await executeRepoStructureTool({ workspaceDir: workspace });
  expect(result.isGitRepo).toBe(true);
  const files = result.gitFilesHead.split("\n");
  expect(files).toContain("README.md");
  expect(files).toContain("src/a.ts");
  expect(files).toContain("src/b.ts");
});

test("executeRepoStructureTool respects filesLimit and surfaces truncation", async () => {
  // Generate 5 files, cap at 2.
  for (let i = 0; i < 5; i++) {
    await fs.writeFile(join(workspace, `f${i}.txt`), String(i));
  }
  const init = Bun.spawn({
    cmd: ["git", "init", "-q"],
    cwd: workspace,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await init.exited) !== 0) return;
  await Bun.spawn({
    cmd: ["git", "add", "."],
    cwd: workspace,
    env: process.env,
    stdout: "ignore",
    stderr: "ignore",
  }).exited;

  const result = await executeRepoStructureTool({
    workspaceDir: workspace,
    filesLimit: 2,
  });
  expect(result.gitFilesHead.split("\n").length).toBe(3); // 2 lines + truncation note
  expect(result.gitFilesHead).toContain("more files omitted");
});

test("executeRepoStructureTool skips node_modules / .git / .magister in tree", async () => {
  await makeTree(workspace, {
    "node_modules/foo/index.js": "1",
    ".git/HEAD": "ref",
    ".magister/uploads/x": "y",
    "src/a.ts": "1",
  });
  const result = await executeRepoStructureTool({
    workspaceDir: workspace,
    depth: 3,
  });
  expect(result.topDirsTree).toContain("src/");
  expect(result.topDirsTree).not.toContain("node_modules");
  expect(result.topDirsTree).not.toContain(".git");
  expect(result.topDirsTree).not.toContain(".magister");
});

test("formatRepoStructureResult produces section headers", async () => {
  await makeTree(workspace, { "src/a.ts": "1" });
  const result = await executeRepoStructureTool({ workspaceDir: workspace });
  const formatted = formatRepoStructureResult(result);
  expect(formatted).toContain("# directory tree");
  expect(formatted).toContain("not a git repository");
});
