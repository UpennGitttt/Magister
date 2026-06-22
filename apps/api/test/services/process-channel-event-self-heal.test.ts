/**
 * resolveConversationBinding self-heal — a Feishu conversation whose bound
 * workspace was deleted out from under it must NOT keep resolving to the
 * dangling id (that stranded the web picker on "Loading…"). It re-points to
 * the default workspace on the next inbound message.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InboundChannelEvent } from "../../src/integrations/feishu/feishu-event-normalizer";

let tempDir = "";
let prevDbPath: string | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "channel-heal-test-"));
  prevDbPath = process.env.MAGISTER_DB_PATH;
  process.env.MAGISTER_DB_PATH = join(
    tempDir,
    `magister-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(async () => {
  if (prevDbPath === undefined) delete process.env.MAGISTER_DB_PATH;
  else process.env.MAGISTER_DB_PATH = prevDbPath;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

function makeEvent(): InboundChannelEvent {
  return {
    channel: "feishu",
    eventId: "evt-new",
    eventType: "message",
    accountId: "acct",
    chatId: "chat",
    sender: { platformUserId: "u1" },
    content: { text: "你好" },
    occurredAt: new Date().toISOString(),
  };
}

test("re-points a binding whose workspace was deleted to the default", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const { ConversationBindingRepository } = await import(
    "../../src/repositories/conversation-binding-repository"
  );
  const { resolveConversationBinding } = await import(
    "../../src/services/process-channel-event-service"
  );

  // workspace_main auto-seeds as the default.
  new WorkspaceRepository();
  const bindingRepo = new ConversationBindingRepository();
  const now = new Date();
  // Binding points at a workspace id that does NOT exist (deleted).
  await bindingRepo.create({
    id: "feishu:acct:chat",
    channel: "feishu",
    accountId: "acct",
    chatId: "chat",
    workspaceId: "kb_deleted",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  const result = await resolveConversationBinding(makeEvent(), bindingRepo);

  expect(result.status).toBe("resolved");
  expect(result.workspaceId).toBe("workspace_main");
  // Binding row itself is healed, not just the response.
  const healed = await bindingRepo.getById("feishu:acct:chat");
  expect(healed?.workspaceId).toBe("workspace_main");
});

test("leaves a binding alone when its workspace still exists", async () => {
  const { WorkspaceRepository } = await import("../../src/repositories/workspace-repository");
  const { ConversationBindingRepository } = await import(
    "../../src/repositories/conversation-binding-repository"
  );
  const { resolveConversationBinding } = await import(
    "../../src/services/process-channel-event-service"
  );

  const wsRepo = new WorkspaceRepository();
  await wsRepo.create({ id: "kb", label: "KB", basePath: "/tmp/kb" });
  const bindingRepo = new ConversationBindingRepository();
  const now = new Date();
  await bindingRepo.create({
    id: "feishu:acct:chat",
    channel: "feishu",
    accountId: "acct",
    chatId: "chat",
    workspaceId: "kb",
    createdAt: now,
    updatedAt: now,
    lastInboundAt: now,
  });

  const result = await resolveConversationBinding(makeEvent(), bindingRepo);

  expect(result.status).toBe("resolved");
  expect(result.workspaceId).toBe("kb");
  const after = await bindingRepo.getById("feishu:acct:chat");
  expect(after?.workspaceId).toBe("kb");
});
