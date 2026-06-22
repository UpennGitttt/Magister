import { ChannelSessionRepository } from "../repositories/channel-session-repository";
import { ConversationBindingRepository } from "../repositories/conversation-binding-repository";
import { WorkspaceRepository } from "../repositories/workspace-repository";
import { createFeishuClient } from "../integrations/feishu/feishu-client";
import { parseFeishuConfigFromEnv } from "../integrations/feishu/feishu-config";
import { enqueue, feishuChatKey } from "../integrations/feishu/sequential-queue";

/**
 * In-channel slash-command service.
 *
 * Intercepts messages that start with a registered command (`/ws`,
 * `/verbose`, `/help`) and returns a handled response instead of
 * routing the text into the task-creation flow.
 *
 * Commands:
 *
 *   /ws                — show current workspace binding for this chat
 *   /ws <workspace_id> — switch the binding to the given workspace
 *   /ws clear          — revert binding to the default workspace
 *
 *   /verbose           — show current verboseLevel
 *   /verbose off|low|high — set verboseLevel
 *
 *   /help              — list commands + current state
 *
 * Each handler sends a confirmation card back to the chat via the
 * existing feishu client. Returns true if handled (caller should
 * NOT proceed to processTaskIntent).
 */

const VERBOSE_VALUES = new Set(["off", "low", "high"]);

export type SlashCommandResult =
  | { handled: false }
  | { handled: true; replyChatId: string };

function isSlashCommand(text: string): boolean {
  return text.trimStart().startsWith("/");
}

