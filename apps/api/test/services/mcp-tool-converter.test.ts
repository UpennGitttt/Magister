import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  isMcpToolName,
  mcpToolToLeaderTool,
  namespacedToolName,
  parseMcpToolName,
} from "../../src/services/mcp-tool-converter";

describe("namespacedToolName", () => {
  test("composes mcp__<server>__<tool>", () => {
    expect(namespacedToolName("github", "create_pr")).toBe("mcp__github__create_pr");
  });

  test("sanitizes characters that aren't safe in tool names", () => {
    expect(namespacedToolName("my-server!", "do.thing")).toBe("mcp__my-server___do_thing");
  });
});

describe("isMcpToolName / parseMcpToolName", () => {
  test("recognizes mcp__ prefix as MCP-mediated", () => {
    expect(isMcpToolName("mcp__github__create_pr")).toBe(true);
    expect(isMcpToolName("read_file")).toBe(false);
    expect(isMcpToolName("mcp_read")).toBe(false);
  });

  test("parses back to (server, tool)", () => {
    expect(parseMcpToolName("mcp__github__create_pr")).toEqual({
      serverName: "github",
      toolName: "create_pr",
    });
    expect(parseMcpToolName("not-mcp")).toBeNull();
  });
});

describe("mcpToolToLeaderTool", () => {
  test("translates MCPToolDef to LeaderTool with namespaced name", () => {
    const mcpTool = {
      name: "create_issue",
      description: "Create a new GitHub issue",
      inputSchema: {
        type: "object" as const,
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title"],
      },
    };
    const fakeDispatch = async () => ({ content: [{ type: "text", text: "ok" }] });
    const tool = mcpToolToLeaderTool({
      serverId: "mcp_gh_1",
      serverName: "github",
      mcpTool,
      dispatch: fakeDispatch,
    });

    expect(tool.name).toBe("mcp__github__create_issue");
    expect(tool.description).toContain("Create a new GitHub issue");
    expect(typeof tool.call).toBe("function");
  });

  test("read_only policy marks the LeaderTool as read-only and plan-safe", () => {
    const tool = mcpToolToLeaderTool({
      serverId: "mcp_docs_1",
      serverName: "docs",
      mcpTool: {
        name: "search",
        description: "Search docs",
        inputSchema: { type: "object" as const, properties: {} },
      },
      policy: "read_only",
      dispatch: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });

    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isPlanSafe?.({})).toBe(true);
  });

  test("unknown and mutating policies remain non-read-only", () => {
    for (const policy of ["unknown", "mutating"] as const) {
      const tool = mcpToolToLeaderTool({
        serverId: "mcp_write_1",
        serverName: "writer",
        mcpTool: {
          name: "write",
          description: "Write data",
          inputSchema: { type: "object" as const, properties: {} },
        },
        policy,
        dispatch: async () => ({ content: [{ type: "text", text: "ok" }] }),
      });

      expect(tool.isReadOnly?.({})).toBe(false);
      expect(tool.isPlanSafe?.({})).toBe(false);
    }
  });

  test("call routes through pool's dispatch with original (non-namespaced) MCP tool name", () => {
    const dispatchCalls: Array<{ serverId: string; toolName: string; args: unknown }> = [];
    const fakeDispatch = async (serverId: string, toolName: string, args: Record<string, unknown>) => {
      dispatchCalls.push({ serverId, toolName, args });
      return { content: [{ type: "text", text: "ok" }] };
    };
    const tool = mcpToolToLeaderTool({
      serverId: "mcp_gh_1",
      serverName: "github",
      mcpTool: {
        name: "create_issue",
        description: "x",
        inputSchema: { type: "object" as const, properties: {} },
      },
      dispatch: fakeDispatch,
    });

    return (tool.call as any)({ title: "test" }, { taskId: "t1", abortController: new AbortController() }).then((result: { data: string }) => {
      expect(dispatchCalls).toEqual([
        { serverId: "mcp_gh_1", toolName: "create_issue", args: { title: "test" } },
      ]);
      expect(result.data).toContain("ok");
    });
  });

  test("call with isError=true throws (tool-execution.ts maps throw → tool_result.isError)", async () => {
    // Magister convention: tools surface errors by THROWING; the
    // surrounding loop catches and emits tool_result.isError=true.
    // The MCP protocol uses an `isError` field on the dispatch
    // result — we translate to a throw at the LeaderTool boundary.
    const fakeDispatch = async () => ({
      content: [{ type: "text", text: "permission denied" }],
      isError: true,
    });
    const tool = mcpToolToLeaderTool({
      serverId: "mcp_gh_1",
      serverName: "github",
      mcpTool: { name: "delete_repo", description: "x", inputSchema: { type: "object" as const, properties: {} } },
      dispatch: fakeDispatch,
    });
    await expect(
      (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() }),
    ).rejects.toThrow(/permission denied/);
  });

  test("disconnected server dispatch throws fast (no hang)", async () => {
    // Pool's dispatch checks status and synthesizes an isError
    // result for non-connected servers; converter translates
    // to a throw — never hangs on a broken pipe.
    const fakeDispatch = async () => ({
      content: [{ type: "text", text: 'MCP server "github" is not connected (status: failed)' }],
      isError: true,
    });
    const tool = mcpToolToLeaderTool({
      serverId: "mcp_gh_1",
      serverName: "github",
      mcpTool: { name: "create_issue", description: "x", inputSchema: { type: "object" as const, properties: {} } },
      dispatch: fakeDispatch,
    });
    await expect(
      (tool.call as any)({ title: "test" }, { taskId: "t1", abortController: new AbortController() }),
    ).rejects.toThrow(/not connected/);
  });
});

