import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-intent-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `intent-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: tempRoot,
  });
  const configPath = join(tempRoot, "executors.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: { manager: { adapterId: "model", strategy: "model_only" } },
      providers: {},
      models: {},
      bindings: {},
    }),
  );
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_LEADER_SESSION_TTL_MS;
  delete process.env.MAGISTER_FEISHU_APP_ID;
  delete process.env.MAGISTER_FEISHU_APP_SECRET;
  rmSync(tempRoot, { recursive: true, force: true });
});

test("processTaskIntent creates task and runtime records", async () => {
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");

  // Import and test - the function should at minimum create DB records
  // even if the leader loop fails due to no real API config
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");

  const result = await processTaskIntent({
    prompt: "Hello world",
    source: "web",
    workspaceId: "workspace_main",
  });

  expect(result.taskId).toBeTruthy();
  expect(result.runId).toBeTruthy();
  expect(result.action).toBe("new_session");

  const taskRepo = new TaskRepository();
  const task = await taskRepo.getById(result.taskId);
  expect(task).not.toBeNull();

  const runtimeRepo = new RoleRuntimeRepository();
  const runtime = await runtimeRepo.getById(result.runId);
  expect(runtime).not.toBeNull();
  expect(runtime!.roleId).toBe("leader");
});

test("resolveApiConfigFromRoleRouting prefers canonical leader over legacy manager", async () => {
  const { resolveApiConfigFromRoleRouting } = await import("../../src/services/process-task-intent-service");

  const config = {
    executors: {},
    roleRouting: {
      manager: { adapterId: "legacy-manager-binding", strategy: "model_only" },
      leader: { adapterId: "canonical-leader-binding", strategy: "model_only" },
    },
    providers: {
      provider_api: {
        label: "Provider API",
        vendor: "test",
        transport: "api",
        apiDialect: "openai_chat_completions",
        auth: { kind: "none" },
      },
    },
    models: {
      legacy_model: {
        label: "Legacy model",
        vendor: "test",
        modelName: "legacy-model",
        providerRefs: { api: "provider_api" },
      },
      leader_model: {
        label: "Leader model",
        vendor: "test",
        modelName: "leader-model",
        providerRefs: { api: "provider_api" },
      },
    },
    bindings: {
      "legacy-manager-binding": {
        executionMode: "api",
        modelRef: "legacy_model",
        providerRef: "provider_api",
      },
      "canonical-leader-binding": {
        executionMode: "api",
        modelRef: "leader_model",
        providerRef: "provider_api",
      },
    },
  } as const;

  const resolved = resolveApiConfigFromRoleRouting(config);

  expect(resolved?.binding.adapterId).toBe("canonical-leader-binding");
  expect(resolved?.model.modelName).toBe("leader-model");
});

test("processTaskIntent resumes an existing conversation when a follow-up arrives on the same binding", async () => {
  process.env.MAGISTER_LEADER_SESSION_TTL_MS = "25";

  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ChannelSessionService } = await import("../../src/services/channel-session-service");
  const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");

  const bindingId = "web:chat:test_binding";
  const runId = "rt_leader_existing";
  const taskId = "task_existing";

  const channelSessionService = new ChannelSessionService();
  const sessionStore = new LeaderSessionStore();
  const taskRepo = new TaskRepository();
  const runtimeRepo = new RoleRuntimeRepository();
  const now = new Date();

  await taskRepo.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "Existing resumed task",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });
  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  await channelSessionService.ensureForBinding({
    bindingId,
    channel: "feishu",
    workspaceId: "workspace_main",
  });
  await channelSessionService.recordLeaderSession({
    bindingId,
    currentLeaderSessionId: runId,
    currentTaskId: taskId,
  });
  await sessionStore.writeCheckpoint({
    sessionId: runId,
    taskId,
    runId,
    requestId: "req-fixture",
    turnCount: 1,
    messages: [
      { type: "user" as const, content: "Initial prompt" },
      {
        type: "assistant" as const,
        content: [{ type: "text" as const, text: "Initial reply" }],
      },
    ],
  });

  await new Promise((resolve) => setTimeout(resolve, 40));

  const result = await processTaskIntent({
    prompt: "Follow-up prompt",
    source: "web",
    workspaceId: "workspace_main",
    channelBindingId: bindingId,
  });

  expect(result.action).toBe("resumed_session");
  expect(result.taskId).toBe(taskId);
  expect(result.runId).toBe(runId);
});

test("processTaskIntent generates distinct requestIds for consecutive follow-ups on the same task", async () => {
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ChannelSessionService } = await import("../../src/services/channel-session-service");
  const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");

  const bindingId = "web:chat:request_id_binding";
  const runId = "rt_leader_request_id";
  const taskId = "task_request_id";
  const now = new Date();

  const taskRepo = new TaskRepository();
  await taskRepo.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "Request id follow-ups",
    state: "EXECUTING",
    createdAt: now,
    updatedAt: now,
  });

  const runtimeRepo = new RoleRuntimeRepository();
  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "RUNNING",
    attemptCount: 0,
    startedAt: now,
    updatedAt: now,
  });

  const channelSessionService = new ChannelSessionService();
  await channelSessionService.ensureForBinding({
    bindingId,
    channel: "feishu",
    workspaceId: "workspace_main",
  });
  await channelSessionService.recordLeaderSession({
    bindingId,
    currentLeaderSessionId: runId,
    currentTaskId: taskId,
  });

  const sessionStore = new LeaderSessionStore();
  await sessionStore.writeCheckpoint({
    sessionId: runId,
    taskId,
    runId,
    requestId: "req-fixture",
    turnCount: 1,
    messages: [
      { type: "user" as const, content: "Initial prompt" },
      {
        type: "assistant" as const,
        content: [{ type: "text" as const, text: "Initial reply" }],
      },
    ],
  });

  const first = await processTaskIntent({
    prompt: "First follow-up",
    source: "web",
    workspaceId: "workspace_main",
    channelBindingId: bindingId,
  });
  const second = await processTaskIntent({
    prompt: "Second follow-up",
    source: "web",
    workspaceId: "workspace_main",
    channelBindingId: bindingId,
  });

  expect(first.taskId).toBe(taskId);
  expect(second.taskId).toBe(taskId);
  expect(first.runId).toBe(runId);
  expect(second.runId).toBe(runId);
  expect(first.requestId).toBeTruthy();
  expect(second.requestId).toBeTruthy();
  expect(first.requestId).not.toBe(second.requestId);
});

test("processTaskIntent clears stale completion timestamps when resuming a terminal task", async () => {
  const { TaskRepository } = await import("../../src/repositories/task-repository");
  const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
  const { ChannelSessionService } = await import("../../src/services/channel-session-service");
  const { LeaderSessionStore } = await import("../../src/services/leader-session-store");
  const { taskWorker } = await import("../../src/services/task-worker");
  const { processTaskIntent } = await import("../../src/services/process-task-intent-service");

  const bindingId = "web:chat:terminal_resume_binding";
  const runId = "rt_leader_terminal_resume";
  const taskId = "task_terminal_resume";
  const now = new Date();
  const completedAt = new Date(now.getTime() - 5_000);

  const taskRepo = new TaskRepository();
  await taskRepo.create({
    id: taskId,
    workspaceId: "workspace_main",
    source: "web",
    title: "Terminal task",
    state: "DONE",
    createdAt: now,
    updatedAt: completedAt,
    completedAt,
  });

  const runtimeRepo = new RoleRuntimeRepository();
  await runtimeRepo.create({
    id: runId,
    taskId,
    roleId: "leader",
    state: "COMPLETED",
    attemptCount: 0,
    startedAt: now,
    updatedAt: completedAt,
    completedAt,
  });

  const channelSessionService = new ChannelSessionService();
  await channelSessionService.ensureForBinding({
    bindingId,
    channel: "feishu",
    workspaceId: "workspace_main",
  });
  await channelSessionService.recordLeaderSession({
    bindingId,
    currentLeaderSessionId: runId,
    currentTaskId: taskId,
  });

  const sessionStore = new LeaderSessionStore();
  await sessionStore.writeCheckpoint({
    sessionId: runId,
    taskId,
    runId,
    requestId: "req-terminal-fixture",
    turnCount: 1,
    messages: [
      { type: "user" as const, content: "Initial prompt" },
      {
        type: "assistant" as const,
        content: [{ type: "text" as const, text: "Initial reply" }],
      },
    ],
  });

  const originalEnqueue = taskWorker.enqueue.bind(taskWorker);
  const enqueuedJobs: unknown[] = [];
  (taskWorker as unknown as { enqueue: (job: unknown) => void }).enqueue = (job) => {
    enqueuedJobs.push(job);
  };

  try {
    const result = await processTaskIntent({
      prompt: "Follow-up after terminal state",
      source: "web",
      workspaceId: "workspace_main",
      channelBindingId: bindingId,
    });

    expect(result.action).toBe("resumed_session");
    expect(result.taskId).toBe(taskId);
    expect(result.runId).toBe(runId);
    expect(enqueuedJobs).toHaveLength(1);

    const task = await taskRepo.getById(taskId);
    expect(task?.state).toBe("EXECUTING");
    expect(task?.completedAt).toBeNull();

    const runtime = await runtimeRepo.getById(runId);
    expect(runtime?.state).toBe("RUNNING");
    expect(runtime?.completedAt).toBeNull();
  } finally {
    (taskWorker as unknown as { enqueue: typeof originalEnqueue }).enqueue = originalEnqueue;
  }
});

test("processTaskExecution delivers async finalAnswer back to Feishu when channel binding is present", async () => {
  const originalFetch = globalThis.fetch;
  const { resetFeishuTokenCache } = await import("../../src/integrations/feishu/feishu-client");
  const { createFeishuFetchMock } = await import("../utils/feishu-test-harness");
  const fetchMock = createFeishuFetchMock({
    replyMessageId: "om_reply_async_final_1",
  });

  process.env.MAGISTER_FEISHU_APP_ID = "test-feishu-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "test-feishu-app-secret";
  globalThis.fetch = fetchMock.fetch as typeof fetch;

  try {
    const { TaskRepository } = await import("../../src/repositories/task-repository");
    const { RoleRuntimeRepository } = await import("../../src/repositories/role-runtime-repository");
    const { ConversationBindingRepository } = await import(
      "../../src/repositories/conversation-binding-repository"
    );
    const { ChannelSessionService } = await import("../../src/services/channel-session-service");
    const { ExecutionEventRepository } = await import("../../src/repositories/execution-event-repository");
    const { processTaskExecution } = await import("../../src/services/process-task-intent-service");

    const now = new Date();
    const taskId = "task_async_feishu_delivery";
    const runId = "rt_leader_async_feishu_delivery";
    const bindingId = "feishu:tenant_async:oc_chat_async";
    const inboundMessageId = "om_inbound_async_1";

    const taskRepo = new TaskRepository();
    await taskRepo.create({
      id: taskId,
      workspaceId: "workspace_main",
      source: "web",
      title: "Queued async task",
      state: "EXECUTING",
      createdAt: now,
      updatedAt: now,
      rootChannelBindingId: bindingId,
    });

    const runtimeRepo = new RoleRuntimeRepository();
    await runtimeRepo.create({
      id: runId,
      taskId,
      roleId: "leader",
      state: "RUNNING",
      attemptCount: 0,
      startedAt: now,
      updatedAt: now,
    });

    const bindingRepo = new ConversationBindingRepository();
    await bindingRepo.create({
      id: bindingId,
      channel: "feishu",
      accountId: "tenant_async",
      chatId: "oc_chat_async",
      workspaceId: "workspace_main",
      createdAt: now,
      updatedAt: now,
      lastInboundAt: now,
      lastEventId: "evt_async_1",
      lastPlatformMessageId: inboundMessageId,
      lastSenderUserId: "ou_async_sender",
      lastSenderDisplayName: "Async Sender",
    });

    const sessionService = new ChannelSessionService();
    await sessionService.ensureForBinding({
      bindingId,
      channel: "feishu",
      workspaceId: "workspace_main",
      latestInboundMessageId: inboundMessageId,
    });

    await processTaskExecution({
      taskId,
      runId,
      requestId: "req_async_feishu_delivery",
      workspaceId: "workspace_main",
      prompt: "Please finish this queued task",
      channelBindingId: bindingId,
    });

    const replyRequest = fetchMock.requests.find((request) =>
      request.url.includes(`/open-apis/im/v1/messages/${inboundMessageId}/reply`),
    );
    expect(replyRequest).toBeDefined();

    const eventRepository = new ExecutionEventRepository();
    const events = await eventRepository.listAll();
    const deliveryEvent = events.find((event) => {
      if (event.type !== "channel.outbound.delivered") {
        return false;
      }
      const payload = JSON.parse(String(event.payloadJson)) as { kind?: string };
      // Task 9: the async final-answer fallback now delivers ONE plain-text
      // message (no streaming card was created in this direct-execution
      // path), tagged leader_answer_text_fallback.
      return payload.kind === "leader_answer_text_fallback";
    });
    expect(deliveryEvent).toBeDefined();
    expect(JSON.parse(String(deliveryEvent?.payloadJson))).toMatchObject({
      channel: "feishu",
      kind: "leader_answer_text_fallback",
      bindingId,
      deliveredCount: 1,
      chunks: 1,
    });
  } finally {
    globalThis.fetch = originalFetch;
    resetFeishuTokenCache();
  }
});
