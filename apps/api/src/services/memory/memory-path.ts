import { MemoryValidationError } from "./memory-errors";
import {
  CHEATSHEET_NAME,
  TYPED_MEMORY_TYPES,
  type MemoryScope,
  type PinnedMemoryType,
  type TypedMemoryType,
} from "./memory-types";

const VALID_SCOPES: ReadonlySet<MemoryScope> = new Set([
  "user-global",
  "project",
]);
const VALID_TYPED_TYPES: ReadonlySet<TypedMemoryType> = new Set(
  TYPED_MEMORY_TYPES,
);
const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Scratchpad name === taskId — Magister task IDs are random hex/uuid-ish.
// Allow uppercase + underscores too, to match what
// `process-task-intent-service.ts` actually mints.
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export type ParsedMemoryPath =
  | {
      kind: "typed";
      scope: MemoryScope;
      type: TypedMemoryType;
      name: string;
    }
  | {
      kind: "cheatsheet";
      scope: MemoryScope;
      type: Extract<PinnedMemoryType, "cheatsheet">;
      name: typeof CHEATSHEET_NAME;
    }
  | {
      kind: "scratchpad";
      // Scratchpad is project-scope only: a user-global scratchpad
      // can't disambiguate concurrent tasks across workspaces. The
      // decisions doc's tool description explicitly pins it to
      // `project/scratchpad/<task-id>.md`.
      scope: "project";
      type: Extract<PinnedMemoryType, "scratchpad">;
      name: string; // taskId
      taskId: string;
    };

export function parseMemoryPath(virtualPath: string): ParsedMemoryPath {
  if (virtualPath.includes("..") || virtualPath.startsWith("/")) {
    throw new MemoryValidationError(`invalid memory path: ${virtualPath}`);
  }
  const trimmed = virtualPath.endsWith(".md")
    ? virtualPath.slice(0, -3)
    : virtualPath;
  const segments = trimmed.split("/").filter((s) => s.length > 0);
  if (segments.length < 2 || segments.length > 3) {
    throw new MemoryValidationError(
      `invalid memory path shape: ${virtualPath} (expected scope/type/name, scope/cheatsheet, or project/scratchpad/<task-id>)`,
    );
  }
  const scope = segments[0]!;
  if (!VALID_SCOPES.has(scope as MemoryScope)) {
    throw new MemoryValidationError(
      `invalid memory scope: ${scope} (expected: user-global, project)`,
    );
  }
  const typedScope = scope as MemoryScope;

  // Shape A: <scope>/cheatsheet
  if (segments.length === 2) {
    if (segments[1] !== CHEATSHEET_NAME) {
      throw new MemoryValidationError(
        `invalid pinned-memory path: ${virtualPath} (only "<scope>/cheatsheet" is allowed at depth 2)`,
      );
    }
    return {
      kind: "cheatsheet",
      scope: typedScope,
      type: "cheatsheet",
      name: CHEATSHEET_NAME,
    };
  }

  // Shape B: project/scratchpad/<task-id>
  const type = segments[1]!;
  const name = segments[2]!;
  if (type === "scratchpad") {
    if (typedScope !== "project") {
      throw new MemoryValidationError(
        `scratchpad memory must live under project scope (got ${virtualPath})`,
      );
    }
    if (!TASK_ID_PATTERN.test(name)) {
      throw new MemoryValidationError(
        `invalid scratchpad task id: ${name} (expected alphanumeric/underscore/hyphen)`,
      );
    }
    return {
      kind: "scratchpad",
      scope: "project",
      type: "scratchpad",
      name,
      taskId: name,
    };
  }

  // Shape C: <scope>/<typed-type>/<name>
  if (!VALID_TYPED_TYPES.has(type as TypedMemoryType)) {
    throw new MemoryValidationError(
      `invalid memory type: ${type} (expected: user, project, feedback, reference, cheatsheet, scratchpad)`,
    );
  }
  if (!NAME_PATTERN.test(name)) {
    throw new MemoryValidationError(
      `invalid memory name: ${name} (must be kebab-case: lowercase letters, digits, hyphens)`,
    );
  }
  return {
    kind: "typed",
    scope: typedScope,
    type: type as TypedMemoryType,
    name,
  };
}

export function buildMemoryPath(parsed: ParsedMemoryPath): string {
  switch (parsed.kind) {
    case "typed":
      return `${parsed.scope}/${parsed.type}/${parsed.name}`;
    case "cheatsheet":
      return `${parsed.scope}/${CHEATSHEET_NAME}`;
    case "scratchpad":
      return `${parsed.scope}/scratchpad/${parsed.taskId}`;
  }
}
