import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { NormalizedSlackInteraction } from "../../src/integrations/slack/slack-event-normalizer";
import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import {
  DIGEST_ACTION_DISMISSED_EVENT_TYPE,
  DIGEST_ACTION_TAKEN_EVENT_TYPE,
} from "../../src/services/digest-service";
import { handleDigestAction } from "../../src/services/slack/slack-router";

const tempRoot = join(process.cwd(), ".tmp-digest-action-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `digest-action-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  rmSync(tempRoot, { recursive: true, force: true });
});

function buildInteraction(actionId: string, value: string | undefined): NormalizedSlackInteraction {
  return {
    event: {
      channel: "slack",
      eventId: "trigger-1",
      eventType: "card_action",
      accountId: "T1",
      chatId: "C0DIGEST",
      platformMessageId: "1626000000.000100",
      sender: { platformUserId: "U1" },
      content: {
        actionId,
        payload: typeof value === "string" ? { envelope: value } : {},
      },
      occurredAt: new Date().toISOString(),
    },
    actions: [{ actionId, value }],
    messageTs: "1626000000.000100",
  };
}

function fakeSlackClient() {
  const posts: Array<{ channel: string; text: string; threadTs?: string | undefined }> = [];
  return {
    posts,
    client: {
      postMessage: async (input: { channel: string; text: string; threadTs?: string | undefined }) => {
        posts.push(input);
        return { channel: input.channel, ts: "1626000000.000200" };
      },
      updateMessage: async () => ({ channel: "C0DIGEST", ts: "1" }),
      authTest: async () => ({ botUserId: "B1", team: "T1" }),
    },
  };
}

async function listEvents(type: string) {
  const repo = new ExecutionEventRepository();
  return repo.listByType(type);
}

test("digest_act records action_taken event, creates a task, replies in thread", async () => {
  const intents: Array<{ prompt: string; createdBy: string }> = [];
  const { posts, client } = fakeSlackClient();

  await handleDigestAction(
    buildInteraction("digest_act", JSON.stringify({ actionText: "Nudge run-1" })),
    {
      slackClient: client,
      runIntent: async (input) => {
        intents.push({ prompt: input.prompt, createdBy: input.createdBy });
        return { taskId: "task_spawned_12345678" };
      },
    },
  );

  expect(intents).toEqual([{ prompt: "Nudge run-1", createdBy: "digest:slack:U1" }]);

  const events = await listEvents(DIGEST_ACTION_TAKEN_EVENT_TYPE);
  expect(events).toHaveLength(1);
  expect(events[0]!.taskId).toBe("task_spawned_12345678");
  const payload = JSON.parse(events[0]!.payloadJson!);
  expect(payload.actionText).toBe("Nudge run-1");
  expect(payload.actorId).toBe("U1");

  expect(posts).toHaveLength(1);
  expect(posts[0]!.threadTs).toBe("1626000000.000100");
  expect(posts[0]!.text).toContain("✅");
});

test("digest_dismiss records action_dismissed event without creating a task", async () => {
  let intentCalled = false;
  const { posts, client } = fakeSlackClient();

  await handleDigestAction(
    buildInteraction("digest_dismiss", JSON.stringify({ actionText: "Nudge run-1" })),
    {
      slackClient: client,
      runIntent: async () => {
        intentCalled = true;
        return { taskId: "never" };
      },
    },
  );

  expect(intentCalled).toBe(false);
  expect(await listEvents(DIGEST_ACTION_TAKEN_EVENT_TYPE)).toHaveLength(0);
  const events = await listEvents(DIGEST_ACTION_DISMISSED_EVENT_TYPE);
  expect(events).toHaveLength(1);
  expect(posts[0]!.text).toBe("Dismissed");
});

test("bad value JSON does not throw; event still records with empty actionText", async () => {
  let intentCalled = false;
  const { client } = fakeSlackClient();

  await handleDigestAction(buildInteraction("digest_act", "not-json{"), {
    slackClient: client,
    runIntent: async () => {
      intentCalled = true;
      return { taskId: "never" };
    },
  });

  expect(intentCalled).toBe(false); // no actionText → no task
  const events = await listEvents(DIGEST_ACTION_TAKEN_EVENT_TYPE);
  expect(events).toHaveLength(1);
  expect(JSON.parse(events[0]!.payloadJson!).actionText).toBe("");
});

test("intent failure is swallowed; event records without taskId and ack warns", async () => {
  const { posts, client } = fakeSlackClient();

  await handleDigestAction(
    buildInteraction("digest_act", JSON.stringify({ actionText: "Nudge run-1" })),
    {
      slackClient: client,
      runIntent: async () => {
        throw new Error("intake exploded");
      },
    },
  );

  const events = await listEvents(DIGEST_ACTION_TAKEN_EVENT_TYPE);
  expect(events).toHaveLength(1);
  expect(events[0]!.taskId).toBeNull();
  expect(posts[0]!.text).toContain("⚠️");
});
