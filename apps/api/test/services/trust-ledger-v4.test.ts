/**
 * Sandbox-elevation v4.3 trust-ledger v4 helpers — unit tests
 * for the codex+kimi Slice-3 review fixes:
 *   - findCoveringPermissionGrant (BLOCKER Q3c)
 *   - findCoveringPermissionGrantExpiry (HIGH Q1a)
 *   - consumeExpiredAdditionalPermissionsForTask (HIGH Q1d)
 *   - split-entry independent revocation (BLOCKER Q2)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  __clearAllApprovalTrustForTests,
  addApprovalTrust,
  consumeExpiredAdditionalPermissionsForTask,
  findCoveringPermissionGrant,
  findCoveringPermissionGrantExpiry,
  findGrantedAdditionalPermissions,
  isTrustedForApproval,
} from "../../src/services/command-approval-service";

const TASK = "task_trust_v4_test";

beforeEach(() => {
  __clearAllApprovalTrustForTests();
});

afterEach(() => {
  __clearAllApprovalTrustForTests();
});

describe("findCoveringPermissionGrant — subset check (BLOCKER Q3c)", () => {
  test("returns null when ledger has no entries", () => {
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
    })).toBeNull();
  });

  test("returns matched profile when request is fully covered", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/cache/uv", access: "write" }, { path: "/gitconfig", access: "read" }] },
      },
    });
    const result = findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
    });
    expect(result).not.toBeNull();
    expect(result?.file_system?.entries.length).toBe(2);
  });

  test("returns null when requested path is NOT in grant", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
      },
    });
    const result = findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/some/other/path", access: "read" }] },
    });
    expect(result).toBeNull();
  });

  test("write covers read (req read /a + grant write /a → covered)", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "write" }] },
      },
    });
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/a", access: "read" }] },
    })).not.toBeNull();
  });

  test("read does NOT cover write (req write /a + grant read /a → not covered)", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "read" }] },
      },
    });
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/a", access: "write" }] },
    })).toBeNull();
  });

  test("network coverage required", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "read" }] },
        // No network in grant
      },
    });
    expect(findCoveringPermissionGrant(TASK, {
      network: { enabled: true },
      file_system: { entries: [{ path: "/a", access: "read" }] },
    })).toBeNull();
  });
});

describe("split-entry independent gates (BLOCKER Q2)", () => {
  test("permission-only entry (paths:*) does NOT match wildcard '*' lookup", () => {
    // This is the v4.3 split-entry design: a permission grant should
    // NOT auto-trust unrelated require_escalated calls.
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
      },
    });
    // The require_escalated path uses isTrustedForApproval("*") — must NOT match.
    expect(isTrustedForApproval(TASK, "bash", "*")).toBe(false);
  });

  test("pattern-only entry ('*') DOES match wildcard lookup (v3 dangerous-command behavior preserved)", () => {
    addApprovalTrust(TASK, "bash", "*", null, {
      dangerousCommandPattern: "rm -rf",
    });
    expect(isTrustedForApproval(TASK, "bash", "*")).toBe(true);
  });

  test("both gates present: wildcard entry triggers '*' match; paths entry triggers subset match", () => {
    // Approval with BOTH dangerousCommandPattern + additionalPermissions
    // writes TWO entries (per routes/approvals.ts):
    addApprovalTrust(TASK, "bash", "*", null, {
      dangerousCommandPattern: "rm -rf",
    });
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
      },
    });
    expect(isTrustedForApproval(TASK, "bash", "*")).toBe(true);
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/cache/uv", access: "write" }] },
    })).not.toBeNull();
  });
});

describe("findCoveringPermissionGrantExpiry — actual scope reflection (HIGH Q1a)", () => {
  test("task-scope entry returns expiry > now+1h", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {  // null = task scope → 72h cap
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "write" }] },
      },
    });
    const expiry = findCoveringPermissionGrantExpiry(TASK, {
      file_system: { entries: [{ path: "/a", access: "write" }] },
    });
    expect(expiry).not.toBeNull();
    expect(expiry!).toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  });

  test("5-min entry returns expiry < now+1h", () => {
    addApprovalTrust(TASK, "bash", "paths:*", 5 * 60 * 1000, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "write" }] },
      },
    });
    const expiry = findCoveringPermissionGrantExpiry(TASK, {
      file_system: { entries: [{ path: "/a", access: "write" }] },
    });
    expect(expiry).not.toBeNull();
    expect(expiry!).toBeLessThan(Date.now() + 60 * 60 * 1000);
  });

  test("no covering entry returns null", () => {
    expect(findCoveringPermissionGrantExpiry(TASK, {
      file_system: { entries: [{ path: "/a", access: "write" }] },
    })).toBeNull();
  });
});

describe("consumeExpiredAdditionalPermissionsForTask (HIGH Q1d)", () => {
  test("returns empty when no entries", () => {
    expect(consumeExpiredAdditionalPermissionsForTask(TASK)).toEqual([]);
  });

  test("returns expired entries' paths + removes them from ledger", () => {
    // Use durationMs=0 → expiry = now → instantly expired
    addApprovalTrust(TASK, "bash", "paths:*", 0, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "write" }] },
      },
    });
    // Wait a tick to ensure expiry < now
    const beforeNow = Date.now();
    const result = consumeExpiredAdditionalPermissionsForTask(TASK);
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe("/a");
    expect(result[0]!.access).toBe("write");
    expect(result[0]!.expiredAtMs).toBeLessThanOrEqual(beforeNow);

    // Subsequent call returns nothing (one-shot)
    expect(consumeExpiredAdditionalPermissionsForTask(TASK)).toEqual([]);
  });

  test("active grants are NOT consumed (only expired)", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {  // task scope, far future
      additionalPermissions: {
        file_system: { entries: [{ path: "/active", access: "write" }] },
      },
    });
    addApprovalTrust(TASK, "bash", "paths:*", 0, {  // instantly expired
      additionalPermissions: {
        file_system: { entries: [{ path: "/expired", access: "read" }] },
      },
    });
    const result = consumeExpiredAdditionalPermissionsForTask(TASK);
    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe("/expired");

    // Active grant survives
    expect(findCoveringPermissionGrant(TASK, {
      file_system: { entries: [{ path: "/active", access: "write" }] },
    })).not.toBeNull();
  });
});

describe("addApprovalTrust 72h cap on task scope", () => {
  test("durationMs=null (task scope) capped at 72h from now", () => {
    addApprovalTrust(TASK, "bash", "*", null);
    // We can't read the entry directly, but we can verify via behavior:
    // a task-scope entry should NOT have expiry === POSITIVE_INFINITY
    // (regression test for codex+kimi v4.1 review item 10).
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: { file_system: { entries: [{ path: "/a", access: "read" }] } },
    });
    const expiry = findCoveringPermissionGrantExpiry(TASK, {
      file_system: { entries: [{ path: "/a", access: "read" }] },
    });
    expect(expiry).not.toBeNull();
    // Hard ceiling at 72h
    expect(expiry!).toBeLessThanOrEqual(Date.now() + 72 * 60 * 60 * 1000 + 1000);
    expect(expiry!).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });
});

describe("findGrantedAdditionalPermissions union across multiple grants", () => {
  test("unions file_system entries with write-covers-read", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "read" }] },
      },
    });
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "write" }] },
      },
    });
    const union = findGrantedAdditionalPermissions(TASK, "bash");
    expect(union?.file_system?.entries.length).toBe(1);
    // write wins over read
    expect(union?.file_system?.entries[0]!.access).toBe("write");
  });

  test("network enabled if ANY entry enables it", () => {
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        file_system: { entries: [{ path: "/a", access: "read" }] },
      },
    });
    addApprovalTrust(TASK, "bash", "paths:*", null, {
      additionalPermissions: {
        network: { enabled: true },
        file_system: { entries: [{ path: "/b", access: "read" }] },
      },
    });
    const union = findGrantedAdditionalPermissions(TASK, "bash");
    expect(union?.network?.enabled).toBe(true);
  });

  test("returns null when no permission entries (only pattern entries)", () => {
    addApprovalTrust(TASK, "bash", "*", null, {
      dangerousCommandPattern: "rm -rf",
    });
    expect(findGrantedAdditionalPermissions(TASK, "bash")).toBeNull();
  });
});
