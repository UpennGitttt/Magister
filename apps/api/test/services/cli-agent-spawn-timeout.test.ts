import { describe, expect, test } from "bun:test";
import { spawnCliAgent } from "../../src/services/cli-agent-spawn-service";

describe("spawnCliAgent timeoutMs", () => {
  test("terminates a hung child and reports timeout", async () => {
    const start = Date.now();
    // Use `sh -c "sleep 5"` as the command. Without runtimeType,
    // buildCliArgs returns `[prompt, ...args]`, so we pass prompt="-c"
    // and args=["sleep 5"] → final argv is ["sh", "-c", "sleep 5"].
    // This hangs for 5 seconds unless timeoutMs cuts it short at 200ms,
    // reporting exitCode:-1 + "timed out" stderr.
    const result = await spawnCliAgent({
      command: "sh",
      prompt: "-c",
      args: ["sleep 5"],
      workspaceDir: process.cwd(),
      env: {},
      timeoutMs: 200,
      // No runtimeType — treated as generic command
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("timed out");
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
