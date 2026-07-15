import { ExecutionEventRepository } from "../repositories/execution-event-repository";
import { TaskRepository } from "../repositories/task-repository";
import { buildSlackClientIfConfigured, type SlackClient } from "../integrations/slack/slack-client";
import { parseSlackConfig } from "../integrations/slack/slack-config";
import {
  SENTINEL_SIGNAL_EVENT_TYPE,
  type SentinelSignalPayload,
} from "./sentinel-service";

/**
 * Daily progress digest — aggregates sentinel signals + terminal task
 * transitions since the last digest, asks the leader model to compose a
 * short team digest, and delivers it to Slack (Block Kit with act/dismiss
 * buttons) or Feishu (plain text). Records a `digest.sent` event either
 * way so the next tick's window starts where this one ended.
 *
 * Spec: docs/superpowers/specs/2026-07-14-trusted-progress-engine-design.md
 * Loop shape mirrors sentinel-service.ts. Off by default
 * (MAGISTER_DIGEST_ENABLED=true to enable).
 */

const DEFAULT_DIGEST_HOUR = 9;
const DIGEST_LOOP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const GENERATOR_TIMEOUT_MS = 60_000;
// Slack chat.postMessage caps text at 40k; button `value` at 2k.
const DIGEST_TEXT_CAP = 8000;
const BUTTON_VALUE_CAP = 1500;

export const DIGEST_SENT_EVENT_TYPE = "digest.sent";
export const DIGEST_ACTION_TAKEN_EVENT_TYPE = "digest.action_taken";
export const DIGEST_ACTION_DISMISSED_EVENT_TYPE = "digest.action_dismissed";

export type DigestItemKind = "progress" | "stuck" | "decision";

export interface DigestItem {
  kind: DigestItemKind;
  text: string;
  ref?: string;
  suggestedAction?: string;
}

export interface DigestMaterial {
  windowStart: Date;
  signals: SentinelSignalPayload[];
  /** Tasks that reached COMPLETED/BLOCKED inside the window. */
  terminalTasks: Array<{ id: string; title: string; state: string }>;
}

/** Returns the model's raw text; the service parses/falls back. */
export type DigestGenerator = (material: DigestMaterial) => Promise<string>;

export interface DigestTickDependencies {
  eventRepository?: ExecutionEventRepository;
  taskRepository?: TaskRepository;
  generator?: DigestGenerator;
  /** Injectable for tests; `null` forces the unconfigured path. */
  slackClient?: SlackClient | null;
  feishuSendText?: (chatId: string, text: string) => Promise<void>;
}

export interface DigestTickResult {
  status: "sent" | "skipped_already_sent" | "skipped_empty";
  channel: "slack" | "feishu" | "none";
  itemCount: number;
}

function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// ──────────────────────────────────────────────────────────────────────
// Generation
// ──────────────────────────────────────────────────────────────────────

const DIGEST_SYSTEM_PROMPT = [
  "You are writing a short daily digest for an engineering team lead.",
  "Input is JSON: sentinel signals (stalls, overdue approvals, risk events, external checks) and tasks that completed or got blocked.",
  "Group what matters into at most 8 items. Respond with ONLY this JSON, no prose, no code fences:",
  '{"items":[{"kind":"progress"|"stuck"|"decision","text":"one sentence","ref":"optional stable reference","suggestedAction":"optional imperative next step"}]}',
  "Use kind=progress for shipped work, kind=stuck for stalls/blockers, kind=decision for things needing a human call.",
  "Only include suggestedAction when a concrete, safe next step exists.",
].join("\n");

