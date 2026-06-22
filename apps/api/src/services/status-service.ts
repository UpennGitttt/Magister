import { promises as fs } from "node:fs";
import path from "node:path";

import { eq } from "@magister/db";
import { createDb, mcpServers, tasks } from "@magister/db";

import { listAgentProfiles, getAgentRuntimeType } from "./agent-profile-service";
import { resolveAgentForRole } from "./agent-resolution-service";
import { AgentMcpAttachmentRepository } from "../repositories/agent-mcp-attachment-repository";
import { getMcpPool } from "./mcp-pool-service";
import { listSkillsForAgent } from "./skill-management-service";
import { scanSkillPool } from "./skill-pool-service";
import { discoverCodexSkills } from "./codex-skills/discover-codex-skills";
import { TaskRepository } from "../repositories/task-repository";
import { getTaskUsage } from "./token-usage-service";

/**
 * The shape returned by `GET /status`. Frontend treats this as the
 * single source of truth for the Status tab — keep all field types
 * stable and JSON-serializable.
 */
export type StatusReport = {
  workspace: {
    cwd: string;
    /** AGENTS.md detection — only AGENTS.md, not CLAUDE.md or any
     *  other agents-style spec file. The user explicitly opted into
     *  AGENTS.md as the convention going forward. */
    agentsFile: { found: boolean; path: string | null };
    /** Best-effort git status. `null` if the workspace isn't a git
     *  repo or git isn't installed; callers render that as "(none)". */
    git: { branch: string | null; isClean: boolean | null };
  };
  /** Path A — which workspace this snapshot reflects (id + label).
   *  `null` when no workspaces table is available (legacy / fresh
   *  startup before bootstrap), in which case `workspace.cwd` is
   *  the server's process.cwd(). */
  activeWorkspace: { id: string; label: string } | null;
  agents: Array<{
    roleId: string;
    label: string;
    runtimeType: string;
    modelName: string | null;
    providerLabel: string | null;
    skillsCount: number;
    mcpServersCount: number;
  }>;
  mcp: Array<{
    id: string;
    name: string;
    enabled: boolean;
    /** "connected" | "failed" | "disabled" | "disconnected". `disconnected`
     *  is synthesized for enabled-but-not-yet-connected servers (the
     *  pool only populates an entry after the first connect attempt). */
    status: string;
    toolCount: number | null;
    lastError: string | null;
  }>;
  skills: {
    total: number;
    bySource: { github: number; manual: number };
  };
  /** All tasks currently in EXECUTING state, most-recently-updated
   *  first. Capped at `ACTIVE_TASKS_LIMIT` to keep the response small;
   *  the Recent Tasks dashboard panel covers the unbounded view.
   *  Empty array when nothing is running.
   *
   *  Kimi review M3 — was previously a single nullable record, which
   *  silently misrepresented parallel teammate runs as "one task" or
   *  picked an arbitrary winner. Multi-task is the right contract
   *  forward; keeps the panel honest before B (workspace switching)
   *  lands and concurrent runs become more common. */
  activeTasks: Array<{
    id: string;
    title: string | null;
    state: string;
    startedAt: string;
    updatedAt: string;
  }>;
  /** Per-session block — populated only when buildStatusReport is
   *  called with a `taskId`. Surfaces the chat-thread-level
   *  details (state, leader agent, model, token usage) the
   *  workspace-level snapshot otherwise hides. The `/status` chat
   *  slash command passes the active task id; sidebar Settings →
   *  Status leaves it null. */
  currentSession: {
    taskId: string;
    title: string | null;
    state: string;
    workspaceId: string;
    agent: {
      roleId: string;
      label: string;
      runtimeType: string;
      modelName: string | null;
      providerLabel: string | null;
    } | null;
    startedAt: string;
    updatedAt: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      turnCount: number;
      models: string[];
      /** False when the in-process usage store has zero records for
       *  this task — typically means the server was restarted after
       *  the task ran, since `recordUsage` is process-local. UI can
       *  annotate with "(no usage tracked since restart)" rather
       *  than misleading "0 tokens". (Kimi review M.) */
      tracked: boolean;
    };
  } | null;
};

const ACTIVE_TASKS_LIMIT = 5;

/** AGENTS.md is matched case-insensitively to be friendly to macOS
 *  case-insensitive filesystems and to people who instinctively
 *  type `Agents.md`. Codex's status output uses the title-case form
 *  but the file convention itself is all-caps.
 *
 *  Kimi review M1 — `withFileTypes: true` so a directory accidentally
 *  named `agents.md` doesn't get reported as the spec file. We also
 *  skip symlinks (the underlying target could be anything; if a user
 *  really has AGENTS.md as a symlink we'd rather under-report than
 *  follow into an unexpected path). */
