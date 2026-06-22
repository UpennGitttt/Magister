import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  cancelGoal,
  cancelTask,
  createTask,
  fileToAttachment,
  getModels,
  getStatusReport,
  getTaskModel,
  getTaskSnapshotLight,
  optimizeGoalObjective,
  renderMcpPrompt,
  requestCompact,
  sendTaskMessage,
  setTaskModel,
  startGoalOnTask,
  type McpPromptDescriptor,
  type McpPromptMessage,
} from "../../lib/api";
import { SlashCommandCard, type SlashResult } from "./SlashCommandCard";
import { ApiError } from "../../lib/request";
import { useActiveWorkspace } from "../../hooks/useActiveWorkspace";
import { useSelectedTaskId } from "../../hooks/useSelectedTaskId";
import { useChatStore } from "../../stores/chatStore";
import { useTaskStore } from "../../stores/taskStore";
import { useUiStore } from "../../stores/uiStore";
import { useWSStore } from "../../stores/wsStore";
import { getModSymbol } from "../../lib/platform";
import { formatStatusReportForChat } from "./statusReportFormat";
import { markPromptSent } from "./conversation/sseAdapter";
import { SlashMenu, type SlashBuiltin, type SlashMenuItem } from "./SlashMenu";
import { PromptArgsForm } from "./PromptArgsForm";

/** Built-in slash commands available in the chat input. Kept tiny on
 *  purpose — only commands that genuinely belong here go in. */
const BUILTIN_SLASH_COMMANDS: SlashBuiltin[] = [
  { name: "status", description: "Show workspace, agents, MCP, and active task" },
  {
    name: "stop",
    description: "Interrupt the running task",
    available: (ctx) => !!(ctx as { showStop?: boolean }).showStop,
  },
  { name: "clear", description: "Clear conversation display" },
  {
    name: "compact",
    description: "Trigger context compaction [hint]",
    // Relaxed: show on any existing, non-terminal conversation (idle or
    // running), not just while the agent is mid-stream. Hidden in a
    // fresh chat (no task) and on terminal tasks (nothing to compact).
    available: (ctx) => {
      const c = ctx as { selectedTaskId?: string | null; isTerminal?: boolean };
      return !!c.selectedTaskId && !c.isTerminal;
    },
  },
  {
    name: "goal",
    description: "Set, check, or clear an autonomous goal",
    available: () => true,
  },
  {
    name: "model",
    description: "Switch the leader's model for this task",
    // Always available: in a fresh chat the pick is parked and applied
    // on first send; in an existing chat — including a finished (DONE)
    // one — switching the model takes effect on the next follow-up turn
    // (the resume path applies tasks.model_override). The backend no
    // longer rejects terminal tasks, so we no longer hide it on them.
    available: () => true,
  },
];

// Mirror of the backend's terminal-state set (routes/tasks.ts +
// task-retention-service.ts). Used to decide whether the Stop button
// should still be present — if the server says the task is done, the
// answer is no regardless of any other transient signal.
const TERMINAL_TASK_STATES = new Set([
  "DONE", "COMPLETED", "FAILED", "CANCELLED", "BLOCKED",
  "MERGE_WAITING", "PR_OPEN",
]);

function isTerminalTaskState(state: string | undefined): boolean {
  if (!state) return false;
  return TERMINAL_TASK_STATES.has(state.trim().toUpperCase());
}

// Backend whitelists images + plain-text formats + document
// formats (DOCX/XLSX/PDF, extracted at load time). Mirror those
// here so the picker filter matches what saveAttachments will
// accept; the size cap differs per kind (see MAX_*_BYTES).
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
const ALLOWED_TEXT_TYPES = ["text/markdown", "text/plain", "text/csv"];
const ALLOWED_DOCUMENT_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];
// Browsers sometimes report unknown mime for `.md` / `.markdown`
// (Safari sends empty, some platforms send application/octet-stream).
// `inferMimeType` in lib/api.ts canonicalizes the mime before send,
// but the front-end gate runs before that — listing extensions here
// keeps user-clicked uploads from being silently rejected at stage 1.
const ALLOWED_FILE_EXTENSIONS = [".md", ".markdown", ".pdf", ".docx", ".xlsx", ".xls"];
const ALLOWED_ALL_TYPES = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_TEXT_TYPES, ...ALLOWED_DOCUMENT_TYPES];
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_BYTES = 1 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENTS_PER_TURN = 10;
const PENDING_ACTION_NOTICE_MS = 1200;

function isAllowedImage(file: File): boolean {
  return ALLOWED_IMAGE_TYPES.includes(file.type.toLowerCase());
}

