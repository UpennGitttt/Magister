import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-channel-single-flight-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `channel-sf-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

/**
 * Channel resume single-flight: when a leader run is already live
 * for a task, a follow-up prompt from Feishu/Slack routes to the
 * mailbox instead of starting a second concurrent loop (which would
 * clobber checkpoints + double-run bash side-effects). Parity with
 * the Web POST /tasks/:id/messages path.
 */
test("channel resume routes to mailbox when a run is already live", async () => {
  // Import services
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");
  const { registerAbortController, removeAbortController } = await import("../../src/services/task-worker");
  const { TaskMailboxRepository } = await import("../../src/repositories/task-mailbox-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ConversationBindingRepository } = await import("../../src/repositories/conversation-binding-repository");

  const workspaceId = "ws_test";
  const bindingId = `binding_${Date.now()}`;

  // Seed: create a conversation binding (minimal required fields)
  const bindingRepo = new ConversationBindingRepository();
  await bindingRepo.create({
    id: bindingId,
    channel: "slack",
    accountId: "A123",
    chatId: "C123",
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastInboundAt: new Date(),
  });

  // Seed: create an initial task with active leader session
  const taskId = `task_${Date.now()}`;
  const runId = `rt_leader_${Date.now()}`;
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();

  await taskRepo.create({
    id: taskId,
    workspaceId,
    source: "slack",
    title: "initial prompt",
    state: "EXECUTING",
    createdBy: "u1",
    createdAt: new Date(),
    updatedAt: new Date(),
    rootChannelBindingId: bindingId,
  });

  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    updatedAt: new Date(),
  });

  // Register a live AbortController for this task (simulates an ongoing run)
  const liveAc = new AbortController();
  registerAbortController(taskId, liveAc);

  // Create a channel session with active leader session
  const { ChannelSessionRepository } = await import("../../src/repositories/channel-session-repository");
  const sessionRepo = new ChannelSessionRepository();
  await sessionRepo.create({
    id: bindingId,
    bindingId,
    channel: "slack",
    workspaceId,
    continuityMode: "top_level_preferred",
    verboseLevel: "off",
    currentTaskId: taskId,
    currentLeaderSessionId: runId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  try {
    const mailbox = new TaskMailboxRepository();
    const mailboxBefore = await mailbox.listByTaskId(taskId);

    // Act: send a follow-up prompt while the run is live
    const result = await processTaskIntent({
      prompt: "second message while run is live",
      source: "slack",
      workspaceId,
      channelBindingId: bindingId,
      rootChannelBindingId: bindingId,
      createdBy: "u1",
    });

    // Assert: mailbox row was created
    const mailboxAfter = await mailbox.listByTaskId(taskId);
    expect(mailboxAfter.length).toBe(mailboxBefore.length + 1);
    expect(mailboxAfter[mailboxAfter.length - 1]?.content).toBe("second message while run is live");

    // Assert: result indicates resumed session
    expect(result.action).toBe("resumed_session");
    expect(result.taskId).toBe(taskId);

    // Assert: NO synchronous finalAnswer (since it routed to mailbox)
    expect(result.finalAnswer).toBeUndefined();
  } finally {
    // Cleanup: remove the registered AbortController
    removeAbortController(taskId);
  }
});

/**
 * Regression: when NO run is live, channel resume still executes
 * synchronously (existing behavior). This test verifies the guard
 * does NOT block execution when no AbortController is registered.
 */
test("channel resume executes synchronously when no run is live", async () => {
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");
  const { getAbortController } = await import("../../src/services/task-worker");
  const { TaskMailboxRepository } = await import("../../src/repositories/task-mailbox-repository");
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ConversationBindingRepository } = await import("../../src/repositories/conversation-binding-repository");

  const workspaceId = "ws_test2";
  const bindingId = `binding_${Date.now()}`;

  // Seed: conversation binding
  const bindingRepo = new ConversationBindingRepository();
  await bindingRepo.create({
    id: bindingId,
    channel: "feishu",
    accountId: "A456",
    chatId: "C456",
    workspaceId,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastInboundAt: new Date(),
  });

  // Seed: task + runtime (NO live AbortController registered)
  const taskId = `task_${Date.now()}`;
  const runId = `rt_leader_${Date.now()}`;
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();

  await taskRepo.create({
    id: taskId,
    workspaceId,
    source: "feishu",
    title: "initial prompt",
    state: "EXECUTING",
    createdBy: "u2",
    createdAt: new Date(),
    updatedAt: new Date(),
    rootChannelBindingId: bindingId,
  });

  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    updatedAt: new Date(),
  });

  // Create channel session
  const { ChannelSessionRepository } = await import("../../src/repositories/channel-session-repository");
  const sessionRepo = new ChannelSessionRepository();
  await sessionRepo.create({
    id: bindingId,
    bindingId,
    channel: "feishu",
    workspaceId,
    continuityMode: "top_level_preferred",
    verboseLevel: "off",
    currentTaskId: taskId,
    currentLeaderSessionId: runId,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Verify NO live AbortController
  expect(getAbortController(taskId)).toBeUndefined();

  // This test will actually invoke the full leader loop (which will fail
  // due to missing config), but that failure proves it DID NOT route to
  // the mailbox — it attempted real execution. We catch the error and
  // verify that NO mailbox row was created.
  const mailbox = new TaskMailboxRepository();
  const mailboxBefore = await mailbox.listByTaskId(taskId);

  try {
    await processTaskIntent({
      prompt: "follow-up with no live run",
      source: "feishu",
      workspaceId,
      channelBindingId: bindingId,
      rootChannelBindingId: bindingId,
      createdBy: "u2",
    });
  } catch {
    // Expected — leader loop fails due to missing config
  }

  // Assert: NO mailbox row was created (it attempted execution, not mailbox route)
  const mailboxAfter = await mailbox.listByTaskId(taskId);
  expect(mailboxAfter.length).toBe(mailboxBefore.length);
});