async function detectAgentsFile(cwd: string): Promise<{ found: boolean; path: string | null }> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(cwd, { withFileTypes: true });
  } catch {
    return { found: false, path: null };
  }
  const match = entries.find(
    (entry) => entry.name.toLowerCase() === "agents.md" && entry.isFile(),
  );
  if (!match) return { found: false, path: null };
  return { found: true, path: path.join(cwd, match.name) };
}

/**
 * Resolve the directory holding the `HEAD` file for `cwd`. In a
 * normal repo `.git` is a directory and that's the answer. In a
 * worktree or submodule `.git` is a FILE containing
 * `gitdir: <abs-or-rel path>` — the actual HEAD lives at that path.
 * (Kimi review M2.) Returns null when `cwd` isn't part of any git
 * repo we can read.
 */
async function resolveGitDir(cwd: string): Promise<string | null> {
  const gitPath = path.join(cwd, ".git");
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return gitPath;
  if (stat.isFile()) {
    try {
      const content = await fs.readFile(gitPath, "utf-8");
      const match = content.trim().match(/^gitdir:\s+(.+)$/m);
      if (!match || !match[1]) return null;
      const target = match[1].trim();
      // gitdir paths can be relative (worktree case) or absolute.
      return path.isAbsolute(target) ? target : path.resolve(cwd, target);
    } catch {
      return null;
    }
  }
  return null;
}

async function detectGit(cwd: string): Promise<{ branch: string | null; isClean: boolean | null }> {
  // We avoid spawning `git` here — it's a 50-200 ms hit per status
  // load and the typical user opens this panel multiple times. Read
  // HEAD directly and infer branch; status (clean/dirty) we set to
  // null because computing it cheaply requires an index walk.
  try {
    const gitDir = await resolveGitDir(cwd);
    if (!gitDir) return { branch: null, isClean: null };
    const head = await fs.readFile(path.join(gitDir, "HEAD"), "utf-8");
    const refMatch = head.trim().match(/^ref:\s+refs\/heads\/(.+)$/);
    if (refMatch) return { branch: refMatch[1] ?? null, isClean: null };
    // Detached HEAD — surface the short SHA instead of a branch.
    const sha = head.trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) {
      return { branch: `(detached ${sha.slice(0, 7)})`, isClean: null };
    }
    return { branch: null, isClean: null };
  } catch {
    return { branch: null, isClean: null };
  }
}

/** Coerce a Drizzle DATETIME column (Date | string | number) to an
 *  ISO string. Worth its own helper — the same coercion fires on
 *  every active-task and earlier ad-hoc inline form was duplicated
 *  per field. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string | number).toISOString();
}

/**
 * Build the status snapshot. Each major section is wrapped in its
 * own try/catch  so a DB lock or schema mismatch in
 * one section degrades that section to a placeholder rather than
 * 500ing the whole endpoint. Workspace + agents typically still
 * render even if MCP / skills / activeTasks are broken — that's the
 * point of an aggregate status panel.
 *
 * Path A — `workspaceId` selects which workspace's path/AGENTS.md/git
 * the workspace section reflects. `null`/omitted falls back to the
 * default workspace (and ultimately to process.cwd() if no registry
 * row exists, matching the pre-Path-A behavior).
 */
