import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { LeaderMessage } from "../../src/services/manager-automation/autonomous-loop/autonomous-types";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const tempRoot = join(process.cwd(), ".tmp-feishu-follow-up-routing-test");

function writeExecutorConfig(configPath: string) {
  writeFileSync(
    configPath,
    JSON.stringify({
      executors: {},
      roleRouting: {
        manager: {
          adapterId: "leader_api",
          strategy: "model_only",
        },
      },
      providers: {
        provider_openai: {
          transport: "api",
          apiDialect: "openai_chat_completions",
          vendor: "openai",
          baseUrl: "https://api.openai.com/v1",
          auth: { kind: "none" },
        },
      },
      models: {
        model_main: {
          modelName: "gpt-4o-mini",
          providerRefs: {
            api: "provider_openai",
          },
        },
      },
      bindings: {
        leader_api: {
          executionMode: "api",
          modelRef: "model_main",
          providerRef: "provider_openai",
        },
      },
    }),
  );
}

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });

  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `feishu-follow-up-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_WORKSPACE_PATH_MAP = JSON.stringify({
    workspace_main: tempRoot,
  });

  const configPath = join(tempRoot, "executors.json");
  writeExecutorConfig(configPath);
  process.env.MAGISTER_EXECUTOR_CONFIG_PATH = configPath;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_WORKSPACE_PATH_MAP;
  delete process.env.MAGISTER_EXECUTOR_CONFIG_PATH;
  delete process.env.MAGISTER_LEADER_SESSION_TTL_MS;
  mock.restore();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Feishu follow-up routing", () => {
  test("reuses task and restores checkpoint messages for same binding follow-up", async () => {
    const runtimeCalls: Array<{
      initialPrompt: string;
      channelBindingId?: string;
      restoredMessages?: LeaderMessage[];
    }> = [];

    mock.module(
      "../../src/services/manager-automation/autonomous-loop/manager-autonomous-runtime",
      () => ({
        buildLeaderRuntimeModelConfig: (apiConfig: any) => ({
          modelName: apiConfig.model.modelName,
        }),
        resolveLeaderRuntimeTools: async () => ({ tools: [], maxTurns: 60 }),
        runLeaderRuntime: async (config: {
          initialPrompt: string;
          channelBindingId?: string;
          restoredMessages?: LeaderMessage[];
        }) => {
          runtimeCalls.push({
            initialPrompt: config.initialPrompt,
            ...(config.channelBindingId
              ? { channelBindingId: config.channelBindingId }
              : {}),
            ...(config.restoredMessages
              ? { restoredMessages: config.restoredMessages }
              : {}),
          });

          return {
            reason: "completed",
            turnCount: 1,
            messages: [
              {
                type: "assistant" as const,
                content: [
                  {
                    type: "text" as const,
                    text: `answer: ${config.initialPrompt}`,
                  },
                ],
              },
            ],
          };
        },
      }),
    );

    const { processTaskIntent } = await import("../../src/services/process-task-intent-service");
    const { LeaderSessionStore } = await import("../../src/services/leader-session-store");

    const channelBindingId = "feishu:tenant_alpha:oc_chat_follow_up";

    const first = await processTaskIntent({
      prompt: "First question",
      source: "feishu",
      workspaceId: "workspace_main",
      channelBindingId,
    });

    expect(first.action).toBe("new_session");
    expect(first.status).toBe("completed");

    const restoredMessages: LeaderMessage[] = [
      { type: "user", content: "First question" },
      {
        type: "assistant",
        content: [
          {
            type: "text",
            text: "First answer",
          },
        ],
      },
    ];

    const sessionStore = new LeaderSessionStore();
    await sessionStore.writeCheckpoint({
      sessionId: first.runId,
      taskId: first.taskId,
      runId: first.runId,
    requestId: "req-fixture",
    turnCount: 1,
      messages: restoredMessages,
    });

    const followUp = await processTaskIntent({
      prompt: "Second question",
      source: "feishu",
      workspaceId: "workspace_main",
      channelBindingId,
    });

    expect(followUp.action).toBe("resumed_session");
    expect(followUp.taskId).toBe(first.taskId);
    expect(followUp.runId).toBe(first.runId);

    expect(runtimeCalls.length).toBe(2);
    expect(runtimeCalls[1]).toEqual({
      initialPrompt: "Second question",
      channelBindingId,
      restoredMessages,
    });
  });
});