// ─────────────────────────────────────────────────────────────────
// Spec §2 — MCP image content pass-through (was "Phase 1 not
// supported" before; smoke test for the canonical real-world case).
// ─────────────────────────────────────────────────────────────────

describe("mcpToolToLeaderTool: image / mixed content passthrough (spec §2)", () => {
  test("text-only result returns plain string data (no behavior change)", async () => {
    const tool = mcpToolToLeaderTool({
      serverId: "srv_text",
      serverName: "text-srv",
      mcpTool: { name: "echo", description: "echo", inputSchema: { type: "object" } },
      dispatch: async () => ({ content: [{ type: "text", text: "hello world" }] }),
    });
    const result = await (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() });
    expect(result.data).toBe("hello world");
  });

  test("image-bearing result returns LeaderResultBlock[] with text + image", async () => {
    const tool = mcpToolToLeaderTool({
      serverId: "srv_screen",
      serverName: "playwright",
      mcpTool: { name: "screenshot", description: "x", inputSchema: { type: "object" } },
      dispatch: async () => ({
        content: [
          { type: "text", text: "captured:" },
          { type: "image", mimeType: "image/png", data: "iVBORw0KGgo" },
        ],
      }),
    });
    const result = await (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toHaveLength(2);
    expect(result.data[0]).toEqual({ type: "text", text: "captured:" });
    expect(result.data[1]).toEqual({ type: "image", mediaType: "image/png", data: "iVBORw0KGgo" });
  });

  test("image-only result returns LeaderResultBlock[] with single image", async () => {
    const tool = mcpToolToLeaderTool({
      serverId: "srv_screen",
      serverName: "playwright",
      mcpTool: { name: "screenshot", description: "x", inputSchema: { type: "object" } },
      dispatch: async () => ({
        content: [{ type: "image", mimeType: "image/jpeg", data: "AAA" }],
      }),
    });
    const result = await (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() });
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data[0]).toEqual({ type: "image", mediaType: "image/jpeg", data: "AAA" });
  });

  test("unsupported block type degrades to text placeholder (joined into string when all-text)", async () => {
    const tool = mcpToolToLeaderTool({
      serverId: "srv_audio",
      serverName: "audio-srv",
      mcpTool: { name: "speak", description: "x", inputSchema: { type: "object" } },
      // audio + resource block kinds aren't surfaced as LeaderResultBlock yet
      dispatch: async () => ({
        content: [
          { type: "text", text: "transcript:" },
          { type: "audio", data: "...", mimeType: "audio/wav" } as any,
        ],
      }),
    });
    const result = await (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() });
    // Codex review #3: all-text (incl. unsupported-placeholder) collapses
    // to a single joined string so downstream `typeof data === "string"`
    // checks stay uniform.
    expect(typeof result.data).toBe("string");
    expect(result.data).toContain("transcript:");
    expect(result.data).toContain("unsupported in V1");
  });

  test("all-text multi-block result collapses to joined string (no asymmetry)", async () => {
    // Codex review #3 — pre-fix this returned `LeaderResultBlock[]`,
    // creating a footgun for callers checking `typeof data ===
    // "string"`. Post-fix: all-text payloads always become a string,
    // regardless of how many text blocks the MCP server returned.
    const tool = mcpToolToLeaderTool({
      serverId: "srv_multi",
      serverName: "multi",
      mcpTool: { name: "describe", description: "x", inputSchema: { type: "object" } },
      dispatch: async () => ({
        content: [
          { type: "text", text: "line one" },
          { type: "text", text: "line two" },
        ],
      }),
    });
    const result = await (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() });
    expect(typeof result.data).toBe("string");
    expect(result.data).toBe("line one\nline two");
  });

  test("isError result throws with flattened content (image → placeholder marker)", async () => {
    const tool = mcpToolToLeaderTool({
      serverId: "srv_fail",
      serverName: "fail-srv",
      mcpTool: { name: "broken", description: "x", inputSchema: { type: "object" } },
      dispatch: async () => ({
        content: [
          { type: "text", text: "browser crashed" },
          { type: "image", mimeType: "image/png", data: "ZZ" },
        ],
        isError: true,
      }),
    });
    await expect(
      (tool.call as any)({}, { taskId: "t1", abortController: new AbortController() }),
    ).rejects.toThrow(/browser crashed[\s\S]*\[image: image\/png\]/);
  });
});
