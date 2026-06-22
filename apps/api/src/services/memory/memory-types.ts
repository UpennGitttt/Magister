export type MemoryScope = "user-global" | "project";

// Typed entries (Phase 1): one type-dir each, multiple entries per dir,
// browsed by description in the <memories> index. Pinned entries
// (Phase 2): single body always-injected in full.
//   - cheatsheet: one per scope, sits at <scope>/cheatsheet.md
//   - scratchpad: one per task, sits at project/scratchpad/<taskId>.md
export type TypedMemoryType = "user" | "project" | "feedback" | "reference";
export type PinnedMemoryType = "cheatsheet" | "scratchpad";
export type MemoryType = TypedMemoryType | PinnedMemoryType;

export const TYPED_MEMORY_TYPES: ReadonlyArray<TypedMemoryType> = [
  "user",
  "project",
  "feedback",
  "reference",
];
export const PINNED_MEMORY_TYPES: ReadonlyArray<PinnedMemoryType> = [
  "cheatsheet",
  "scratchpad",
];

// Sentinel name for the cheatsheet — there's only ever one per scope,
// so the "name" segment of its virtual path is fixed.
export const CHEATSHEET_NAME = "cheatsheet";

export interface MemoryFrontmatter {
  schemaVersion: number;        // current = 1
  name: string;
  description: string;
  type: MemoryType;
  createdAt: string;            // ISO 8601
  lastAccessedAt: string;       // ISO 8601
  supersedes?: string;
  supersededBy?: string;
  related?: string[];
  agingFlag?: "aging" | "stale";
  // Required when `type === "scratchpad"`. Used by the injection
  // builder to pick the right scratchpad for the currently-running
  // task and by task-retention-service to purge orphaned files.
  taskId?: string;
  // Phase 3: snapshot of the workspace's `git rev-parse HEAD` at
  // upsert time. Stamped for typed entries under the `project`
  // scope when the workspace is a git checkout. The aging sweeper
  // compares the anchor against the current HEAD via
  // `git log <anchor>..HEAD` and sets `codeChanged: true` when the
  // referenced code has moved since the entry was written. Absent
  // for user-global entries (they're not pinned to a code state)
  // and for non-git workspaces.
  gitAnchor?: string;
  codeChanged?: boolean;
}

export interface MemoryEntry {
  scope: MemoryScope;
  type: MemoryType;
  name: string;
  path: string;                 // canonical virtual path, e.g. "user-global/feedback/testing-mocks"
  frontmatter: MemoryFrontmatter;
  body: string;                 // markdown body (no frontmatter)
}

export interface MemoryWriteInput {
  path: string;
  description: string;
  body: string;
  supersedes?: string;
  supersededBy?: string;
  related?: string[];
  // Phase 3 A-MEM guard: when true, upsertMemory does NOT fire the
  // post-write link pass. Set by `memory-extractor-service` when it
  // applies its own ops so the link pass doesn't recurse — extractor
  // → upsert → A-MEM → extractor → upsert → ... The user-facing
  // leader tool always leaves this false.
  skipLinkPass?: boolean;
  // P2-#6 (2026-05-15): provenance context. Optional because not every
  // write site can supply both — REST cheatsheet has no taskId, the
  // sweeper writes have neither. When present, they flow through to
  // the `memory_entries` provenance mirror.
  provenance?: {
    taskId?: string;
    requestId?: string;
  };
}

// P0-2 (2026-05-15): every memory mutation must declare a write
// authority. The token is conventional (JS modules have no access
// control — a determined teammate-side caller could still mint one),
// but it forces every new call site to declare intent, makes the
// policy auditable by grep, and trips a runtime guard against
// accidental nullish from a generated/wired path. Five legitimate
// sources today:
//   - leader-tool      : leader's upsert_memory / delete_memory tool
//   - leader-extractor : pre-compact / failure auxiliary-LLM extractor
//   - leader-amem-link : A-MEM link pass via patchMemoryLinks
//   - user-rest        : REST endpoints behind UI auth (cheatsheet)
//   - internal-repair  : on-process repair (delete cascade, sweeper)
// New write sites should audit:
//   1. Caller is in leader autonomous-loop OR authenticated user
//      endpoint.
//   2. Input is leader-controlled reasoning, NOT raw teammate / web
//      / MCP tool output (memory poisoning vector — AgentPoison,
//      NeurIPS 2024).
export type MemoryWriteAuthority =
  | "leader-tool"
  | "leader-extractor"
  | "leader-amem-link"
  | "user-rest"
  | "internal-repair";

export const ALL_MEMORY_WRITE_AUTHORITIES: ReadonlySet<MemoryWriteAuthority> =
  new Set<MemoryWriteAuthority>([
    "leader-tool",
    "leader-extractor",
    "leader-amem-link",
    "user-rest",
    "internal-repair",
  ]);

export const CURRENT_MEMORY_SCHEMA_VERSION = 1 as const;
