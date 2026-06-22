import { MemoryValidationError } from "./memory-errors";
import {
  CURRENT_MEMORY_SCHEMA_VERSION,
  PINNED_MEMORY_TYPES,
  TYPED_MEMORY_TYPES,
  type MemoryFrontmatter,
  type MemoryType,
} from "./memory-types";

const FM_DELIM = "---";
const VALID_TYPES: ReadonlySet<MemoryType> = new Set<MemoryType>([
  ...TYPED_MEMORY_TYPES,
  ...PINNED_MEMORY_TYPES,
]);

export interface ParsedMemoryFile {
  frontmatter: MemoryFrontmatter;
  body: string;
}

export function parseMemoryFile(raw: string): ParsedMemoryFile {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== FM_DELIM) {
    throw new MemoryValidationError("missing YAML frontmatter delimiter");
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FM_DELIM) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new MemoryValidationError("frontmatter not terminated");
  }
  const fm = parseYamlSubset(lines.slice(1, endIdx));
  validateAndDefaulted(fm);
  const body = lines.slice(endIdx + 1).join("\n");
  return { frontmatter: fm, body };
}

export function formatMemoryFile(
  fm: MemoryFrontmatter,
  body: string
): string {
  const out: string[] = [FM_DELIM];
  out.push(`schemaVersion: ${fm.schemaVersion}`);
  out.push(`name: ${fm.name}`);
  out.push(`description: ${fm.description}`);
  out.push(`type: ${fm.type}`);
  out.push(`createdAt: ${fm.createdAt}`);
  out.push(`lastAccessedAt: ${fm.lastAccessedAt}`);
  if (fm.supersedes) out.push(`supersedes: ${fm.supersedes}`);
  if (fm.supersededBy) out.push(`supersededBy: ${fm.supersededBy}`);
  if (fm.related && fm.related.length > 0) {
    out.push("related:");
    for (const r of fm.related) out.push(`  - ${r}`);
  }
  if (fm.agingFlag) out.push(`agingFlag: ${fm.agingFlag}`);
  if (fm.taskId) out.push(`taskId: ${fm.taskId}`);
  if (fm.gitAnchor) out.push(`gitAnchor: ${fm.gitAnchor}`);
  if (fm.codeChanged !== undefined) out.push(`codeChanged: ${fm.codeChanged}`);
  out.push(FM_DELIM);
  out.push(body.endsWith("\n") ? body : body + "\n");
  return out.join("\n");
}

function parseYamlSubset(yamlLines: string[]): MemoryFrontmatter {
  const result: Record<string, unknown> = {};
  let currentArrayKey: string | null = null;
  let currentArray: string[] | null = null;
  for (const rawLine of yamlLines) {
    if (rawLine.startsWith("  - ") && currentArrayKey && currentArray) {
      currentArray.push(rawLine.slice(4).trim());
      continue;
    }
    currentArrayKey = null;
    currentArray = null;
    if (!rawLine.trim()) continue;
    const colonIdx = rawLine.indexOf(":");
    if (colonIdx === -1) continue;
    const key = rawLine.slice(0, colonIdx).trim();
    const value = rawLine.slice(colonIdx + 1).trim();
    if (value === "") {
      currentArrayKey = key;
      currentArray = [];
      result[key] = currentArray;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      // Inline array form: `related: [a, b, c]`. Without this branch
      // the parser would store the literal string and downstream
      // loops would iterate over individual characters. Reject
      // gracefully if any token has quotes/special chars we don't
      // strip — keep the parser purposely conservative.
      // (Codex final review 2026-05-14.)
      const inner = value.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner.split(",").map((t) => t.trim().replace(/^["']|["']$/g, ""))
              .filter((t) => t.length > 0);
      result[key] = items;
    } else if (key === "schemaVersion") {
      const n = Number(value);
      result[key] = Number.isFinite(n) ? n : 1;
    } else if (key === "codeChanged") {
      // Boolean coercion: YAML `true` / `false` (and the strings
      // we serialize with) flow back as booleans for downstream
      // consumers (sweeper + UI badge) rather than `"true"`.
      result[key] = value.toLowerCase() === "true";
    } else {
      result[key] = value;
    }
  }
  return result as unknown as MemoryFrontmatter;
}

function validateAndDefaulted(fm: MemoryFrontmatter): void {
  if (fm.schemaVersion == null) {
    (fm as unknown as Record<string, unknown>).schemaVersion =
      CURRENT_MEMORY_SCHEMA_VERSION;
  }
  const required: Array<keyof MemoryFrontmatter> = [
    "name",
    "description",
    "type",
    "createdAt",
    "lastAccessedAt",
  ];
  for (const k of required) {
    if (!fm[k]) {
      throw new MemoryValidationError(`frontmatter missing required field: ${k}`);
    }
  }
  if (!VALID_TYPES.has(fm.type)) {
    throw new MemoryValidationError(`frontmatter invalid type: ${fm.type}`);
  }
  // Scratchpad entries are task-scoped — without a taskId we can't
  // attribute the file to a task or purge it during retention sweeps.
  if (fm.type === "scratchpad" && !fm.taskId) {
    throw new MemoryValidationError(
      `frontmatter missing required field: taskId (scratchpad)`,
    );
  }
  // `related` must be an array — a bare string would have come from
  // a malformed inline-array (e.g. `related: notarray`) that the
  // parser stored as-is. Downstream loops iterate, so a string
  // value would iterate over characters — silent corruption.
  if (fm.related !== undefined && !Array.isArray(fm.related)) {
    throw new MemoryValidationError(
      `frontmatter invalid related: expected array, got ${typeof fm.related}`,
    );
  }
}
