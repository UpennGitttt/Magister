import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeManagerTool } from "../../src/services/manager-tool-service";

const tempDirs: string[] = [];

function createTempWorkspace(prefix = "ultimate-manager-tools-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("time_now returns local wall-clock information", async () => {
  const workspaceDir = createTempWorkspace();
  const fixedNow = new Date("2026-04-18T05:40:00.000Z");

  const observation = await executeManagerTool({
    workspaceDir,
    toolName: "time_now",
    arguments: {},
    now: () => fixedNow,
  });

  expect(observation).toMatchObject({
    toolName: "time_now",
    ok: true,
  });
  expect(observation.result).toEqual(
    expect.objectContaining({
      isoTime: "2026-04-18T05:40:00.000Z",
      localTime: expect.stringContaining("2026-04-18"),
    }),
  );
});

test("read_file reads files in workspace only", async () => {
  const workspaceDir = createTempWorkspace();
  writeFileSync(join(workspaceDir, "notes.txt"), "line1\nline2\nline3\n", "utf8");

  const insideObservation = await executeManagerTool({
    workspaceDir,
    toolName: "read_file",
    arguments: {
      path: "notes.txt",
      startLine: 2,
      endLine: 3,
    },
  });

  expect(insideObservation.ok).toBe(true);
  expect(insideObservation.result).toEqual(
    expect.objectContaining({
      path: "notes.txt",
      startLine: 2,
      endLine: 3,
      content: "line2\nline3",
    }),
  );

  const outsideObservation = await executeManagerTool({
    workspaceDir,
    toolName: "read_file",
    arguments: {
      path: "../outside.txt",
    },
  });

  expect(outsideObservation).toMatchObject({
    toolName: "read_file",
    ok: false,
  });
  expect(outsideObservation.error).toContain("workspace");
});

test("list_dir respects workspace boundary", async () => {
  const workspaceDir = createTempWorkspace();
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(join(workspaceDir, "src", "index.ts"), "export const ok = true;\n", "utf8");

  const insideObservation = await executeManagerTool({
    workspaceDir,
    toolName: "list_dir",
    arguments: {
      path: "src",
    },
  });

  expect(insideObservation.ok).toBe(true);
  expect(insideObservation.result).toEqual(
    expect.objectContaining({
      path: "src",
      entries: [expect.objectContaining({ name: "index.ts", type: "file" })],
    }),
  );

  const outsideObservation = await executeManagerTool({
    workspaceDir,
    toolName: "list_dir",
    arguments: {
      path: "..",
    },
  });
  expect(outsideObservation.ok).toBe(false);
  expect(outsideObservation.error).toContain("workspace");
});

test("grep_repo returns structured matches", async () => {
  const workspaceDir = createTempWorkspace();
  mkdirSync(join(workspaceDir, "src"), { recursive: true });
  writeFileSync(
    join(workspaceDir, "src", "grep-target.ts"),
    ["const alpha = 1;", "// TODO: make this configurable", "export { alpha };"].join("\n"),
    "utf8",
  );

  const observation = await executeManagerTool({
    workspaceDir,
    toolName: "grep_repo",
    arguments: {
      query: "TODO",
    },
  });

  expect(observation).toMatchObject({
    toolName: "grep_repo",
    ok: true,
  });
  expect(observation.result).toEqual(
    expect.objectContaining({
      query: "TODO",
      matches: [
        expect.objectContaining({
          path: "src/grep-target.ts",
          line: 2,
          snippet: expect.stringContaining("TODO"),
        }),
      ],
    }),
  );
});

test("bash returns compact stdout and stderr summaries", async () => {
  const workspaceDir = createTempWorkspace();

  const observation = await executeManagerTool({
    workspaceDir,
    toolName: "bash",
    arguments: {
      command: "echo hello; echo warn >&2",
    },
  });

  expect(observation.toolName).toBe("bash");
  expect(observation.ok).toBe(true);
  expect(observation.result).toEqual(
    expect.objectContaining({
      exitCode: 0,
      stdout: expect.stringContaining("hello"),
      stderr: expect.stringContaining("warn"),
    }),
  );
  expect(observation.summary).toContain("exit 0");
});

test("web_search returns structured Tavily observations", async () => {
  const workspaceDir = createTempWorkspace();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const observation = await executeManagerTool({
    workspaceDir,
    toolName: "web_search",
    arguments: {
      query: "latest ai news",
      maxResults: 3,
    },
    tavilyConfig: {
      enabled: true,
      apiKey: "tvly-test-key",
      baseUrl: "https://api.tavily.com/search",
      timeoutSeconds: 30,
    },
    fetchImpl: (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          answer: "Two major AI model launches happened this week.",
          results: [
            {
              title: "Example News",
              url: "https://example.com/news",
              content: "A compact summary about model launches.",
              score: 0.98,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
  });

  expect(observation.ok).toBe(true);
  expect(observation.result).toEqual(
    expect.objectContaining({
      query: "latest ai news",
      answer: expect.stringContaining("AI model launches"),
      results: [expect.objectContaining({ url: "https://example.com/news" })],
    }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api.tavily.com/search");
});

test("web_fetch returns structured extracted content summaries", async () => {
  const workspaceDir = createTempWorkspace();
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  const observation = await executeManagerTool({
    workspaceDir,
    toolName: "web_fetch",
    arguments: {
      url: "https://example.com/docs",
    },
    tavilyConfig: {
      enabled: true,
      apiKey: "tvly-test-key",
      baseUrl: "https://api.tavily.com/search",
      timeoutSeconds: 30,
    },
    fetchImpl: (async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });

      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://example.com/docs",
              raw_content:
                "This is a long technical article about manager loops and how to design capability-driven orchestration safely.",
              title: "Manager Loop Design",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch,
  });

  expect(observation.ok).toBe(true);
  expect(observation.result).toEqual(
    expect.objectContaining({
      url: "https://example.com/docs",
      title: "Manager Loop Design",
      excerpt: expect.stringContaining("capability-driven orchestration"),
    }),
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe("https://api.tavily.com/extract");
});