/** One-shot leader-model call (memory-extractor precedent). Returns "" on any failure. */
async function generateWithLeaderModel(material: DigestMaterial): Promise<string> {
  try {
    const { resolveAgentForRole } = await import("./agent-resolution-service");
    const { buildApiConfigFromAgent } = await import("./process-task-intent-service");
    const { callStreamingApi } = await import(
      "./manager-automation/autonomous-loop/streaming-api-caller"
    );

    const agent = await resolveAgentForRole("leader");
    if (!agent || !agent.provider) return "";

    const apiConfig = buildApiConfigFromAgent(agent);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GENERATOR_TIMEOUT_MS);
    let rawText = "";
    try {
      const stream = callStreamingApi(
        {
          messages: [
            {
              type: "user",
              content: JSON.stringify({
                signals: material.signals,
                terminalTasks: material.terminalTasks,
                windowStart: material.windowStart.toISOString(),
              }),
            },
          ],
          systemPrompt: DIGEST_SYSTEM_PROMPT,
          model: agent.modelName,
          signal: controller.signal,
        },
        {
          provider: apiConfig.provider,
          model: apiConfig.model,
          binding: apiConfig.binding,
        },
      );
      for await (const event of stream) {
        if (event.type === "text_delta") rawText += event.text;
      }
    } finally {
      clearTimeout(timer);
    }
    return rawText;
  } catch (err) {
    console.warn(`[digest] generator failed: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  }
}

const VALID_KINDS: readonly DigestItemKind[] = ["progress", "stuck", "decision"];

/** Parse the model's JSON; null means "fall back to plain text". */
export function parseDigestItems(rawText: string): DigestItem[] | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(stripped) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    const items = parsed.items.filter(
      (i): i is DigestItem =>
        typeof i === "object" && i !== null &&
        VALID_KINDS.includes((i as DigestItem).kind) &&
        typeof (i as DigestItem).text === "string",
    );
    return items.length > 0 ? items : null;
  } catch {
    return null;
  }
}

/** Deterministic digest when the model is unavailable or returned nothing. */
function buildPlainTextFromMaterial(material: DigestMaterial): string {
  const lines: string[] = [];
  for (const signal of material.signals) {
    lines.push(`• [${signal.signalType}] ${signal.summary}`);
  }
  for (const task of material.terminalTasks) {
    lines.push(`• [task ${task.state.toLowerCase()}] ${task.title} (${task.id})`);
  }
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────
// Delivery
// ──────────────────────────────────────────────────────────────────────

const KIND_TITLES: Record<DigestItemKind, string> = {
  progress: "✅ Progress",
  stuck: "🔴 Stuck",
  decision: "🟡 Needs a decision",
};

export function buildDigestBlocks(items: DigestItem[], now: Date): unknown[] {
  const blocks: unknown[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Team digest — ${now.toISOString().slice(0, 10)}` },
    },
  ];
  for (const kind of VALID_KINDS) {
    const group = items.filter((i) => i.kind === kind);
    if (group.length === 0) continue;
    const body = group
      .map((i) => `• ${i.text}${i.ref ? ` (${i.ref})` : ""}`)
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${KIND_TITLES[kind]}*\n${body}` },
    });
  }
  for (const item of items) {
    if (!item.suggestedAction) continue;
    const value = JSON.stringify({
      actionText: item.suggestedAction.slice(0, BUTTON_VALUE_CAP),
    });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `💡 ${item.suggestedAction}` },
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: "digest_act",
          style: "primary",
          text: { type: "plain_text", text: "Do it" },
          value,
        },
        {
          type: "button",
          action_id: "digest_dismiss",
          text: { type: "plain_text", text: "Dismiss" },
          value,
        },
      ],
    });
  }
  return blocks;
}

function buildFallbackText(items: DigestItem[]): string {
  return items
    .map((i) => `[${i.kind}] ${i.text}${i.ref ? ` (${i.ref})` : ""}`)
    .join("\n")
    .slice(0, DIGEST_TEXT_CAP);
}

// ──────────────────────────────────────────────────────────────────────
// Tick
// ──────────────────────────────────────────────────────────────────────

/**
 * One digest pass: window since last digest.sent (or 24h), aggregate,
 * generate, deliver, record. Idempotent per local day — a second call
 * after a successful send is a no-op.
 */
export async function runDigestTick(
  now: Date,
  dependencies: DigestTickDependencies = {},
): Promise<DigestTickResult> {
  const eventRepo = dependencies.eventRepository ?? new ExecutionEventRepository();
  const taskRepo = dependencies.taskRepository ?? new TaskRepository();

  const lastSent = await eventRepo.getLatestByType(DIGEST_SENT_EVENT_TYPE);
  if (lastSent && lastSent.occurredAt.getTime() >= startOfDay(now).getTime()) {
    return { status: "skipped_already_sent", channel: "none", itemCount: 0 };
  }

  const windowStart = lastSent
    ? lastSent.occurredAt
    : new Date(now.getTime() - DEFAULT_WINDOW_MS);

  // Aggregate.
  const signalEvents = await eventRepo.listByTypesSince([SENTINEL_SIGNAL_EVENT_TYPE], windowStart);
  const signals: SentinelSignalPayload[] = [];
  for (const event of signalEvents) {
    try {
      signals.push(JSON.parse(event.payloadJson ?? "{}") as SentinelSignalPayload);
    } catch {
      // skip unparseable historical payloads
    }
  }
  const terminalTasks = (await taskRepo.listTerminalUpdatedSince(windowStart)).map((t) => ({
    id: t.id,
    title: t.title,
    state: t.state,
  }));

  const recordSent = async (payload: Record<string, unknown>) => {
    await eventRepo.create({
      id: `event_digest_${crypto.randomUUID()}`,
      type: DIGEST_SENT_EVENT_TYPE,
      severity: "info",
      occurredAt: now,
      payloadJson: JSON.stringify({ windowStart: windowStart.toISOString(), ...payload }),
    });
  };

  // Zero material → no delivery, but still advance the window marker.
  if (signals.length === 0 && terminalTasks.length === 0) {
    await recordSent({ channel: "none", itemCount: 0, skipped: "empty" });
    return { status: "skipped_empty", channel: "none", itemCount: 0 };
  }

  const material: DigestMaterial = { windowStart, signals, terminalTasks };

  // Generate.
  const generator = dependencies.generator ?? generateWithLeaderModel;
  const rawText = await generator(material);
  const items = parseDigestItems(rawText);
  const plainText =
    items === null
      ? (rawText.trim() || buildPlainTextFromMaterial(material)).slice(0, DIGEST_TEXT_CAP)
      : null;
  const itemCount = items?.length ?? signals.length + terminalTasks.length;

  // Deliver.
  const slackChannel = process.env.MAGISTER_DIGEST_SLACK_CHANNEL?.trim();
  const feishuChatId = process.env.MAGISTER_DIGEST_FEISHU_CHAT_ID?.trim();
  const slackClient =
    dependencies.slackClient !== undefined
      ? dependencies.slackClient
      : buildSlackClientIfConfigured(parseSlackConfig().botToken);

  let channel: DigestTickResult["channel"] = "none";
  let messageTs: string | undefined;

  if (slackClient && slackChannel) {
    try {
      const result = await slackClient.postMessage({
        channel: slackChannel,
        text: items ? buildFallbackText(items) : plainText!,
        ...(items ? { blocks: buildDigestBlocks(items, now) } : {}),
      });
      channel = "slack";
      messageTs = result.ts;
    } catch (err) {
      console.warn(`[digest] Slack delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (feishuChatId) {
    try {
      const sendText =
        dependencies.feishuSendText ??
        (async (chatId: string, text: string) => {
          const { parseFeishuConfigFromEnv } = await import("../integrations/feishu/feishu-config");
          const { createFeishuClient } = await import("../integrations/feishu/feishu-client");
          const config = parseFeishuConfigFromEnv();
          if (!config.appId || !config.appSecret) throw new Error("Feishu app credentials not configured");
          const client = createFeishuClient({ appId: config.appId, appSecret: config.appSecret });
          await client.sendTextMessage({ chatId, text });
        });
      await sendText(feishuChatId, items ? buildFallbackText(items) : plainText!);
      channel = "feishu";
    } catch (err) {
      console.warn(`[digest] Feishu delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await recordSent({ channel, itemCount, ...(messageTs ? { messageTs } : {}) });
  return { status: "sent", channel, itemCount };
}

// ──────────────────────────────────────────────────────────────────────
// Periodic loop (same shape as startSentinelLoop)
// ──────────────────────────────────────────────────────────────────────

let digestLoopTimer: ReturnType<typeof setInterval> | null = null;
let digestLoopInFlight = false;

/** Off by default; enable with MAGISTER_DIGEST_ENABLED=true. */
export async function startDigestLoop() {
  const enabled = (process.env.MAGISTER_DIGEST_ENABLED ?? "false").toLowerCase() === "true";
  if (!enabled || digestLoopTimer) return;

  const digestHour = parsePositiveInt(process.env.MAGISTER_DIGEST_HOUR, DEFAULT_DIGEST_HOUR);

  const tick = async () => {
    if (digestLoopInFlight) return;
    digestLoopInFlight = true;
    try {
      const now = new Date();
      if (now.getHours() < digestHour) return;
      await runDigestTick(now);
    } catch (err) {
      console.warn(`[digest] tick failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      digestLoopInFlight = false;
    }
  };

  await tick();
  digestLoopTimer = setInterval(() => { void tick(); }, DIGEST_LOOP_INTERVAL_MS);
}

export async function stopDigestLoop() {
  if (!digestLoopTimer) return;
  clearInterval(digestLoopTimer);
  digestLoopTimer = null;
}