function isAllowedText(file: File): boolean {
  if (ALLOWED_TEXT_TYPES.includes(file.type.toLowerCase())) return true;
  // Browsers sometimes report `.md` as `application/octet-stream`
  // or empty mime. Fall back to the extension so the user's drop
  // doesn't get silently rejected. Limit the extension fallback
  // here to text-shaped formats; documents are handled separately
  // because they have a different size budget.
  const lower = file.name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isAllowedDocument(file: File): boolean {
  if (ALLOWED_DOCUMENT_TYPES.includes(file.type.toLowerCase())) return true;
  const lower = file.name.toLowerCase();
  return [".pdf", ".docx", ".xlsx", ".xls"].some((ext) => lower.endsWith(ext));
}

function maxBytesFor(file: File): number {
  if (isAllowedImage(file)) return MAX_IMAGE_BYTES;
  if (isAllowedDocument(file)) return MAX_DOCUMENT_BYTES;
  return MAX_TEXT_BYTES;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let newChatSessionId: string | null = null;

function getOrCreateNewChatSessionId(): string {
  if (!newChatSessionId) {
    newChatSessionId = `web:chat:${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
  return newChatSessionId;
}

export function resetWebSession() {
  newChatSessionId = null;
}

type SlashState =
  | { kind: "closed" }
  | { kind: "menu"; filter: string }
  | { kind: "args"; prompt: McpPromptDescriptor };

const CHAT_DRAFT_STORAGE_KEY = "magister_chat_draft";
const LEGACY_CHAT_DRAFT_STORAGE_KEY = "ucm_chat_draft";
const CHAT_PIN_BOTTOM_EVENT = "magister:chat-pin-bottom";

export function ChatInput() {
  // Initial value rehydrates from sessionStorage so a draft preserved
  // by the /status (or future) slash-builtin navigation comes back
  // when the chat remounts. Read-and-clear so it only fires once.
  const [value, setValue] = useState(() => {
    try {
      const stashed = sessionStorage.getItem(CHAT_DRAFT_STORAGE_KEY)
        ?? sessionStorage.getItem(LEGACY_CHAT_DRAFT_STORAGE_KEY);
      if (stashed) {
        sessionStorage.removeItem(CHAT_DRAFT_STORAGE_KEY);
        sessionStorage.removeItem(LEGACY_CHAT_DRAFT_STORAGE_KEY);
        return stashed;
      }
    } catch { /* private mode or quota — start blank */ }
    return "";
  });
  const [sending, setSending] = useState(false);
  const [showSendPendingNotice, setShowSendPendingNotice] = useState(false);
  const [slash, setSlash] = useState<SlashState>({ kind: "closed" });
  // Keyboard navigation for the slash menu. The textarea keeps focus
  // (the user is still typing the filter), so ↑/↓/Enter are handled in
  // `handleKeyDown` here and mapped to the highlighted row. SlashMenu
  // owns the filtered/ordered list (behind an async prompt fetch) and
  // reports it up via `onItemsChange` into `slashItemsRef` so this
  // handler can resolve `slashActiveIndex` → the right select action.
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const slashItemsRef = useRef<SlashMenuItem[]>([]);
  // Watch for the compaction-result event after a /compact request and
  // flip the queued card into a result card with real token stats. The
  // backend consumes the request at the next turn_start (or the next
  // user message if the agent already went idle), so the result lands
  // seconds later — this closes the "did it actually run / how much did
  // it save?" gap the queued-only card left open. Bound to the taskId
  // the request was issued against so switching sessions can't mis-match.
  const compactWatchRef = useRef<{ cardId: number; taskId: string; seenIds: Set<string> } | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  // Image attachments staged for this prompt. We hold the raw
  // File objects (not base64) until send time so the textarea
  // stays responsive while the user types — base64 encoding can
  // take 10-50ms for a multi-MB image and we don't want it on
  // every keystroke. Object URLs are minted lazily for thumbnail
  // preview and revoked on dismount/clear.
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // Platform-aware modifier glyph (⌘ on Mac, Ctrl elsewhere). Stable
  // per mount so the UA scan is one-shot, not per-render.
  const modSym = useMemo(() => getModSymbol(), []);

  // Path A — workspaceId for new tasks. Three-tier resolution:
  //   1. URL segment `:wid` (deeplinks into a specific workspace)
  //   2. active picker selection (the user's last choice)
  //   3. backend default fallback (legacy "workspace_main")
  const { wid: urlWorkspaceId } = useParams<{ wid?: string }>();
  const { activeId: activeWorkspaceId } = useActiveWorkspace();
  /** Plan mode is a session-wide toggle (spec §3) — lives in uiStore
   *  with localStorage persistence so it survives reloads and switching
   *  between chat sessions. Matches Claude Code's permission-mode model. */
  // Slash command results (ephemeral, local).
  const [slashResults, setSlashResults] = useState<Array<{ id: number; result: SlashResult }>>([]);
  // Auto-dismiss slash result cards after 30 seconds of inactivity.
  useEffect(() => {
    if (slashResults.length === 0) return;
    const timer = setTimeout(() => setSlashResults([]), 30_000);
    return () => clearTimeout(timer);
  }, [slashResults]);

  // Live compaction feedback (see compactWatchRef above). Subscribe to
  // the chatStore once; when a NEW `compaction` system notice appears
  // for the watched task, fold its pre→post token stats back into the
  // /compact card. Upserts the card so the result still surfaces even
  // if the queued card was auto-dismissed during the wait.
  useEffect(() => {
    const unsub = useChatStore.subscribe((state) => {
      const watch = compactWatchRef.current;
      if (!watch) return;
      const conv = state.conversations[watch.taskId];
      if (!conv) return;
      for (const exchange of conv.exchanges) {
        for (const part of exchange.response.parts) {
          if (part.kind !== "system" || part.variant !== "compaction") continue;
          if (watch.seenIds.has(part.id)) continue;
          // First fresh compaction notice → this is our result.
          compactWatchRef.current = null;
          const message = part.detail ? `✓ ${part.headline}\n${part.detail}` : `✓ ${part.headline}`;
          setSlashResults((prev) => {
            const updated = { id: watch.cardId, result: { kind: "compact_result" as const, data: { message } } };
            const exists = prev.some((r) => r.id === watch.cardId);
            return (exists
              ? prev.map((r) => (r.id === watch.cardId ? updated : r))
              : [updated, ...prev]
            ).slice(0, 4);
          });
          return;
        }
      }
    });
    return unsub;
  }, []);
  const planMode = useUiStore((s) => s.planMode);
  const togglePlanMode = useUiStore((s) => s.togglePlanMode);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Pre-task model pick: when /model is opened in a fresh chat (no
  // selectedTaskId yet) the user's choice is parked here and applied
  // by handleSend right after createTask returns a taskId. Resets to
  // null after apply or when the user clears the pick.
  const pendingModelOverrideRef = useRef<string | null>(null);
  const [pendingModelOverride, setPendingModelOverride] = useState<string | null>(null);
  const navigate = useNavigate();
  const selectedTaskId = useSelectedTaskId();
  const fetchTasks = useTaskStore((s) => s.fetchTasks);
  const setWaitingForResponse = useTaskStore((s) => s.setWaitingForResponse);

  // Object URLs for thumbnails. Created lazily per attachment;
  // revoked when the attachment list changes / component unmounts
  // so we don't leak blob: URLs.
  const thumbnailUrls = useMemo(
    () => attachments.map((file) => URL.createObjectURL(file)),
    [attachments],
  );
  useEffect(() => {
    return () => {
      thumbnailUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [thumbnailUrls]);

  useEffect(() => {
    if (!sending) {
      setShowSendPendingNotice(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setShowSendPendingNotice(true);
    }, PENDING_ACTION_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);

  function addFiles(files: File[]) {
    if (files.length === 0) return;
    const errors: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      const isImage = isAllowedImage(file);
      const isText = isAllowedText(file);
      const isDoc = isAllowedDocument(file);
      if (!isImage && !isText && !isDoc) {
        errors.push(
          `${file.name}: supported formats are images (PNG/JPEG/GIF/WebP), Markdown/plain text, and documents (PDF/DOCX/XLSX)`,
        );
        continue;
      }
      const maxBytes = maxBytesFor(file);
      if (file.size > maxBytes) {
        errors.push(`${file.name}: ${formatBytes(file.size)} exceeds ${formatBytes(maxBytes)} limit`);
        continue;
      }
      accepted.push(file);
    }
    setAttachments((prev) => {
      const combined = [...prev, ...accepted];
      if (combined.length > MAX_ATTACHMENTS_PER_TURN) {
        errors.push(`Maximum ${MAX_ATTACHMENTS_PER_TURN} attachments per message; extra dropped.`);
        return combined.slice(0, MAX_ATTACHMENTS_PER_TURN);
      }
      return combined;
    });
    setAttachmentError(errors.length > 0 ? errors.join("\n") : null);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentError(null);
  }

  function handleFilePicker(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    addFiles(files);
    // Reset value so re-selecting the same file works.
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    addFiles(files);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    addFiles(files);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
  }

  function autoResize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Cap auto-grow height: on mobile (≤880px) allow up to 50% of the
    // viewport so the textarea can really expand on the dominant
    // interaction surface; on desktop keep the historical 160px cap so
    // the input doesn't shove the conversation off-screen on tall
    // monitors. Falls back gracefully when window is unavailable (SSR).
    const isMobile =
      typeof window !== "undefined" && window.innerWidth <= 880;
    const cap = isMobile
      ? Math.floor((window.innerHeight || 800) * 0.5)
      : 160;
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }

  async function handleSend() {
    const trimmed = value.trim();
    // Allow send when EITHER text OR attachments are present —
    // a user might want to send "what's in this?" with just an
    // image, or just text without an image. Disallow only fully
    // empty submits.
    if ((!trimmed && attachments.length === 0) || sending) return;

    // Intercept slash commands typed + sent (not just menu-clicked).
    // Without this, `/goal something` goes to the agent as a literal message.
    const slashMatch = trimmed.match(/^\/(status|stop|clear|compact|goal|model)(?:\s|$)/);
    if (slashMatch?.[1]) {
      dispatchBuiltinCommand(slashMatch[1], trimmed);
      return;
    }

    // Dismiss any lingering slash result cards on a real send.
    setSlashResults([]);
    // The user-visible prompt is exactly what they typed. The
    // plan-mode trigger is conveyed to the backend via a structured
    // `planMode: true` flag on the createTask body — backend turns
    // that into a system-prompt addendum for THIS turn (per spec §3,
    // §11). Earlier draft prepended a preamble to the user message
    // itself, which polluted the chat bubble visually and conflated
    // user intent with system instructions.
    const prompt = trimmed;

    setSending(true);
    setWaitingForResponse(true);
    setValue("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Stage attachments locally so we can restore on error.
    // Encoding happens in this fn (off the textarea path) — base64
    // is CPU-bound (10 MiB image ~ 100ms) but fine to do once at
    // send time.
    const stagedFiles = attachments;
    setAttachments([]);
    setAttachmentError(null);
    let encodedAttachments: Awaited<ReturnType<typeof fileToAttachment>>[] = [];
    if (stagedFiles.length > 0) {
      try {
        encodedAttachments = await Promise.all(stagedFiles.map(fileToAttachment));
      } catch (err) {
        // Encoding failure — restore staged files so the user can
        // retry; surface the error in the regular error path
        // below.
        setAttachments(stagedFiles);
        useTaskStore.setState({
          error: err instanceof Error ? err.message : "Failed to encode attachment",
        });
        setSending(false);
        setWaitingForResponse(false);
        return;
      }
    }
    // Clear any prior send error so the banner disappears when the retry
    // succeeds — or if a fresh attempt fails again, the new error replaces it.
    useTaskStore.setState({ error: null });

    // Determine binding ID — selectedTaskId comes from URL via useSelectedTaskId.
    const tasks = useTaskStore.getState().tasks;
    const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;
    const bindingId = selectedTask?.rootChannelBindingId || getOrCreateNewChatSessionId();

    // PR 2.5: pre-network optimistic now goes into chatStore via the
    // single `beginExchange(taskId, prompt)` primitive. Pass the
    // currently-selected taskId for follow-up turns; pass `null` for a
    // fresh chat so chatStore parks the exchange in a `_pending:*`
    // bucket. `bindRequestId` later atomically migrates it to the real
    // (taskId, requestId) — no rebirth-dance, no stale closures.
    const attachmentMeta = stagedFiles.map((f) => ({
      filename: f.name,
      mimeType: f.type || "application/octet-stream",
      sizeBytes: f.size,
    }));
    const chatStoreLocalId = useChatStore.getState().beginExchange(
      selectedTaskId,
      prompt,
      attachmentMeta.length > 0 ? attachmentMeta : undefined,
    );

    // Force ChatArea to pin to bottom — user just sent, they want to
    // see their bubble + thinking placeholder, even if they were
    // scrolled up reading older content. The auto-scroll effect
    // respects nearBottom for INCOMING content; user-initiated sends
    // override that.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(CHAT_PIN_BOTTOM_EVENT));
    }

    try {
      const result = await createTask({
        prompt,
        source: "web",
        // Path A — prefer the URL's `:wid` segment (so deep-linking
        // a chat lands on the right workspace), fall back to the
        // active picker selection, and finally to the legacy default.
        workspaceId: urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main",
        rootChannelBindingId: bindingId,
        // Wire field is named `planFirst` to match the spec / backend
        // route schema; the local store calls it `planMode` because
        // that's what users see / mean. Same flag, different vocabulary.
        ...(planMode ? { planFirst: true } : {}),
        ...(encodedAttachments.length > 0 ? { attachments: encodedAttachments } : {}),
      });

      // Apply a pending model pick from a /model command issued in
      // the new-chat state (before any task existed). Fire-and-forget
      // — failure to apply override should not block the prompt from
      // landing; the user will see the default in Session Context and
      // can /model again. Clears the parked pick on success or hard
      // failure either way.
      if (pendingModelOverrideRef.current) {
        const overrideToApply = pendingModelOverrideRef.current;
        pendingModelOverrideRef.current = null;
        setPendingModelOverride(null);
        void (async () => {
          try {
            await setTaskModel(result.taskId, overrideToApply, { confirm: true });
          } catch (err) {
            console.warn("[chat-input] pending /model apply failed:", err instanceof Error ? err.message : String(err));
          }
        })();
      }

      // Mark the prompt-sent timestamp for SSE telemetry. Does nothing
      // when the localStorage profile flag is off. Stamping AFTER
      // createTask resolves means the measurement excludes the network
      // RTT for POST /tasks itself; that's intentional — we want
      // "backend received the prompt → first stream_delta back to me",
      // which is the apples-to-apples comparison with ChatGPT-style
      // streaming where the request handshake is folded into the
      // streaming connection.
      markPromptSent(result.taskId);

      // Both ids now known — bind atomically.
      useChatStore.getState().bindRequestId(chatStoreLocalId, result.taskId, result.requestId);

      // Sticky-per-session per spec §3 — the toggle stays on until
      // the user explicitly turns it off. Earlier draft reset to
      // false after each send, but that surprised users who toggled
      // it on intending to drive the rest of the conversation
      // through plan mode.

      // URL is the single source of truth for selection. Just navigate;
      // the URL change drives ChatArea's reset effect (which preserves
      // optimistic messages because isWaitingForResponse is still true)
      // and the WS event handler's "is this my task?" check (via the
      // currentRoute mirror updated by ChatPage).
      if (result.status === "queued") {
        // Kimi review C2 — fall back to the legacy seed slug, not
        // a literal "default" that no row uses.
        navigate(
          `/w/${urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main"}/sessions/${result.taskId}`,
          { replace: true },
        );
        await fetchTasks();
      } else {
        // Legacy / synchronous path — task is already done.
        // Kimi review C2 — fall back to the legacy seed slug, not
        // a literal "default" that no row uses.
        navigate(
          `/w/${urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main"}/sessions/${result.taskId}`,
          { replace: true },
        );
        useTaskStore.getState().completeSend(result.taskId);
        fetchTasks();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send message";
      setWaitingForResponse(false);
      useTaskStore.setState({ error: msg });
      // chatStore rollback by localId — looks up across all conversations
      // (including the `_pending:*` bucket for pre-network optimistic).
      // The exchange disappears from the render; the error is surfaced
      // inline via SendErrorBar (rendered in ChatPage). Restore the text
      // so the user can retry without re-typing.
      useChatStore.getState().rollbackOptimistic(chatStoreLocalId);
      // Restore the user's typed text + staged attachments so retry
      // feels like editing what they had. `planMode` is sticky-per-session,
      // so it's still on — one-tap retry keeps plan mode driving the
      // next attempt.
      setValue(trimmed);
      setAttachments(stagedFiles);
      if (textareaRef.current) {
        textareaRef.current.value = trimmed;
        autoResize();
        // Focus so the user can hit Enter to retry immediately.
        textareaRef.current.focus();
      }
    } finally {
      setSending(false);
    }
  }

  async function handlePromptSubmit(prompt: McpPromptDescriptor, args: Record<string, string>) {
    setRenderError(null);
    let messages: McpPromptMessage[];
    try {
      const result = await renderMcpPrompt({ serverId: prompt.serverId, name: prompt.name, args });
      messages = result.messages;
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Failed to render prompt");
      return;
    }

    // Extract first text-content user message → use as the task's
    // visible "prompt" (drives the task title). Fallback when the
    // rendered messages have no text user message: use a synthetic
    // marker so the title isn't blank.
    let titlePrompt = `[${prompt.serverName}/${prompt.name}]`;
    for (const m of messages) {
      if (m.role === "user" && m.content.type === "text") {
        titlePrompt = m.content.text;
        break;
      }
    }

    // Reset textarea + close menu.
    setValue("");
    setSlash({ kind: "closed" });
    if (textareaRef.current) {
      textareaRef.current.value = "";
      autoResize();
    }

    // Mirror the optimistic flow from handleSend (sans attachments).
    setSending(true);
    setWaitingForResponse(true);
    useTaskStore.setState({ error: null });
    const tasks = useTaskStore.getState().tasks;
    const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : null;
    const bindingId = selectedTask?.rootChannelBindingId || getOrCreateNewChatSessionId();
    const chatStoreLocalId = useChatStore.getState().beginExchange(selectedTaskId, titlePrompt);

    try {
      const result = await createTask({
        prompt: titlePrompt,
        source: "web",
        // Path A — prefer the URL's `:wid` segment (so deep-linking
        // a chat lands on the right workspace), fall back to the
        // active picker selection, and finally to the legacy default.
        workspaceId: urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main",
        rootChannelBindingId: bindingId,
        promptMessages: messages,
      });
      markPromptSent(result.taskId);
      useChatStore.getState().bindRequestId(chatStoreLocalId, result.taskId, result.requestId);
      if (result.status === "queued") {
        // Kimi review C2 — fall back to the legacy seed slug, not
        // a literal "default" that no row uses.
        navigate(
          `/w/${urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main"}/sessions/${result.taskId}`,
          { replace: true },
        );
        await fetchTasks();
      } else {
        // Kimi review C2 — fall back to the legacy seed slug, not
        // a literal "default" that no row uses.
        navigate(
          `/w/${urlWorkspaceId ?? activeWorkspaceId ?? import.meta.env.VITE_DEFAULT_WORKSPACE_ID ?? "workspace_main"}/sessions/${result.taskId}`,
          { replace: true },
        );
        useTaskStore.getState().completeSend(result.taskId);
        fetchTasks();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send message";
      setWaitingForResponse(false);
      useTaskStore.setState({ error: msg });
      useChatStore.getState().rollbackOptimistic(chatStoreLocalId);
    } finally {
      setSending(false);
    }
  }

  const composing = useRef(false);

  // Canonicalize a builtin dispatch from the current input. The typed
  // text is a PARTIAL command (e.g. "/mod" while the menu shows
  // "model"). Preserve any REAL trailing args the user typed, but never
  // pass the partial command token itself as the arg — rebuild the
  // dispatch string from the SELECTED builtin's canonical name. So
  // "/mod" → "/model" (opens picker) and "/goal fix bug" →
  // "/goal fix bug" (args preserved). Shared by menu-click and keyboard
  // select so the two paths stay identical.
  function dispatchBuiltinFromInput(name: string): void {
    const raw = value.trim();
    const sp = raw.indexOf(" ");
    const args = sp >= 0 ? raw.slice(sp + 1).trim() : "";
    dispatchBuiltinCommand(name, args ? `/${name} ${args}` : `/${name}`);
  }

  // Select the slash-menu row at `index`: built-ins dispatch directly,
  // MCP prompts open the args form. Mirrors SlashMenu's onSelect /
  // onSelectBuiltin so keyboard and click share one path.
  function selectSlashIndex(index: number): boolean {
    const item = slashItemsRef.current[index];
    if (!item) return false;
    if (item.type === "builtin") {
      dispatchBuiltinFromInput(item.builtin.name);
    } else {
      setSlash({ kind: "args", prompt: item.prompt });
      setRenderError(null);
    }
    return true;
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape" && slash.kind !== "closed") {
      e.preventDefault();
      setSlash({ kind: "closed" });
      setRenderError(null);
      return;
    }
    // Arrow-key navigation while the slash menu is open. The textarea
    // keeps focus, so we steal ↑/↓ from cursor movement and move the
    // highlighted row instead (wrapping at the ends).
    if (slash.kind === "menu" && !composing.current && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const count = slashItemsRef.current.length;
      if (count > 0) {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setSlashActiveIndex((i) => ((i + delta) % count + count) % count);
      }
      return;
    }
    // Tab autocompletes the highlighted row without running it: built-ins
    // fill `/<name> ` so the user can type args; MCP prompts (which have
    // no inline arg syntax) fall through to selection. Trapped while the
    // menu is open so focus doesn't escape the composer.
    if (slash.kind === "menu" && !composing.current && e.key === "Tab" && !e.shiftKey) {
      e.preventDefault();
      const item = slashItemsRef.current[slashActiveIndex];
      if (item?.type === "builtin") {
        const completed = `/${item.builtin.name} `;
        setValue(completed);
        setSlash({ kind: "menu", filter: `${item.builtin.name} ` });
        setSlashActiveIndex(0);
        const el = textareaRef.current;
        if (el) {
          // Caret to end after React commits the controlled value.
          requestAnimationFrame(() => {
            el.focus();
            try { el.setSelectionRange(completed.length, completed.length); } catch { /* jsdom */ }
            autoResize();
          });
        }
      } else if (item?.type === "prompt") {
        selectSlashIndex(slashActiveIndex);
      }
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !composing.current) {
      // Args form is sticky — the user is filling fields; don't send.
      if (slash.kind === "args") return;
      // Slash menu is open: Enter commits the highlighted row (built-in
      // or MCP prompt) rather than raw-sending the filter text. When
      // the list is empty (still loading / no matches) we swallow Enter
      // so a half-typed `/comm` doesn't leak to the agent as a message.
      if (slash.kind === "menu") {
        // Belt-and-suspenders IME guard: an IME-composition Enter (used
        // to CONFIRM a composed CJK string) must never commit a slash
        // command. `composing.current` already gates this branch, but
        // some IMEs fire keydown before compositionstart — check the
        // native flag too.
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        selectSlashIndex(slashActiveIndex);
        return;
      }
      e.preventDefault();
      handleSend();
    }
  }

  // While the agent is mid-stream we have a real taskId to cancel.
  // The Stop button is in-context (replaces the Send button) so the
  // user doesn't have to spot a separate Cancel bar.
  const waitingForResponse = useTaskStore((s) => s.isWaitingForResponse);
  const tasks = useTaskStore((s) => s.tasks);
  const activeAgents = useWSStore((s) => s.activeAgents);
  const isAborting = useRef(false);
  async function handleStop() {
    if (!selectedTaskId || isAborting.current) return;
    isAborting.current = true;
    try {
      await cancelTask(selectedTaskId);
    } catch {
      // Surface failure but don't block — best-effort.
    } finally {
      // Optimistically clear the waiting state; the WS event will
      // reconcile if anything strays.
      useTaskStore.setState({ isWaitingForResponse: false });
      isAborting.current = false;
    }
  }
  // The button shows STOP when the agent is busy on the selected
  // task — even after the network request returned, the agent may
  // still be streaming further turns.
  //
  // Three independent signals can each indicate "still busy". OR them
  // together so a transient flip on one (e.g. a stray task:completed
  // event from an earlier turn clearing isWaitingForResponse while a
  // follow-up turn is still streaming) doesn't strand the user with a
  // disabled Send button and no way to intervene.
  //   1. `waitingForResponse` — local optimistic flag, set on send.
  //   2. selected task is in a non-terminal DB state.
  //   3. an active agent for this taskId is heartbeating on the WS.
  const selectedTaskForStop = selectedTaskId
    ? tasks.find((t) => t.id === selectedTaskId)
    : null;
  const selectedTaskIsActive = selectedTaskForStop
    ? !isTerminalTaskState(selectedTaskForStop.state)
    : false;
  // Terminal = the backend will reject model-override / compaction with
  // a raw "Task is in terminal state ..." error. Used to gate /model and
  // /compact in the menu and to short-circuit their handlers with a
  // friendly inline card instead of surfacing the backend rejection.
  const selectedTaskIsTerminal = selectedTaskForStop
    ? isTerminalTaskState(selectedTaskForStop.state)
    : false;
  const hasActiveAgentForTask = selectedTaskId
    ? activeAgents.some((a) => a.taskId === selectedTaskId)
    : false;
  const showStop = !!selectedTaskId && (
    waitingForResponse || selectedTaskIsActive || hasActiveAgentForTask
  );

  const canSend = (value.trim().length > 0 || attachments.length > 0) && !sending;

  // Prepend a slash result card, but REPLACE any prior card for the same
  // command so repeated failures (e.g. spamming /model on a terminal
  // task) swap in place instead of stacking up to the 4-card cap. Cards
  // without a `command` field (compact_result / stop_result / status /
  // model_picker …) are just prepended — the `cmd ? … : prev` branch
  // skips dedupe for them.
  const pushSlashResult = useCallback((result: SlashResult) => {
    setSlashResults((prev) => {
      const cmd = (result as { data?: { command?: string } }).data?.command;
      const filtered = cmd
        ? prev.filter((r) => (r.result as { data?: { command?: string } }).data?.command !== cmd)
        : prev;
      return [{ id: Date.now(), result }, ...filtered].slice(0, 4);
    });
  }, []);

  /**
   * Central dispatcher for built-in slash commands. Called both when the
   * user clicks a command from SlashMenu AND when they type + send a slash
   * command directly (e.g. `/goal something` → Enter).
   *
   * @param name      - The command name without the leading `/` (e.g. "goal").
   * @param inputText - The full trimmed input text at the moment of dispatch.
   *                    Used by compact/goal to parse trailing args.
   * @returns true if the command was handled, false if unrecognised.
   */
  const dispatchBuiltinCommand = useCallback(
    (name: string, inputText: string): boolean => {
      if (name === "status") {
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });
        void (async () => {
          try {
            const report = await getStatusReport(
              selectedTaskId ? { taskId: selectedTaskId } : undefined,
            );
            const { headline, detail } = formatStatusReportForChat(
              report,
              selectedTaskId,
            );
            setSlashResults((prev) => [
              { id: Date.now(), result: { kind: "system_status" as const, data: { headline, detail } } },
              ...prev,
            ].slice(0, 4));
          } catch (err) {
            pushSlashResult({
              kind: "error" as const,
              data: {
                command: "status",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
        return true;
      }

      if (name === "stop") {
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });
        if (!selectedTaskId) return true;
        void (async () => {
          try {
            await cancelTask(selectedTaskId);
            useTaskStore.setState({ isWaitingForResponse: false });
            setSlashResults((prev) => [
              {
                id: Date.now(),
                result: {
                  kind: "stop_result" as const,
                  data: { message: "Task interrupted. Send a follow-up to redirect." },
                },
              },
              ...prev,
            ].slice(0, 4));
          } catch (err) {
            pushSlashResult({
              kind: "error" as const,
              data: {
                command: "stop",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
        return true;
      }

      if (name === "clear") {
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });
        setSlashResults([]);
        if (selectedTaskId) {
          useChatStore.getState().clearExchanges(selectedTaskId);
        }
        return true;
      }

      if (name === "compact") {
        const hint = inputText.startsWith("/compact ")
          ? inputText.slice("/compact ".length).trim()
          : undefined;
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });
        if (!selectedTaskId) return true;
        // Defensive guard for the type-and-send path (which bypasses the
        // menu's availability gate): refuse on a terminal task with a
        // friendly inline card instead of surfacing the backend's raw
        // terminal-state rejection. Done BEFORE arming the watcher so the
        // watcher only runs for a genuinely live conversation.
        {
          const t = useTaskStore.getState().tasks.find((x) => x.id === selectedTaskId);
          if (t && isTerminalTaskState(t.state)) {
            pushSlashResult({
              kind: "error",
              data: { command: "compact", message: "This conversation is finished (DONE) — nothing to compact." },
            });
            return true;
          }
        }
        // Snapshot the compaction notices already in this task's
        // conversation so the watcher only reacts to the one THIS
        // request produces (not a prior auto-compaction).
        const compactTaskId = selectedTaskId;
        const seenIds = new Set<string>();
        const existingConv = useChatStore.getState().conversations[compactTaskId];
        if (existingConv) {
          for (const exchange of existingConv.exchanges) {
            for (const part of exchange.response.parts) {
              if (part.kind === "system" && part.variant === "compaction") seenIds.add(part.id);
            }
          }
        }
        const compactCardId = Date.now();
        void (async () => {
          try {
            await requestCompact(compactTaskId, hint || undefined);
            // Arm the watcher only after the request is durably queued.
            compactWatchRef.current = { cardId: compactCardId, taskId: compactTaskId, seenIds };
            setSlashResults((prev) => [
              {
                id: compactCardId,
                result: {
                  kind: "compact_result" as const,
                  data: {
                    message: hint
                      ? `Compaction queued with hint: "${hint}" — runs at the start of the next turn (or your next message if the agent is idle). Watching for the result…`
                      : "Compaction queued — runs at the start of the next turn (or your next message if the agent is idle). Watching for the result…",
                  },
                },
              },
              ...prev,
            ].slice(0, 4));
          } catch (err) {
            pushSlashResult({
              kind: "error" as const,
              data: {
                command: "compact",
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        })();
        return true;
      }

      if (name === "goal") {
        const afterGoal = inputText.startsWith("/goal ")
          ? inputText.slice("/goal ".length).trim()
          : "";
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });

        // /goal clear (or stop/cancel/off)
        const clearAliases = ["clear", "stop", "cancel", "off"];
        if (clearAliases.includes(afterGoal.toLowerCase())) {
          if (!selectedTaskId) return true;
          void (async () => {
            try {
              await cancelGoal(selectedTaskId);
              setSlashResults((prev) => [
                { id: Date.now(), result: { kind: "stop_result" as const, data: { message: "Goal cleared." } } },
                ...prev,
              ].slice(0, 4));
            } catch (err) {
              pushSlashResult({ kind: "error", data: { command: "goal", message: err instanceof Error ? err.message : String(err) } });
            }
          })();
          return true;
        }

        // /goal (no args) → status check
        if (!afterGoal) {
          if (!selectedTaskId) {
            pushSlashResult({ kind: "error", data: { command: "goal", message: "No active task. Start a conversation first." } });
            return true;
          }
          void (async () => {
            try {
              const snap = await getTaskSnapshotLight(selectedTaskId);
              const task = snap.task;
              const status = task.goalStatus || "none";
              const objective = task.goalObjective || "(no goal set)";
              const iterations = task.goalIterations ?? 0;
              const tokensUsed = task.goalTokensUsed ?? 0;
              const startedAt = task.goalStartedAt;
              const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
              const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
              const tokenStr = tokensUsed < 1000 ? `${tokensUsed}` : tokensUsed < 1_000_000 ? `${(tokensUsed / 1000).toFixed(1)}K` : `${(tokensUsed / 1_000_000).toFixed(2)}M`;
              const detail = `Status: ${status}\nObjective: ${objective}\nTurns: ${iterations}\nTokens: ${tokenStr}\nElapsed: ${elapsedStr}`;
              setSlashResults((prev) => [
                { id: Date.now(), result: { kind: "system_status" as const, data: { headline: `/goal · ${status}`, detail } } },
                ...prev,
              ].slice(0, 4));
            } catch (err) {
              pushSlashResult({ kind: "error", data: { command: "goal", message: err instanceof Error ? err.message : String(err) } });
            }
          })();
          return true;
        }

        // /goal <objective> → show activation card with optimize option
        const objective = afterGoal;
        const cardId = Date.now();

        const activateGoal = async (finalObjective: string) => {
          setSlashResults((prev) => prev.filter((r) => r.id !== cardId));
          try {
            // If the user is sitting on a terminal task (CANCELLED /
            // FAILED / DONE / etc.), starting a goal on it would fail
            // backend validation ("Task is in terminal state ..."). Treat
            // this case the same as fresh chat: spin up a new task with
            // the inline goal. Otherwise the user gets a confusing error
            // card when the natural intent is "new goal, new task".
            const selectedTask = selectedTaskId
              ? tasks.find((t) => t.id === selectedTaskId)
              : null;
            const taskTerminal = selectedTask
              ? isTerminalTaskState(selectedTask.state)
              : false;
            const useExisting = selectedTaskId && !taskTerminal;

            if (useExisting) {
              await startGoalOnTask(selectedTaskId, { objective: finalObjective });
              await sendTaskMessage(selectedTaskId, finalObjective);
            } else {
              const workspaceId = urlWorkspaceId || activeWorkspaceId || import.meta.env.VITE_DEFAULT_WORKSPACE_ID || "workspace_main";
              const result = await createTask({
                prompt: finalObjective,
                source: "web",
                workspaceId,
                rootChannelBindingId: getOrCreateNewChatSessionId(),
                goal: { objective: finalObjective },
              });
              if (result?.taskId) {
                navigate(`/w/${workspaceId}/sessions/${result.taskId}`, { replace: true });
                await fetchTasks();
              }
            }
            setSlashResults((prev) => [
              { id: Date.now(), result: { kind: "goal_activated" as const, data: { message: `Goal activated: ${finalObjective}` } } },
              ...prev,
            ].slice(0, 4));
          } catch (err) {
            pushSlashResult({ kind: "error", data: { command: "goal", message: err instanceof Error ? err.message : String(err) } });
          }
        };

        const optimize = async () => {
          if (!selectedTaskId) return;
          setSlashResults((prev) => prev.map((r) =>
            r.id === cardId && r.result.kind === "goal_activation"
              ? { ...r, result: { ...r.result, data: { ...r.result.data, phase: "optimizing" as const } } }
              : r,
          ));
          try {
            const resp = await optimizeGoalObjective(selectedTaskId, objective);
            setSlashResults((prev) => prev.map((r) =>
              r.id === cardId && r.result.kind === "goal_activation"
                ? { ...r, result: { ...r.result, data: { ...r.result.data, phase: "review" as const, optimized: resp.optimized, compressed: resp.compressed, overrideWarning: resp.overrideWarning ?? null } } }
                : r,
            ));
          } catch (err) {
            setSlashResults((prev) => prev.map((r) =>
              r.id === cardId && r.result.kind === "goal_activation"
                ? { ...r, result: { ...r.result, data: { ...r.result.data, phase: "error" as const, errorMessage: err instanceof Error ? err.message : String(err) } } }
                : r,
            ));
          }
        };

        const onUpdate = () => {};

        setSlashResults((prev) => [
          {
            id: cardId,
            result: {
              kind: "goal_activation" as const,
              data: {
                taskId: selectedTaskId,
                original: objective,
                phase: "confirm" as const,
                onActivate: activateGoal,
                onOptimize: optimize,
                onUpdate,
              },
            },
          },
          ...prev,
        ].slice(0, 4));
        return true;
      }

      if (name === "model") {
        setValue("");
        if (textareaRef.current) textareaRef.current.style.height = "auto";
        setSlash({ kind: "closed" });

        // NOTE: terminal (DONE/FAILED/CANCELLED) tasks are allowed to
        // switch model — the backend no longer rejects, and a follow-up
        // message re-wakes the leader with the new override applied. So
        // there is no terminal-state pre-check here; the switch proceeds
        // through the normal existing-task path below.

        const cardId = Date.now();

        // Fresh-chat path: no task to attach an override to yet. Show a
        // simplified picker that parks the pick in `pendingModelOverride`
        // — handleSend will apply it right after createTask returns
        // a taskId. No backend changes; no createTask-route flag.
        if (!selectedTaskId) {
          void (async () => {
            try {
              const modelsResp = await getModels();
              const options = modelsResp.items
                .filter((m) => m.providerRefs?.api)
                .map((m) => ({
                  modelName: m.modelName,
                  providerLabel: m.providerRefs?.api ?? "",
                  apiDialect: "",
                  contextWindow: m.contextWindow ?? null,
                }));
              setSlashResults((prev) => [
                {
                  id: cardId,
                  result: {
                    kind: "model_picker" as const,
                    data: {
                      taskId: "(pending)",
                      phase: "list" as const,
                      // No "current" since no task exists; show the
                      // parked pick (if any) as the highlighted row.
                      current: pendingModelOverride
                        ? { modelName: pendingModelOverride, providerLabel: "(pending — applies on first message)", apiDialect: "" }
                        : null,
                      options,
                      onPick: async (modelNameToSet: string | null) => {
                        pendingModelOverrideRef.current = modelNameToSet;
                        setPendingModelOverride(modelNameToSet);
                        setSlashResults((prev) => [
                          {
                            id: cardId,
                            result: {
                              kind: "model_switched" as const,
                              data: {
                                message: modelNameToSet
                                  ? `Will use ${modelNameToSet} for the first message of this new chat.`
                                  : "Cleared pending model pick.",
                                modelName: modelNameToSet ?? "(agent default)",
                                provider: "(pending)",
                                dialect: "",
                              },
                            },
                          },
                          ...prev.filter((r) => r.id !== cardId),
                        ].slice(0, 4));
                      },
                      onConfirmSwitch: async () => {},
                      onCancelSwitch: () => {
                        setSlashResults((prev) => prev.filter((r) => r.id !== cardId));
                      },
                    },
                  },
                },
                ...prev,
              ].slice(0, 4));
            } catch (err) {
              pushSlashResult({
                kind: "error",
                data: {
                  command: "model",
                  message: err instanceof Error ? err.message : String(err),
                },
              });
            }
          })();
          return true;
        }

        const taskId = selectedTaskId;

        // Inline arg shortcut: `/model <modelName>` — skip the picker and
        // commit directly. Falls through to the picker on validation
        // failure with a useful error message.
        const inlineArg = inputText.replace(/^\/model\s*/, "").trim();
        const lcArg = inlineArg.toLowerCase();

        const commitSwitch = async (
          modelNameToSet: string | null,
          opts: { force?: boolean; expectedOverride?: string | null; expectedOverrideSet?: boolean } = {},
        ): Promise<{ confirmed: boolean; modelOverride?: string | null; staleOverride?: string | null }> => {
          // Server-authoritative confirm gate. First call sends
          // `confirm: false`; if the server requires confirmation it
          // returns `{ ok: false, requiresConfirm: true }` WITHOUT
          // writing. The second call (with `force: true` from the UI
          // confirm-switch phase) sends `confirm: true` and writes.
          //
          // `expectedOverride` carries the override value the picker
          // observed at GET time so the server can CAS-detect another
          // writer (concurrent tab) between fetch and commit.
          try {
            const resp = await setTaskModel(taskId, modelNameToSet, {
              confirm: opts.force === true,
              ...(opts.expectedOverrideSet ? { expectedOverride: opts.expectedOverride ?? null } : {}),
            });
            if (resp.ok === false) {
              // Surface confirm-switch phase — the user must explicitly
              // confirm dialect change before any DB write happens.
              return { confirmed: false };
            }
          // Telemetry + UI feedback via fetching the resolved effective.
            const after = await getTaskModel(taskId);
            setSlashResults((prev) => [
              {
                id: cardId,
                result: {
                  kind: "model_switched" as const,
                  data: {
                    message: modelNameToSet
                      ? `Switched leader model to ${modelNameToSet}.`
                      : "Reset leader model to agent default.",
                    modelName: after.effective.modelName,
                    provider: after.effective.providerLabel,
                    dialect: after.effective.apiDialect,
                  },
                },
              },
              ...prev.filter((r) => r.id !== cardId),
            ].slice(0, 4));
            return { confirmed: true, modelOverride: resp.modelOverride };
          } catch (err) {
            if (err instanceof ApiError && err.code === "stale_override") {
              const rawCurrent = (err.details as { current?: unknown } | undefined)?.current;
              const stale: string | null = typeof rawCurrent === "string" ? rawCurrent : null;
              updateCard({
                phase: "error",
                errorMessage: `Another tab changed the model to '${stale ?? "(default)"}' between fetch and commit. Re-open /model and try again.`,
              });
              return { confirmed: false, staleOverride: stale };
            }
            throw err;
          }
        };

        const updateCard = (
          next: Partial<Extract<SlashResult, { kind: "model_picker" }>["data"]>,
        ) => {
          setSlashResults((prev) => prev.map((r) =>
            r.id === cardId && r.result.kind === "model_picker"
              ? { ...r, result: { ...r.result, data: { ...r.result.data, ...next } } }
              : r,
          ));
        };

        void (async () => {
          // Render loading card immediately for responsiveness.
          const loadingCard: SlashResult = {
            kind: "model_picker",
            data: {
              taskId,
              phase: "loading",
              current: null,
              options: [],
              onPick: async () => {},
              onConfirmSwitch: async () => {},
              onCancelSwitch: () => {},
            },
          };
          setSlashResults((prev) => [
            { id: cardId, result: loadingCard },
            ...prev,
          ].slice(0, 4));

          try {
            const [modelsResp, current] = await Promise.all([
              getModels(),
              getTaskModel(taskId),
            ]);

            // Build options list — only models with an API provider ref
            // configured. The picker is for *leader* model switching.
            const options = modelsResp.items
              .filter((m) => m.providerRefs?.api)
              .map((m) => ({
                modelName: m.modelName,
                providerLabel: m.providerRefs?.api ?? "",
                apiDialect: "", // filled below if we can map it
                contextWindow: m.contextWindow ?? null,
              }));

            // We don't have apiDialect on the model row; reuse the
            // effective endpoint's dialect for the currently-resolved
            // model, and leave others blank (server validates on POST
            // anyway). For richer display, the server's GET endpoint
            // would need extending — leave that as a follow-up.
            const currentEntry: { modelName: string; providerLabel: string; apiDialect: string } | null = {
              modelName: current.effective.modelName,
              providerLabel: current.effective.providerLabel,
              apiDialect: current.effective.apiDialect,
            };
            // Capture the override slot value (NOT effective model name)
            // at GET time so commitSwitch can pass it back as a CAS
            // guard. `null` is a meaningful value (= "on agent default")
            // so a concurrent tab that pinned to a model is detected.
            const observedOverride: string | null = current.override;

            const finalOptions = options.map((o) =>
              o.modelName === currentEntry.modelName
                ? { ...o, apiDialect: currentEntry.apiDialect, providerLabel: currentEntry.providerLabel }
                : o,
            );

            // If the inline arg matched a known model, skip the picker.
            if (inlineArg.length > 0) {
              const hit = finalOptions.find(
                (o) => o.modelName.toLowerCase() === lcArg,
              );
              if (!hit) {
                updateCard({ phase: "error", errorMessage: `Unknown model '${inlineArg}'. Available: ${finalOptions.map((o) => o.modelName).join(", ")}` });
                return;
              }
              // Inline path: no CAS guard — user typed the full command,
              // last-writer-wins is the natural semantics. Try to commit.
              // If dialect-warn required, swap to confirm-switch phase
              // preserving the inline pick.
              const result = await commitSwitch(hit.modelName);
              if (!result.confirmed) {
                updateCard({
                  phase: "confirm-switch",
                  pendingPick: { modelName: hit.modelName, apiDialect: hit.apiDialect },
                  current: currentEntry,
                  options: finalOptions,
                  onConfirmSwitch: async () => {
                    updateCard({ phase: "switching" });
                    await commitSwitch(hit.modelName, { force: true });
                  },
                  onCancelSwitch: () => {
                    setSlashResults((prev) => prev.filter((r) => r.id !== cardId));
                  },
                });
              }
              return;
            }

            // Build the interactive picker. CAS guard is enabled here
            // — the picker fetched current state, user selected based
            // on it, so a concurrent change is a real bug to surface.
            const pick = async (modelNameToSet: string | null) => {
              try {
                const result = await commitSwitch(modelNameToSet, {
                  expectedOverride: observedOverride,
                  expectedOverrideSet: true,
                });
                if (!result.confirmed && modelNameToSet && !result.staleOverride) {
                  const pickedOpt = finalOptions.find((o) => o.modelName === modelNameToSet);
                  updateCard({
                    phase: "confirm-switch",
                    pendingPick: {
                      modelName: modelNameToSet,
                      apiDialect: pickedOpt?.apiDialect ?? "(unknown)",
                    },
                    onConfirmSwitch: async () => {
                      updateCard({ phase: "switching" });
                      try {
                        await commitSwitch(modelNameToSet, {
                          force: true,
                          expectedOverride: observedOverride,
                          expectedOverrideSet: true,
                        });
                      } catch (err) {
                        updateCard({
                          phase: "error",
                          errorMessage: err instanceof Error ? err.message : String(err),
                        });
                      }
                    },
                    onCancelSwitch: () => {
                      setSlashResults((prev) => prev.filter((r) => r.id !== cardId));
                    },
                  });
                }
              } catch (err) {
                updateCard({
                  phase: "error",
                  errorMessage: err instanceof Error ? err.message : String(err),
                });
              }
            };

            updateCard({
              phase: "list",
              current: currentEntry,
              options: finalOptions,
              onPick: pick,
            });
          } catch (err) {
            updateCard({
              phase: "error",
              errorMessage: err instanceof Error ? err.message : String(err),
            });
          }
        })();
        return true;
      }

      // Unrecognised command — close menu + clear leading slash.
      setSlash({ kind: "closed" });
      if (inputText.startsWith("/")) {
        setValue("");
        if (textareaRef.current) {
          textareaRef.current.value = "";
          autoResize();
        }
      }
      return false;
    },
    [
      selectedTaskId,
      urlWorkspaceId,
      activeWorkspaceId,
      navigate,
      fetchTasks,
      pushSlashResult,
    ],
  );

  return (
    <div
      className="chat-input-bar chat-input-container"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      {/* Slash command results split by interactivity:
          - INTERACTIVE multi-phase flows (/model, /goal) render in one
            anchored popover panel attached to the composer, so a flow
            reads as a single continuous surface rather than a stack of
            floating notes (and morphs in place across its phases).
          - INFORMATIONAL results (status / compact / switched / errors)
            stay as the lightweight, individually-dismissable card strip.
          Both are newest-first, capped at 4, auto-dismissed after 30s or
          on next send. */}
      {(() => {
        const interactive = slashResults.filter(
          ({ result }) => result.kind === "model_picker" || result.kind === "goal_activation",
        );
        const informational = slashResults.filter(
          ({ result }) => result.kind !== "model_picker" && result.kind !== "goal_activation",
        );
        const dismiss = (id: number) => setSlashResults((prev) => prev.filter((r) => r.id !== id));
        return (
          <>
            {interactive.length > 0 && (
              <div className="slash-popover" role="group" aria-label="Slash command">
                {interactive.map(({ id, result }) => (
                  <SlashCommandCard key={id} result={result} variant="flat" onDismiss={() => dismiss(id)} />
                ))}
              </div>
            )}
            {informational.length > 0 && (
              <div style={{ marginBottom: "0.3rem" }}>
                {informational.map(({ id, result }) => (
                  <SlashCommandCard key={id} result={result} onDismiss={() => dismiss(id)} />
                ))}
              </div>
            )}
          </>
        );
      })()}
      {attachmentError ? (
        <div className="chat-input-bar__attachment-error" role="alert">
          {attachmentError}
        </div>
      ) : null}

      {slash.kind === "menu" ? (
        <SlashMenu
          filter={slash.filter}
          builtins={BUILTIN_SLASH_COMMANDS}
          builtinContext={{ selectedTaskId, showStop, isTerminal: selectedTaskIsTerminal }}
          activeIndex={slashActiveIndex}
          onHoverIndex={setSlashActiveIndex}
          onItemsChange={(items) => {
            slashItemsRef.current = items;
            // Keep the highlight in range when the filtered set shrinks.
            setSlashActiveIndex((i) => (i >= items.length ? Math.max(0, items.length - 1) : i));
          }}
          onSelectBuiltin={(b) => {
            // Canonicalize: rebuild the dispatch string from the SELECTED
            // builtin's canonical name preserving any trailing args, so a
            // partial token like "/mod" never reaches the dispatcher
            // verbatim. Delegating through the same helper keeps
            // menu-click and keyboard-select identical.
            dispatchBuiltinFromInput(b.name);
          }}
          onSelect={(p) => {
            setSlash({ kind: "args", prompt: p });
            setRenderError(null);
          }}
          onClose={() => {
            setSlash({ kind: "closed" });
            // Also clear the leading slash from the textarea so the
            // user doesn't have to manually delete it.
            if (value.trimStart().startsWith("/")) {
              setValue("");
              if (textareaRef.current) {
                textareaRef.current.value = "";
                autoResize();
              }
            }
          }}
        />
      ) : null}
      {slash.kind === "args" ? (
        <PromptArgsForm
          prompt={slash.prompt}
          externalError={renderError}
          onCancel={() => {
            setRenderError(null);
            setSlash({ kind: "menu", filter: "" });
          }}
          onSubmit={(args) => { void handlePromptSubmit(slash.prompt, args); }}
        />
      ) : null}

      <div className="chat-input-bar__shell">
        {/* Attachment chip strip lives inside the shell so it
            visually belongs to the input. Renders above the
            textarea when at least one file is staged. */}
        {attachments.length > 0 ? (
          <div className="chat-input-bar__attachments" aria-label="Staged attachments">
            {attachments.map((file, idx) => (
              <div key={`${file.name}-${idx}`} className="chat-input-bar__attachment-chip">
                {/* Image files render a real thumbnail. Doc/text files
                    use an emoji glyph instead of a broken-image — the
                    object URL preview only loads for image MIMEs. */}
                {isAllowedImage(file) ? (
                  <img
                    src={thumbnailUrls[idx]}
                    alt={file.name}
                    className="chat-input-bar__attachment-thumb"
                  />
                ) : (
                  <span
                    className="chat-input-bar__attachment-thumb chat-input-bar__attachment-thumb--icon"
                    aria-hidden="true"
                  >
                    {file.type === "application/pdf"
                      ? "📄"
                      : file.name.match(/\.(docx?|xlsx?)$/i)
                        ? "📊"
                        : "📝"}
                  </span>
                )}
                <div className="chat-input-bar__attachment-meta">
                  <span className="chat-input-bar__attachment-name" title={file.name}>
                    {file.name}
                  </span>
                  <span className="chat-input-bar__attachment-size">{formatBytes(file.size)}</span>
                </div>
                <button
                  type="button"
                  className="chat-input-bar__attachment-remove"
                  onClick={() => removeAttachment(idx)}
                  disabled={sending}
                  aria-label={`Remove ${file.name}`}
                  title="Remove attachment"
                >
                  {"×"}
                </button>
              </div>
            ))}
          </div>
        ) : null}

      <textarea
        ref={textareaRef}
        id="chat-composer-textarea"
        data-focus-target="composer"
        className="chat-input-bar__field"
        rows={1}
        placeholder="Message…"
        value={value}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        disabled={sending}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          autoResize();
          // Slash-menu trigger / filter / dismiss.
          // Open when value (after trim) starts with `/`. Filter is the
          // text after `/`. Backspacing past `/` closes the menu.
          // Mid-line `/` (e.g. URLs or regex) is correctly excluded
          // because we check `trimStart().startsWith('/')`.
          const trimmed = next.trimStart();
          if (trimmed.startsWith("/")) {
            const filter = trimmed.slice(1);
            if (slash.kind === "closed" || (slash.kind === "menu" && slash.filter !== filter)) {
              setSlash({ kind: "menu", filter });
              // Re-highlight the top match whenever the filter changes
              // so Enter always commits the most-relevant row.
              setSlashActiveIndex(0);
            }
          } else if (slash.kind === "menu") {
            setSlash({ kind: "closed" });
          }
          // Note: slash.kind === "args" is sticky — the user picked a
          // prompt; arg form stays open until they Cancel or submit.
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        aria-label="Chat message"
      />

      {/* Hidden native file input \u2014 clicking the visible attach
          button opens it. Filtering by accept= isn't a security
          guarantee (attacker can rename a file) \u2014 backend revalidates. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={[...ALLOWED_ALL_TYPES, ...ALLOWED_FILE_EXTENSIONS].join(",")}
        multiple
        style={{ display: "none" }}
        onChange={handleFilePicker}
      />

        <div className="chat-input-bar__footer">
          <div className="chat-input-bar__footer-left">
            <button
              type="button"
              className="chat-input-bar__attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={sending}
              aria-label="Attach files"
              title="Attach files (PNG/JPEG/GIF/WebP up to 10 MB · PDF/DOCX/XLSX/MD up to 10 MB)"
            >
              <span aria-hidden="true">{"\u{1F4CE}"}</span>
            </button>
            <button
              type="button"
              className={`chat-input-bar__plan-toggle${planMode ? " chat-input-bar__plan-toggle--on" : ""}`}
              onClick={togglePlanMode}
              disabled={sending}
              aria-pressed={planMode}
              aria-label={"Plan first \u2014 ask the agent to produce a plan before any edits"}
              title={"Plan first \u2014 ask the agent to produce a plan before any edits"}
            >
              <span aria-hidden="true">{"\u{1F9ED}"}</span>
              <span className="chat-input-bar__plan-toggle-label">Plan</span>
            </button>
          </div>
          <div className="chat-input-bar__footer-right">
            {/* Platform-aware modifier glyph: ⌘ on Mac, Ctrl elsewhere.
                Same getModSymbol() helper used in the Dashboard chips
                and SessionList search hint so the three surfaces never
                disagree about what the user should press. CSS hides
                the hint on touch-only devices (no physical keyboard). */}
            <span className="chat-input-bar__hint" aria-hidden="true">
              <b>{modSym} ⏎</b> send · <b>⌥ ⏎</b> newline
            </span>
            {showSendPendingNotice ? (
              <span className="chat-input-bar__pending" role="status">
                Still sending...
              </span>
            ) : null}
            {showStop ? (
              <button
                type="button"
                className="chat-input-bar__send chat-input-bar__send--stop"
                onClick={handleStop}
                aria-label="Stop the agent"
                title="Stop the agent"
              >
                {"\u25a0"}
              </button>
            ) : (
              <button
                type="button"
                className="chat-input-bar__send"
                disabled={!canSend}
                onClick={handleSend}
                aria-label="Send message"
              >
                {sending ? "\u2026" : "\u2191"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
