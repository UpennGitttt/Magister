import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { ExecutionEventRepository } from "../../src/repositories/execution-event-repository";
import { TaskRepository } from "../../src/repositories/task-repository";
import {
  DIGEST_SENT_EVENT_TYPE,
  runDigestTick,
  type DigestMaterial,
} from "../../src/services/digest-service";
import { SENTINEL_SIGNAL_EVENT_TYPE } from "../../src/services/sentinel-service";

const tempRoot = join(process.cwd(), ".tmp-digest-test");

const NOW = new Date("2026-07-14T12:00:00Z");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
  process.env.MAGISTER_DB_PATH = join(
    tempRoot,
    `digest-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.MAGISTER_DIGEST_SLACK_CHANNEL = "C0DIGEST";
  delete process.env.MAGISTER_DIGEST_FEISHU_CHAT_ID;
});

afterEach(() => {
  delete process.env.MAGISTER_DB_PATH;
  delete process.env.MAGISTER_DIGEST_SLACK_CHANNEL;
  delete process.env.MAGISTER_DIGEST_FEISHU_CHAT_ID;
  rmSync(tempRoot, { recursive: true, force: true });
});

async function seedSignal(id: string, summary: string) {
  await new ExecutionEventRepository().create({
    id,
    type: SENTINEL_SIGNAL_EVENT_TYPE,
    occurredAt: new Date("2026-07-14T09:00:00Z"),
    payloadJson: JSON.stringify({
      signalType: "stalled_runtime",
      ref: id,
      summary,
      fingerprint: `stalled_runtime:${id}`,
    }),
  });
}

async function seedCompletedTask(id: string, title: string) {
  await new TaskRepository().create({
    id,
    workspaceId: "ws-1",
    source: "web",
    title,
    state: "COMPLETED",
    createdAt: new Date("2026-07-14T08:00:00Z"),
    updatedAt: new Date("2026-07-14T10:00:00Z"),
  });
}

function fakeSlackClient() {
  const posts: Array<{ channel: string; text: string; blocks?: unknown[] }> = [];
  return {
    posts,
    client: {
      postMessage: async (input: { channel: string; text: string; blocks?: unknown[] | undefined }) => {
        posts.push({ channel: input.channel, text: input.text, ...(input.blocks ? { blocks: input.blocks } : {}) });
        return { channel: input.channel, ts: "1626000000.000100" };
      },
      updateMessage: async () => ({ channel: "C0DIGEST", ts: "1" }),
      authTest: async () => ({ botUserId: "B1", team: "T1" }),
    },
  };
}

async function listDigestSentEvents() {
  const repo = new ExecutionEventRepository();
  return repo.listByTypesSince([DIGEST_SENT_EVENT_TYPE], new Date("2026-07-14T00:00:00Z"));
}

test("tick aggregates, generates, delivers Slack blocks with action buttons, records digest.sent", async () => {
  await seedSignal("evt-sig-1", "Runtime run-1 stalled 45 min");
  await seedCompletedTask("t-done", "Ship the login fix");

  const materials: DigestMaterial[] = [];
  const { posts, client } = fakeSlackClient();
  const result = await runDigestTick(NOW, {
    slackClient: client,
    generator: async (material) => {
      materials.push(material);
      return JSON.stringify({
        items: [
          { kind: "progress", text: "Login fix shipped", ref: "t-done" },
          {
            kind: "stuck",
            text: "run-1 stalled for 45 min",
            ref: "run-1",
            suggestedAction: "Nudge the coder runtime on run-1",
          },
        ],
      });
    },
  });

  expect(result).toEqual({ status: "sent", channel: "slack", itemCount: 2 });
  // Generator saw both aggregation sources.
  expect(materials[0]!.signals).toHaveLength(1);
  expect(materials[0]!.terminalTasks).toEqual([
    { id: "t-done", title: "Ship the login fix", state: "COMPLETED" },
  ]);

  expect(posts).toHaveLength(1);
  const blocks = posts[0]!.blocks as Array<Record<string, unknown>>;
  expect(blocks[0]!.type).toBe("header");
  const actions = blocks.find((b) => b.type === "actions") as {
    elements: Array<{ action_id: string; value: string }>;
  };
  expect(actions.elements.map((e) => e.action_id)).toEqual(["digest_act", "digest_dismiss"]);
  expect(JSON.parse(actions.elements[0]!.value)).toEqual({
    actionText: "Nudge the coder runtime on run-1",
  });

  const sent = await listDigestSentEvents();
  expect(sent).toHaveLength(1);
  const payload = JSON.parse(sent[0]!.payloadJson!);
  expect(payload.channel).toBe("slack");
  expect(payload.itemCount).toBe(2);
  expect(payload.messageTs).toBe("1626000000.000100");
});

test("generator returning bad JSON degrades to plain text delivery, does not throw", async () => {
  await seedSignal("evt-sig-2", "Approval appr-1 overdue");

  const { posts, client } = fakeSlackClient();
  const result = await runDigestTick(NOW, {
    slackClient: client,
    generator: async () => "Sorry, here is your digest: everything is stuck.",
  });

  expect(result.status).toBe("sent");
  expect(result.channel).toBe("slack");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.text).toBe("Sorry, here is your digest: everything is stuck.");
  expect(posts[0]!.blocks).toBeUndefined();
});

test("second tick the same day is a no-op", async () => {
  await seedSignal("evt-sig-3", "Runtime stalled");
  const { posts, client } = fakeSlackClient();
  const deps = {
    slackClient: client,
    generator: async () => JSON.stringify({ items: [{ kind: "stuck", text: "stalled" }] }),
  };

  const first = await runDigestTick(NOW, deps);
  expect(first.status).toBe("sent");

  const second = await runDigestTick(new Date(NOW.getTime() + 60 * 60 * 1000), deps);
  expect(second.status).toBe("skipped_already_sent");
  expect(posts).toHaveLength(1);
  expect(await listDigestSentEvents()).toHaveLength(1);
});

test("zero material skips delivery but records digest.sent with channel none", async () => {
  const { posts, client } = fakeSlackClient();
  let generatorCalled = false;
  const result = await runDigestTick(NOW, {
    slackClient: client,
    generator: async () => {
      generatorCalled = true;
      return "";
    },
  });

  expect(result).toEqual({ status: "skipped_empty", channel: "none", itemCount: 0 });
  expect(generatorCalled).toBe(false);
  expect(posts).toHaveLength(0);
  const sent = await listDigestSentEvents();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payloadJson!).channel).toBe("none");
});

test("no Slack and no Feishu configured: records digest.sent with channel none, no crash", async () => {
  delete process.env.MAGISTER_DIGEST_SLACK_CHANNEL;
  await seedSignal("evt-sig-4", "Runtime stalled");

  const result = await runDigestTick(NOW, {
    slackClient: null,
    generator: async () => JSON.stringify({ items: [{ kind: "stuck", text: "stalled" }] }),
  });

  expect(result).toEqual({ status: "sent", channel: "none", itemCount: 1 });
  const sent = await listDigestSentEvents();
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!.payloadJson!).channel).toBe("none");
});

test("Feishu fallback delivers plain text when Slack is not configured", async () => {
  delete process.env.MAGISTER_DIGEST_SLACK_CHANNEL;
  process.env.MAGISTER_DIGEST_FEISHU_CHAT_ID = "oc_digest";
  await seedSignal("evt-sig-5", "Runtime stalled");

  const sends: Array<{ chatId: string; text: string }> = [];
  const result = await runDigestTick(NOW, {
    slackClient: null,
    feishuSendText: async (chatId, text) => {
      sends.push({ chatId, text });
    },
    generator: async () =>
      JSON.stringify({ items: [{ kind: "stuck", text: "run-1 stalled", ref: "run-1" }] }),
  });

  expect(result).toEqual({ status: "sent", channel: "feishu", itemCount: 1 });
  expect(sends).toEqual([{ chatId: "oc_digest", text: "[stuck] run-1 stalled (run-1)" }]);
});