async function sendTextReply(chatId: string, text: string, bindingId: string): Promise<void> {
  const config = parseFeishuConfigFromEnv();
  if (!config.appId || !config.appSecret) return;
  const client = createFeishuClient({ appId: config.appId, appSecret: config.appSecret });
  try {
    await enqueue(feishuChatKey(bindingId, "control"), () =>
      client.sendTextMessage({ chatId, text }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[feishu-channel-command] reply failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function handleWsCommand(input: {
  binding: { id: string; workspaceId: string; chatId: string };
  args: string[];
}): Promise<SlashCommandResult> {
  const { binding, args } = input;
  const sessionRepo = new ChannelSessionRepository();
  const bindingRepo = new ConversationBindingRepository();
  const workspaceRepo = new WorkspaceRepository();

  if (args.length === 0) {
    // No-args = list all available workspaces + show current binding.
    // Users can't be expected to memorize workspace IDs, so this is
    // the discovery surface — same role as `git branch` with no args.
    const all = await workspaceRepo.listAll();
    const lines: string[] = [];
    lines.push(`Current: ${binding.workspaceId}`);
    lines.push("");
    lines.push("Available workspaces:");
    if (all.length === 0) {
      lines.push("  (none)");
    } else {
      for (const w of all) {
        const marker = w.id === binding.workspaceId ? "● " : "  ";
        const label = w.label ? ` — ${w.label}` : "";
        lines.push(`${marker}${w.id}${label}`);
      }
    }
    lines.push("");
    lines.push("Switch with: /ws <workspace_id>");
    await sendTextReply(binding.chatId, lines.join("\n"), binding.id);
    return { handled: true, replyChatId: binding.chatId };
  }

  const target = args[0] ?? "";

  if (target === "clear") {
    const fallback = (process.env.MAGISTER_DEFAULT_WORKSPACE_ID ?? "workspace_main").trim();
    const now = new Date();
    await bindingRepo.setWorkspace(binding.id, fallback, now);
    const session = await sessionRepo.getByBindingId(binding.id);
    if (session) {
      await sessionRepo.setWorkspace(session.id, fallback, now);
    }
    await sendTextReply(
      binding.chatId,
      `Workspace reset to default: ${fallback}`,
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  const workspace = await workspaceRepo.getById(target);
  if (!workspace) {
    await sendTextReply(
      binding.chatId,
      `Unknown workspace: "${target}". Send /ws to see current binding.`,
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  const switchAt = new Date();
  await bindingRepo.setWorkspace(binding.id, target, switchAt);
  const session = await sessionRepo.getByBindingId(binding.id);
  if (session) {
    await sessionRepo.setWorkspace(session.id, target, switchAt);
  }
  await sendTextReply(
    binding.chatId,
    `Workspace switched to ${target} (${workspace.label ?? "unnamed"})`,
    binding.id,
  );
  return { handled: true, replyChatId: binding.chatId };
}

async function handleVerboseCommand(input: {
  binding: { id: string; workspaceId: string; chatId: string };
  args: string[];
}): Promise<SlashCommandResult> {
  const { binding, args } = input;
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.getByBindingId(binding.id);

  if (args.length === 0) {
    const current = session?.verboseLevel ?? "off";
    await sendTextReply(
      binding.chatId,
      `Current verbose level: ${current}\nValid: off / low / high`,
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  const level = (args[0] ?? "").toLowerCase().trim();
  if (!VERBOSE_VALUES.has(level)) {
    await sendTextReply(
      binding.chatId,
      `Unknown verbose level: "${args[0]}". Valid: off / low / high`,
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  if (!session) {
    await sendTextReply(
      binding.chatId,
      `No channel session exists for this chat yet. Send a regular message first to initialize, then run /verbose ${level}.`,
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  await sessionRepo.update(session.id, {
    verboseLevel: level,
    updatedAt: new Date(),
  });

  await sendTextReply(
    binding.chatId,
    `Verbose level set to ${level}.`,
    binding.id,
  );
  return { handled: true, replyChatId: binding.chatId };
}

async function handleStopCommand(input: {
  binding: { id: string; workspaceId: string; chatId: string };
}): Promise<SlashCommandResult> {
  const { binding } = input;
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.getByBindingId(binding.id);

  const currentTaskId = session?.currentTaskId;
  if (!currentTaskId) {
    await sendTextReply(
      binding.chatId,
      "Nothing to stop — no active task in this chat.",
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  // Call the same in-process cancel path the web UI uses. This aborts
  // the leader loop via AbortController and flips task state to
  // CANCELLED. We don't go through HTTP — direct call is simpler and
  // avoids a round-trip + auth dance.
  try {
    const { getAbortController, taskWorker } = await import("./task-worker");
    const { TaskRepository } = await import("../repositories/task-repository");
    const taskRepo = new TaskRepository();
    const task = await taskRepo.getById(currentTaskId);
    if (!task) {
      await sendTextReply(
        binding.chatId,
        `Task ${currentTaskId.slice(-8)} not found.`,
        binding.id,
      );
      return { handled: true, replyChatId: binding.chatId };
    }
    const cancelAt = new Date();
    await taskRepo.update(currentTaskId, {
      state: "CANCELLED",
      updatedAt: cancelAt,
      ...(task.goalObjective && task.goalStatus !== "complete"
        ? { goalStatus: "cancelled" as const, goalCompletedAt: cancelAt.getTime() }
        : {}),
    });
    // Drop from queue if it hasn't started; abort if it has.
    taskWorker.cancelQueued(currentTaskId);
    const ac = getAbortController(currentTaskId);
    if (ac) ac.abort("cancelled");
    await sendTextReply(
      binding.chatId,
      `✋ Stopped task ${currentTaskId.slice(-8)}.`,
      binding.id,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[feishu-channel-command] stop failed:", err instanceof Error ? err.message : err);
    await sendTextReply(
      binding.chatId,
      `Failed to stop task: ${err instanceof Error ? err.message : "unknown error"}`,
      binding.id,
    );
  }
  return { handled: true, replyChatId: binding.chatId };
}

async function handleNewCommand(input: {
  binding: { id: string; workspaceId: string; chatId: string };
}): Promise<SlashCommandResult> {
  const { binding } = input;
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.getByBindingId(binding.id);

  if (!session) {
    await sendTextReply(
      binding.chatId,
      "No active session in this chat yet — send a regular message to start one.",
      binding.id,
    );
    return { handled: true, replyChatId: binding.chatId };
  }

  // Resetting = clear the resume pointers so the next inbound message
  // creates a fresh task instead of resuming the current one. The
  // previous task isn't cancelled — its history stays accessible from
  // the web. If the leader loop is still running, it keeps running
  // (orphaned from this chat).
  await sessionRepo.update(session.id, {
    currentTaskId: null,
    currentLeaderSessionId: null,
    latestInboundMessageId: null,
    latestDeliveredMessageId: null,
    latestAnswerSummary: null,
    updatedAt: new Date(),
  });

  await sendTextReply(
    binding.chatId,
    "🆕 New chat. Your next message will start a fresh task. The previous conversation is preserved on the web.",
    binding.id,
  );
  return { handled: true, replyChatId: binding.chatId };
}

async function handleHelpCommand(input: {
  binding: { id: string; workspaceId: string; chatId: string };
}): Promise<SlashCommandResult> {
  const { binding } = input;
  const sessionRepo = new ChannelSessionRepository();
  const session = await sessionRepo.getByBindingId(binding.id);
  const lines: string[] = [];
  lines.push("Magister slash commands:");
  lines.push("  /stop                - stop the current running task");
  lines.push("  /new                 - start a fresh task (clear current session)");
  lines.push("  /ws                  - show current workspace binding");
  lines.push("  /ws <workspace_id>   - switch workspace");
  lines.push("  /ws clear            - reset to default");
  lines.push("  /verbose             - show current verbose level");
  lines.push("  /verbose off|low|high - set verbose level");
  lines.push("  /help                - show this list");
  lines.push("");
  lines.push("Current state:");
  lines.push(`  workspace: ${binding.workspaceId}`);
  lines.push(`  verbose:   ${session?.verboseLevel ?? "off"}`);
  await sendTextReply(binding.chatId, lines.join("\n"), binding.id);
  return { handled: true, replyChatId: binding.chatId };
}

/**
 * Parse + dispatch a slash command. Returns `{ handled: false }` if
 * the text isn't a recognized command (caller should fall through to
 * the normal task-creation path). Returns `{ handled: true }` after
 * sending the reply.
 */
export async function tryHandleSlashCommand(input: {
  text: string;
  binding: { id: string; workspaceId: string; chatId: string };
}): Promise<SlashCommandResult> {
  const trimmed = input.text.trimStart();
  if (!isSlashCommand(trimmed)) return { handled: false };

  const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
  const command = (tokens[0] ?? "").toLowerCase();
  const args = tokens.slice(1);

  switch (command) {
    case "stop":
    case "cancel":
    case "abort":
      return handleStopCommand({ binding: input.binding });
    case "new":
    case "reset":
      return handleNewCommand({ binding: input.binding });
    case "ws":
      return handleWsCommand({ binding: input.binding, args });
    case "verbose":
      return handleVerboseCommand({ binding: input.binding, args });
    case "help":
      return handleHelpCommand({ binding: input.binding });
    default:
      // Unknown slash — fall through. Lets the user write things
      // like "/foo bar" as regular tasks if they want.
      return { handled: false };
  }
}
