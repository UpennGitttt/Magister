import { expect, test } from "bun:test";

import {
  approvals,
  artifacts,
  channelSessions,
  changeReviews,
  conversationBindings,
  executionEvents,
  mcpToolPolicies,
  roleRuntimes,
  runtimeWorkspaces,
  tasks,
  tokenUsageRecords,
} from "../src/schema";
import { createSqliteClient, ensureDatabaseInitialized } from "../src/client";

test("phase 1 schema exports the core control-plane tables", () => {
  expect(tasks).toBeDefined();
  expect(roleRuntimes).toBeDefined();
  expect(approvals).toBeDefined();
  expect(conversationBindings).toBeDefined();
  expect(channelSessions).toBeDefined();
  expect(artifacts).toBeDefined();
  expect(executionEvents).toBeDefined();
  expect(runtimeWorkspaces).toBeDefined();
  expect(mcpToolPolicies).toBeDefined();
  expect(changeReviews).toBeDefined();
});

test("channel_sessions schema includes verbose_level", () => {
  const sqlite = createSqliteClient();

  try {
    ensureDatabaseInitialized(sqlite);
    const columns = sqlite
      .query("PRAGMA table_info(channel_sessions)")
      .all() as Array<{ name?: string }>;
    const columnNames = new Set(
      columns
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(columnNames.has("verbose_level")).toBe(true);
  } finally {
    sqlite.close();
  }
});

test("execution_events has indexes for session hydration hot paths", () => {
  const sqlite = createSqliteClient();

  try {
    ensureDatabaseInitialized(sqlite);
    const indexes = sqlite
      .query("PRAGMA index_list(execution_events)")
      .all() as Array<{ name?: string }>;
    const indexNames = new Set(
      indexes
        .map((index) => index.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(indexNames.has("idx_exec_events_task_type_occurred_seq")).toBe(true);
    expect(indexNames.has("idx_exec_events_runtime_type_seq")).toBe(true);
    expect(indexNames.has("idx_exec_events_task_request_seq")).toBe(true);
  } finally {
    sqlite.close();
  }
});

test("token_usage_records has an index for per-turn usage aggregation", () => {
  expect(tokenUsageRecords).toBeDefined();
  const sqlite = createSqliteClient();

  try {
    ensureDatabaseInitialized(sqlite);
    const indexes = sqlite
      .query("PRAGMA index_list(token_usage_records)")
      .all() as Array<{ name?: string }>;
    const indexNames = new Set(
      indexes
        .map((index) => index.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(indexNames.has("idx_token_usage_task_request")).toBe(true);
  } finally {
    sqlite.close();
  }
});

test("change review schema creates durable review table", () => {
  const sqlite = createSqliteClient();

  try {
    ensureDatabaseInitialized(sqlite);

    const reviewColumns = sqlite
      .query("PRAGMA table_info(change_reviews)")
      .all() as Array<{ name?: string }>;
    const reviewColumnNames = new Set(
      reviewColumns
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(reviewColumnNames.has("review_draft_artifact_id")).toBe(true);
    expect(reviewColumnNames.has("diff_hash")).toBe(true);
    expect(reviewColumnNames.has("decision_state")).toBe(true);
    expect(reviewColumnNames.has("apply_state")).toBe(true);
    expect(reviewColumnNames.has("sast_advisory_json")).toBe(true);
    expect(reviewColumnNames.has("execution_sandbox_json")).toBe(true);
    // 2026-05-15 (GLM-5.1 review): audit_chain_head is dropped by the
    // migration in client.ts. The audit chain (`change_review_audit_events`
    // table + chain head column) was removed entirely — see the diff
    // landed in this same change. We assert the column is GONE so a
    // future regression that reintroduces it without re-evaluating the
    // threat model trips this test.
    expect(reviewColumnNames.has("audit_chain_head")).toBe(false);

    const reviewIndexes = sqlite
      .query("PRAGMA index_list(change_reviews)")
      .all() as Array<{ name?: string }>;
    const reviewIndexNames = new Set(
      reviewIndexes
        .map((index) => index.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(reviewIndexNames.has("idx_change_reviews_task_created")).toBe(true);
    expect(reviewIndexNames.has("idx_change_reviews_runtime")).toBe(true);
    expect(reviewIndexNames.has("idx_change_reviews_decision_state")).toBe(true);
    expect(reviewIndexNames.has("idx_change_reviews_draft_unique")).toBe(true);

    // The change_review_audit_events table is dropped by the migration.
    // Verify it's actually gone.
    const auditTable = sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='change_review_audit_events'",
      )
      .all() as Array<{ name?: string }>;
    expect(auditTable.length).toBe(0);
  } finally {
    sqlite.close();
  }
});

test("mcp_tool_policies schema creates per-tool policy table and indexes", () => {
  const sqlite = createSqliteClient();

  try {
    ensureDatabaseInitialized(sqlite);

    const columns = sqlite
      .query("PRAGMA table_info(mcp_tool_policies)")
      .all() as Array<{ name?: string }>;
    const columnNames = new Set(
      columns
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(columnNames.has("server_id")).toBe(true);
    expect(columnNames.has("tool_name")).toBe(true);
    expect(columnNames.has("policy")).toBe(true);
    expect(columnNames.has("source")).toBe(true);
    expect(columnNames.has("input_schema_json")).toBe(true);
    expect(columnNames.has("last_discovered_at")).toBe(true);

    const indexes = sqlite
      .query("PRAGMA index_list(mcp_tool_policies)")
      .all() as Array<{ name?: string }>;
    const indexNames = new Set(
      indexes
        .map((index) => index.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0),
    );

    expect(indexNames.has("idx_mcp_tool_policies_server_tool")).toBe(true);
    expect(indexNames.has("idx_mcp_tool_policies_server")).toBe(true);
  } finally {
    sqlite.close();
  }
});
