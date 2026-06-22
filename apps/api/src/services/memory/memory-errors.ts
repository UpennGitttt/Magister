export type MemoryErrorTag =
  | "validation"
  | "capacity"
  | "not_found"
  | "io"
  | "auth";

export class MemoryError extends Error {
  constructor(message: string, public readonly tag: MemoryErrorTag) {
    super(message);
    this.name = "MemoryError";
  }
}

export class MemoryValidationError extends MemoryError {
  constructor(message: string) {
    super(message, "validation");
    this.name = "MemoryValidationError";
  }
}

export class MemoryNotFoundError extends MemoryError {
  constructor(public readonly path: string) {
    super(`Memory not found: ${path}`, "not_found");
    this.name = "MemoryNotFoundError";
  }
}

export class MemoryCapacityError extends MemoryError {
  constructor(message: string) {
    super(message, "capacity");
    this.name = "MemoryCapacityError";
  }
}

export class MemoryIOError extends MemoryError {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message, "io");
    this.name = "MemoryIOError";
    this.cause = cause;
  }
}

// P0-2: thrown when a write call lacks (or carries an invalid)
// MemoryWriteAuthority. The auth is conventional — see the type
// comment in memory-types.ts for the policy.
export class MemoryAuthError extends MemoryError {
  constructor(message: string) {
    super(message, "auth");
    this.name = "MemoryAuthError";
  }
}

export function mapMemoryErrorToHttpStatus(err: unknown): number {
  if (err instanceof MemoryValidationError) return 400;
  if (err instanceof MemoryCapacityError) return 413;
  if (err instanceof MemoryNotFoundError) return 404;
  if (err instanceof MemoryAuthError) return 403;
  if (err instanceof MemoryIOError) return 500;
  return 500;
}
