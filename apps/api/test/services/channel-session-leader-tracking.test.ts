import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ChannelSessionService } from "../../src/services/channel-session-service";

const tempRoot = join(process.cwd(), ".tmp-channel-session-leader-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `cs-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("recordLeaderSession stores sessionId and runId on channel session", async () => {
  const svc = new ChannelSessionService();
  await svc.ensureForBinding({
    bindingId: "b-1",
    channel: "feishu",
    workspaceId: "ws-1",
  });

  await svc.recordLeaderSession({
    bindingId: "b-1",
    currentLeaderSessionId: "session-abc",
    currentTaskId: "t-1",
  });

  const session = await svc.getByBindingId("b-1");
  expect((session as any)?.currentLeaderSessionId).toBe("session-abc");
  expect(session?.currentTaskId).toBe("t-1");
});

test("getActiveLeaderSession returns session data when present", async () => {
  const svc = new ChannelSessionService();
  await svc.ensureForBinding({
    bindingId: "b-1",
    channel: "feishu",
    workspaceId: "ws-1",
    currentTaskId: "t-1",
  });
  await svc.recordLeaderSession({
    bindingId: "b-1",
    currentLeaderSessionId: "session-abc",
    currentTaskId: "t-1",
  });

  const active = await svc.getActiveLeaderSession("b-1");
  expect(active).not.toBeNull();
  expect(active!.sessionId).toBe("session-abc");
  expect(active!.taskId).toBe("t-1");
});

test("getActiveLeaderSession returns null when no session", async () => {
  const svc = new ChannelSessionService();
  await svc.ensureForBinding({
    bindingId: "b-1",
    channel: "feishu",
    workspaceId: "ws-1",
  });

  const active = await svc.getActiveLeaderSession("b-1");
  expect(active).toBeNull();
});