export async function buildStatusReport(opts?: {
  workspaceId?: string | null;
  /** Optional task id — when present, the response includes a
   *  `currentSession` block describing that specific task (state,
   *  agent, model, token usage). Used by the chat `/status` slash
   *  command to make the panel session-aware rather than purely
   *  workspace-level. */
  taskId?: string | null;
}): Promise<StatusReport & { activeWorkspace: { id: string; label: string } | null }> {
  // Resolve which workspace's view to render. Order:
  //   1. explicit workspaceId arg
  //   2. registry's default
  //   3. ad-hoc — server cwd, no registry row
  let activeWorkspace: { id: string; label: string } | null = null;
  let cwd: string = process.cwd();
  try {
    const { WorkspaceRepository } = await import("../repositories/workspace-repository");
    const repo = new WorkspaceRepository();
    let row = opts?.workspaceId ? await repo.getById(opts.workspaceId) : null;
    // Codex review M1 — when caller passed a taskId but NOT a
    // workspaceId, derive the workspace from the task. Otherwise
    // the panel shows session X (in workspace A) sitting above a
    // workspace block reflecting the registry default (workspace
    // B), which is internally inconsistent.
    if (!row && opts?.taskId) {
      try {
        const taskRepo = new TaskRepository();
        const task = await taskRepo.getById(opts.taskId);
        if (task?.workspaceId) row = await repo.getById(task.workspaceId);
      } catch {
        // best-effort; fall through to default below
      }
    }
    if (!row) row = await repo.getDefault();
    if (row) {
      cwd = row.basePath;
      activeWorkspace = { id: row.id, label: row.label };
    }
  } catch {
    // DB not initialized / table missing — fall back to server cwd.
  }

  const [agentsFile, git] = await Promise.all([detectAgentsFile(cwd), detectGit(cwd)]);

  // --- Agents ---
  let agents: StatusReport["agents"] = [];
  try {
    const profiles = await listAgentProfiles();
    const mcpAttachmentRepo = new AgentMcpAttachmentRepository();
    // Pre-compute the codex effective skill count via the
    // probe-first / scan-fallback discovery service. Codex doesn't
    // just read the Magister pool — it ALSO auto-loads its own bundled
    // .system/ dir and any installed superpowers meta-pack. The
    // discovery service queries codex's own loader (or falls back
    // to scanning all known source dirs) so the count matches what
    // the model actually sees in <skills_instructions>.
    //
    // Result is cached 5 minutes so /status refreshes don't trigger
    // a codex CLI spawn each time.
    const codexDiscovery = await discoverCodexSkills().catch((err) => {
      console.warn("[status-service] codex skill discovery failed:", err);
      return null;
    });
    const codexSkillCount = codexDiscovery?.totalCount ?? 0;
    agents = await Promise.all(
      profiles.map(async (profile) => {
        const resolved = await resolveAgentForRole(profile.roleId).catch(() => null);
        const runtimeType =
          (await getAgentRuntimeType(profile.roleId).catch(() => null)) ??
          profile.runtimeType ??
          "ucm";
        // Effective skill count — what the agent actually sees at
        // runtime, not what's checked in the Skills tab UI:
        //   - codex            → entire pool (auto-discovered)
        //   - claude-code      → symlinks under ~/.claude/skills/
        //   - opencode         → symlinks under ~/.config/opencode/skills/
        //   - ucm (leader / custom) → DB-backed agent_skills rows
        // Side effect: two CLI agents on the same runtime kind
        // (e.g. coder + reviewer both on codex) report the same
        // number — those skills are genuinely shared.
        let skillsCount: number;
        if (runtimeType === "codex") {
          skillsCount = codexSkillCount;
        } else if (runtimeType === "claude-code" || runtimeType === "opencode") {
          const skills = await listSkillsForAgent(runtimeType).catch(() => []);
          skillsCount = skills.length;
        } else {
          const skills = await listSkillsForAgent(profile.roleId).catch(() => []);
          skillsCount = skills.length;
        }
        const mcpAttached = await mcpAttachmentRepo.listForRole(profile.roleId).catch(() => []);
        return {
          roleId: profile.roleId,
          label: profile.label ?? profile.roleId,
          runtimeType,
          modelName: resolved?.modelName ?? null,
          providerLabel: resolved?.provider?.label ?? resolved?.provider?.id ?? null,
          skillsCount,
          mcpServersCount: mcpAttached.length,
        };
      }),
    );
  } catch (err) {
    console.warn("[status-service] failed to build agents section:", err);
  }

  // --- MCP ---
  let mcp: StatusReport["mcp"] = [];
  try {
    const db = createDb();
    const mcpRows = await db.select().from(mcpServers);
    const pool = getMcpPool();
    const mcpStatusMap = pool.statusByServer();
    mcp = mcpRows.map((row) => {
      const live = mcpStatusMap[row.id];
      let status: string;
      let toolCount: number | null = null;
      let lastError: string | null = null;
      if (live?.kind === "connected") {
        status = "connected";
        toolCount = live.toolCount;
      } else if (live?.kind === "failed") {
        status = "failed";
        lastError = live.error;
      } else if (live?.kind === "disabled" || !row.enabled) {
        status = "disabled";
      } else {
        // Enabled but not yet probed — typical right after server
        // start before the first leader runtime spawns.
        status = "disconnected";
      }
      return {
        id: row.id,
        name: row.name,
        enabled: row.enabled === true,
        status,
        toolCount,
        lastError,
      };
    });
  } catch (err) {
    console.warn("[status-service] failed to build mcp section:", err);
  }

  // --- Skills ---
  const skillEntries = await scanSkillPool().catch((err) => {
    console.warn("[status-service] failed to scan skill pool:", err);
    return [];
  });
  const skillsBySource = skillEntries.reduce(
    (acc, s) => {
      if (s.sourceKind === "github") acc.github++;
      else acc.manual++;
      return acc;
    },
    { github: 0, manual: 0 },
  );

  // --- Active tasks ---
  // Kimi review I2 — scope to the resolved workspace so the panel's
  // task list matches the rest of its sections. Without filtering,
  // a task in workspace B would surface in workspace A's status.
  let activeTasks: StatusReport["activeTasks"] = [];
  try {
    const db = createDb();
    const { and, eq: eq2 } = await import("@magister/db");
    const where = activeWorkspace
      ? and(eq(tasks.state, "EXECUTING"), eq2(tasks.workspaceId, activeWorkspace.id))
      : eq(tasks.state, "EXECUTING");
    const executing = await db.query.tasks.findMany({
      where,
      orderBy: (t, { desc }) => [desc(t.updatedAt)],
      limit: ACTIVE_TASKS_LIMIT,
    });
    activeTasks = executing.map((row) => ({
      id: row.id,
      title: row.title ?? null,
      state: row.state ?? "EXECUTING",
      startedAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    }));
  } catch (err) {
    console.warn("[status-service] failed to query active tasks:", err);
  }

  // --- Current session ---
  // Populated only when the caller passed a taskId. The chat
  // `/status` slash command does this so the panel reflects THIS
  // chat thread; sidebar Settings → Status (no task context)
  // leaves it null.
  let currentSession: StatusReport["currentSession"] = null;
  if (opts?.taskId) {
    try {
      const taskRepo = new TaskRepository();
      const task = await taskRepo.getById(opts.taskId);
      if (task) {
        // Manager role drives the leader runtime — that's the model
        // and provider the user sees streaming responses from. Other
        // roles get spawned as teammates from this same chat but
        // aren't the "primary" agent for the session.
        //
        // Kimi review M — `resolveAgentForRole("leader")` returns
        // the CURRENT global config. If the user reconfigured the
        // manager between task creation and now, the live config is
        // a lie about what actually ran. When token usage records
        // exist for this task, the recorded `model` is the truth;
        // prefer that over the resolver.
        const resolved = await resolveAgentForRole("leader").catch(() => null);
        const usage = await getTaskUsage(opts.taskId);
        // Codex review M2 — use `latestModel` from the actual most-
        // recent recordUsage call rather than `models[0]` or `at(-1)`.
        // The `models` array is Set-deduped, so a fallback chain
        // A → B → A leaves models = [A, B] and at(-1) = B even though
        // the latest call was A. `latestModel` is sourced from the
        // last record in insertion order — temporally correct.
        //
        // Codex review M3 — also pull provider from the same record
        // so the (model, provider) pair stays internally consistent.
        // Mixing recorded-model with resolver-current-provider gave
        // the wrong wire backing the model.
        const recordedModel = usage.latestModel;
        const recordedProvider = usage.latestProvider;
        const modelName = recordedModel ?? resolved?.modelName ?? null;
        const providerLabel =
          recordedProvider ??
          resolved?.provider?.label ??
          resolved?.provider?.id ??
          null;

        currentSession = {
          taskId: task.id,
          title: task.title ?? null,
          state: task.state ?? "UNKNOWN",
          workspaceId: task.workspaceId,
          agent: resolved || recordedModel
            ? {
                roleId: "leader",
                label: resolved?.agent.label ?? "leader",
                runtimeType: resolved?.runtimeType ?? "ucm",
                modelName,
                providerLabel,
              }
            : null,
          startedAt: toIso(task.createdAt),
          updatedAt: toIso(task.updatedAt),
          tokenUsage: {
            inputTokens: usage.totalInputTokens,
            outputTokens: usage.totalOutputTokens,
            turnCount: usage.turnCount,
            models: usage.models,
            // P1 — token usage now persists across restarts via the
            // token_usage_records table. `tracked` becomes "this
            // task has any recorded usage at all" rather than "did
            // we still have memory of it post-restart". Frontend
            // already handles the false case as "(no usage tracked)"
            // — appropriate for tasks that genuinely never recorded.
            tracked: usage.turnCount > 0,
          },
        };
      }
    } catch (err) {
      console.warn("[status-service] failed to build currentSession:", err);
    }
  }

  return {
    workspace: {
      cwd,
      agentsFile,
      git,
    },
    activeWorkspace,
    agents,
    mcp,
    skills: {
      total: skillEntries.length,
      bySource: skillsBySource,
    },
    activeTasks,
    currentSession,
  };
}
