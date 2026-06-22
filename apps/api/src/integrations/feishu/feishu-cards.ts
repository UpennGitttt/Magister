/**
 * Feishu card JSON builders. Pure functions, no I/O, no module state.
 * All cards use schema 2.0 (`tag: "markdown"` etc) for proper markdown
 * rendering. Legacy v1.0 lark_md is NOT used here — the audit
 * established that schema 2.0 supports fenced code, headers, lists,
 * tables that lark_md mangles.
 *
 * Replaces the scattered card-building code that used to live in:
 *   - feishu-streaming-projector.ts (initial streaming card)
 *   - feishu-approval-outbound-service.ts (approval pending/resolved)
 *   - deliver-feishu-reply-service.ts (notification card)
 *   - streaming-card.ts (default initial card)
 *
 * Two card families:
 *   1. **Streaming card** (CardKit) — created via `POST /cardkit/v1/cards`
 *      with `streaming_mode: true`, updated via element-content PATCH.
 *      Built by `buildStreamingCardInitial`.
 *   2. **Action card** (regular IM interactive) — sent via
 *      `sendCardMessage`. Buttons fire `card.action.trigger`. Used for
 *      approvals + resolved-state replacements + failure notifications.
 *      Built by `buildApprovalCard` / `buildApprovalResolvedCard` /
 *      `buildFailureCard`.
 */

export type StreamingToolEntry = {
  toolUseId: string;
  toolName: string;
  argsBlock: string | null;
  resultLine: string | null;
};

export type StreamingState = {
  /** Tool calls in firing order. */
  tools: readonly StreamingToolEntry[];
  /** Accumulated final-answer text (no formatting applied yet). */
  answer: string;
  /** Optional status footer line (e.g. "✅ done", "❌ failed"). */
  footer?: string | undefined;
};

const CONTENT_ELEMENT_ID = "content";

export type CardSchemaV2 = {
  schema: "2.0";
  config: object;
  header?: object;
  body: { elements: object[] };
};

/**
 * Initial streaming card body. Declares a single `content` markdown
 * element that subsequent PATCHes mutate. Uses a single element with
 * full-snapshot updates; the server animates the diff via
 * streaming_mode.
 *
 * Audit drift fix: previous version declared `body` + `footer_sep` +
 * `footer` elements. The `footer` was static "working" forever and
 * `footer_sep` had a dash in the element_id which Feishu rejected.
 * Now there's just one element, end of story.
 */
export function buildStreamingCardInitial(opts: {
  title?: string;
  summary?: string;
}): CardSchemaV2 {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: opts.summary ?? "[Working…]" },
      // Print 1 char every 50ms — Feishu animates incoming content
      // with a typewriter effect at this rate when streaming_mode is
      // on. Set conservatively; the actual PATCH rate is throttled
      // separately in feishu-chat-session.ts.
      streaming_config: {
        print_frequency_ms: { default: 50 },
        print_step: { default: 1 },
      },
    },
    header: {
      title: { tag: "plain_text", content: opts.title ?? "🧠 Leader" },
      template: "blue",
    },
    body: {
      elements: [
        {
          tag: "markdown",
          element_id: CONTENT_ELEMENT_ID,
          content: "⏳ Thinking…",
        },
      ],
    },
  };
}

/** The element id the session should PATCH for streaming content. */
export const STREAMING_CONTENT_ELEMENT = CONTENT_ELEMENT_ID;

export const ANSWER_ELEMENT = "answer";
export const TOOLS_PANEL_ELEMENT = "tools_panel";
export const TOOLS_BODY_ELEMENT = "tools_body";

function buildToolsPanel(content: string): object {
  return {
    tag: "collapsible_panel",
    element_id: TOOLS_PANEL_ELEMENT,
    expanded: false,
    header: { title: { tag: "markdown", content: "🛠 工具活动" } },
    elements: [{ tag: "markdown", element_id: TOOLS_BODY_ELEMENT, content }],
  };
}

/**
 * Initial single-turn card: header + collapsible tools panel
 * (collapsed) + answer markdown. Streaming tuned to ~130 chars/s
 * (print_step 4 @ 30ms) — the previous 1@50ms (20 chars/s) felt
 * laggy across the Pacific.
 */
export function buildSingleTurnCardInitial(opts: {
  title?: string;
  summary?: string;
}): CardSchemaV2 {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: opts.summary ?? "[Working…]" },
      streaming_config: {
        print_frequency_ms: { default: 30 },
        print_step: { default: 4 },
      },
    },
    header: {
      title: { tag: "plain_text", content: opts.title ?? "🧠 Leader" },
      template: "blue",
    },
    body: {
      elements: [
        buildToolsPanel("（暂无）"),
        { tag: "markdown", element_id: ANSWER_ELEMENT, content: "⏳ Thinking…" },
      ],
    },
  };
}

export type ToolLine = {
  toolUseId: string;
  icon: string;
  name: string;
  argsInline: string | null;
  resultInline: string | null;
};
export type MediaItem =
  | { kind: "image"; imageKey: string; filename: string; caption?: string }
  | { kind: "file"; filename: string; caption?: string };
export type TurnState = {
  answer: string;
  tools: readonly ToolLine[];
  media: readonly MediaItem[];
};

export function renderAnswerBody(state: TurnState): string {
  return state.answer.length > 0 ? state.answer : "⏳ Thinking…";
}

export function buildFinalCard(input: {
  state: TurnState;
  verboseLevel: "off" | "low" | "high";
  footer?: string;
  template?: "blue" | "green" | "red" | "grey";
}): CardSchemaV2 {
  const { state, verboseLevel } = input;
  const answerWithFooter = input.footer
    ? `${renderAnswerBody(state)}\n\n*${input.footer}*`
    : renderAnswerBody(state);
  const elements: object[] = [];
  if (verboseLevel !== "off" && state.tools.length > 0) {
    elements.push(buildToolsPanel(renderToolsBody(state, verboseLevel)));
  }
  elements.push({ tag: "markdown", element_id: ANSWER_ELEMENT, content: answerWithFooter });
  for (const m of state.media) {
    if (m.kind === "image") {
      elements.push({
        tag: "img",
        img_key: m.imageKey,
        alt: { tag: "plain_text", content: m.caption ?? m.filename },
      });
    } else {
      elements.push({
        tag: "markdown",
        content: `📎 ${m.caption ? `${m.caption} — ` : ""}\`${m.filename}\``,
      });
    }
  }
  return {
    schema: "2.0",
    config: { streaming_mode: false, summary: { content: input.footer ?? "Done" } },
    header: {
      title: { tag: "plain_text", content: "🧠 Leader" },
      template: input.template ?? "blue",
    },
    body: { elements },
  };
}

export function renderToolsBody(
  state: TurnState,
  verboseLevel: "off" | "low" | "high",
): string {
  if (verboseLevel === "off" || state.tools.length === 0) return "（暂无）";
  const lines: string[] = [`**${state.tools.length} 个工具**`, ""];
  for (const t of state.tools) {
    lines.push(t.argsInline ? `${t.icon} \`${t.name}\` · ${t.argsInline}` : `${t.icon} \`${t.name}\``);
    if (verboseLevel === "high" && t.resultInline) {
      lines.push(`   ↳ ${t.resultInline}`);
    }
  }
  return lines.join("\n");
}

const TOOL_ICONS: Record<string, string> = {
  bash: "🔧",
  read_file: "📖",
  write_file: "✍️",
  edit_file: "✏️",
  list_dir: "📁",
  grep: "🔍",
  web_search: "🌐",
  web_fetch: "🌐",
  spawn_teammate: "👥",
  git_commit: "📝",
  git_create_branch: "🌿",
  request_human_input: "❓",
};

// Exported so feishu-chat-session can build ToolLine entries for the tools panel.
export function toolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name]!;
  if (name.startsWith("mcp__")) return "🔌";
  return "•";
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Format tool args for inline display. Returns markdown that may
 * include schema 2.0 fenced code blocks (which DO render in schema
 * 2.0 cards, unlike lark_md). Caller should embed in the renderStreamingBody
 * output as-is.
 *
 * Verbose level intentionally NOT consulted here — projector decides
 * whether to call this at all based on the level.
 */
export function formatToolArgs(toolName: string, args: Record<string, unknown>): string | null {
  const n = toolName.toLowerCase();
  if (n === "bash") {
    const cmd = typeof args.command === "string" ? args.command : "";
    if (!cmd) return null;
    return "```bash\n" + truncate(cmd, 800) + "\n```";
  }
  if (n === "read_file") {
    const path = typeof args.path === "string" ? args.path : "?";
    const start = typeof args.startLine === "number" ? args.startLine : null;
    const end = typeof args.endLine === "number" ? args.endLine : null;
    if (start && end) return `\`${path}\` (L${start}–L${end})`;
    if (start) return `\`${path}\` (L${start}–)`;
    return `\`${path}\``;
  }
  if (n === "write_file" || n === "edit_file") {
    const path = typeof args.path === "string" ? args.path : null;
    return path ? `\`${path}\`` : null;
  }
  if (n === "list_dir") {
    return typeof args.path === "string" ? `\`${args.path}\`` : null;
  }
  if (n === "grep") {
    const q = typeof args.query === "string" ? args.query : typeof args.pattern === "string" ? args.pattern : "";
    const p = typeof args.path === "string" ? args.path : "";
    if (!q) return null;
    const qt = truncate(q, 240);
    return p ? `\`${qt}\` in \`${p}\`` : `\`${qt}\``;
  }
  if (n === "web_search") {
    const q = typeof args.query === "string" ? args.query : "";
    return q ? truncate(q, 240) : null;
  }
  if (n === "web_fetch") {
    if (typeof args.url === "string") {
      try {
        const u = new URL(args.url);
        return `\`${u.host}${truncate(u.pathname + u.search, 80)}\``;
      } catch {
        return truncate(args.url, 200);
      }
    }
    return null;
  }
  if (n === "spawn_teammate") {
    const role = typeof args.role === "string" ? args.role : "?";
    const task = typeof args.task === "string" ? args.task : "";
    return `**${role}** · ${truncate(task, 300)}`;
  }
  if (n === "git_commit") {
    const msg = typeof args.message === "string" ? args.message : "";
    return msg ? truncate(msg, 200) : null;
  }
  if (n === "request_human_input") {
    const q = typeof args.question === "string" ? args.question : "";
    return q ? truncate(q, 500) : null;
  }
  if (n.startsWith("mcp__")) {
    const entries = Object.entries(args).slice(0, 6);
    if (entries.length === 0) return null;
    return entries
      .map(([k, v]) => `**${k}**: ${truncate(stringifyArgValue(v), 200)}`)
      .join("  ·  ");
  }
  const keys = Object.keys(args).slice(0, 2);
  if (keys.length === 0) return null;
  return keys
    .map((k) => `${k}=${truncate(stringifyArgValue(args[k]), 40)}`)
    .join(" · ");
}

function stringifyArgValue(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Format a tool result preview. Strings shown first 3 lines + "… N more
 * lines". Objects: tool-specific shapes (read returns bytes, bash
 * returns exit code + stdout, etc).
 */
export function formatToolResult(toolName: string, result: unknown): string | null {
  const n = toolName.toLowerCase();
  if (result == null) return null;
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (trimmed.length === 0) return "(empty)";
    const lines = trimmed.split("\n");
    if (lines.length === 1) return truncate(lines[0]!, 400);
    const head = lines.slice(0, 3).map((l) => truncate(l, 200)).join("\n");
    return head + `\n… ${lines.length - 3} more line${lines.length - 3 === 1 ? "" : "s"}`;
  }
  if (typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (n === "bash") {
      const ec = obj.exit_code ?? obj.exitCode;
      const out = typeof obj.stdout === "string" ? (obj.stdout.split("\n")[0] ?? "").trim() : "";
      const parts: string[] = [];
      if (ec !== undefined) parts.push(`exit ${ec}`);
      if (out) parts.push(truncate(out, 200));
      return parts.length ? parts.join(" · ") : "done";
    }
    if (n === "read_file") {
      const bytes = obj.bytes ?? obj.size;
      return bytes !== undefined ? `read ${bytes} bytes` : "done";
    }
    if (n === "write_file") {
      const bytes = obj.bytes ?? obj.size;
      return bytes !== undefined ? `wrote ${bytes} bytes` : "done";
    }
    if (n === "edit_file") {
      const occ = obj.occurrences ?? obj.replaced;
      if (occ === 0) return "not found";
      if (occ !== undefined) return `replaced ${occ}`;
      return "done";
    }
    if (n === "list_dir") {
      const entries = Array.isArray(obj.entries) ? obj.entries.length : obj.count;
      return entries !== undefined ? `${entries} entries` : "done";
    }
    if (n === "grep") {
      const matches = obj.matchCount ?? (Array.isArray(obj.matches) ? obj.matches.length : obj.count);
      const files = obj.fileCount ?? (Array.isArray(obj.files) ? obj.files.length : undefined);
      if (matches !== undefined && files !== undefined) return `${matches} matches in ${files} files`;
      if (matches !== undefined) return `${matches} matches`;
      return "done";
    }
    if (n === "web_search") {
      const results = Array.isArray(obj.results) ? obj.results : null;
      if (results && results.length > 0) {
        const first = results[0] as Record<string, unknown> | undefined;
        const title = first && typeof first.title === "string" ? first.title : "";
        return title ? `${results.length} results · ${truncate(title, 60)}` : `${results.length} results`;
      }
      return "0 results";
    }
    if (n === "spawn_teammate") {
      const runId = obj.runId ?? obj.teammateRunId;
      return runId ? `spawned ${String(runId).slice(-8)}` : "spawned";
    }
    if (typeof obj.error === "string") return `error: ${truncate(obj.error, 200)}`;
  }
  return "done";
}

/**
 * Render the streaming card body markdown from state. Pure function;
 * deterministic given the same input. Schema 2.0 markdown — supports
 * `**bold**`, `*italic*`, ` ```fenced``` `, headers, lists, tables,
 * `\`inline\``, links.
 *
 * The streaming card now carries ONLY the model's answer text. Tool
 * calls and tool results are surfaced as standalone plain-text messages
 * via `formatToolCallLine` / `formatToolResultLine` so they don't
 * compete with the streaming answer for card real estate.
 *
 * The `tools` field on `StreamingState` is retained for type stability
 * (downstream may pass an empty array) but is intentionally ignored.
 */
export function renderStreamingBody(state: StreamingState): string {
  if (state.answer) return state.answer;
  return "⏳ Thinking…";
}

/**
 * Format a tool call as a single-line plain-text message for the chat.
 * Returns null when there's nothing meaningful to display (e.g., no
 * recognizable args). The string is sent as-is via `sendTextMessage`.
 */
export function formatToolCallLine(toolName: string, args: Record<string, unknown>): string {
  const icon = toolIcon(toolName);
  const argsLine = formatToolArgsInline(toolName, args);
  return argsLine ? `${icon} ${toolName} · ${argsLine}` : `${icon} ${toolName}`;
}

/**
 * Format a tool result as a single-line plain-text message. Short and
 * scannable — full results live in the leader trace, not the chat.
 */
export function formatToolResultLine(toolName: string, result: unknown): string | null {
  const summary = formatToolResult(toolName, result);
  if (!summary) return null;
  // Collapse multi-line summaries onto a single line for the chat
  // bubble — Feishu text messages render newlines but the brief result
  // line is for skim, not depth.
  const flat = summary.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return `   ↳ ${truncate(flat, 240)}`;
}

// Exported so feishu-chat-session can build ToolLine entries for the tools panel.
/**
 * Inline form of formatToolArgs — same dispatch table, but strips
 * fenced-code-block wrappers so the result fits on one chat line.
 */
export function formatToolArgsInline(toolName: string, args: Record<string, unknown>): string | null {
  const block = formatToolArgs(toolName, args);
  if (!block) return null;
  // Strip ```lang\n ... \n``` wrappers (bash uses them for multi-line)
  const fenceMatch = block.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fenceMatch && fenceMatch[1]) {
    return truncate(fenceMatch[1].replace(/\s+/g, " ").trim(), 240);
  }
  return truncate(block.replace(/\s+/g, " ").trim(), 240);
}

/**
 * Build an approval card.
 *
 * v1.0 card format on purpose: schema 2.0 buttons use `behaviors:[{
 * type:"callback", value:{}}]` whereas v1.0 uses top-level `value:{}`.
 * Mixing schema 2.0 with v1.0 button shape is what triggered Feishu
 * to silently drop click events earlier in the saga. v1.0 +
 * `value:{envelope:"<json>"}` is the form the gateway normalizer +
 * envelope decoder both already understand — verified end-to-end.
 *
 * v1.0 still supports lark_md markdown subset; we use `tag:"div"` +
 * `tag:"lark_md"` for body so basic formatting (bold, italic, inline
 * code, code blocks via triple-backtick) renders. This card doesn't
 * need fenced-code or tables (the body is just "tool name + command
 * + reason"), so lark_md's limitations don't bite.
 */
export function buildApprovalCard(input: {
  envelope: { approve: object; reject: object };
  toolName: string;
  bodyMarkdown: string;
  isQuestion?: boolean;
  ttlMinutes: number;
  taskIdShort: string;
}): object {
  const isQuestion = input.isQuestion === true;
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: isQuestion ? "❓ Input requested" : "🔒 Approval needed",
      },
      template: isQuestion ? "indigo" : "orange",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: input.bodyMarkdown },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: isQuestion ? "✅ Continue" : "✅ Approve",
            },
            type: "primary",
            value: { envelope: JSON.stringify(input.envelope.approve) },
          },
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: isQuestion ? "🛑 Stop" : "❌ Reject",
            },
            type: "danger",
            value: { envelope: JSON.stringify(input.envelope.reject) },
          },
        ],
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `*task #${input.taskIdShort} · expires in ${input.ttlMinutes}m*`,
        },
      },
    ],
  };
}

/**
 * Replacement card returned by the WS handler to swap the original
 * approval card in-place after a click. v1.0 (matches `buildApprovalCard`
 * so the swap looks visually consistent).
 */
export function buildApprovalResolvedCard(input: {
  state: "approved" | "rejected" | "expired";
  resolvedBy: string;
  toolName: string;
  bodyMarkdown: string;
  resolvedAtMs: number;
}): object {
  const headerText =
    input.state === "approved"
      ? "✅ Approved"
      : input.state === "rejected"
        ? "❌ Rejected"
        : "⏱ Expired";
  const template =
    input.state === "approved" ? "green" : input.state === "rejected" ? "red" : "grey";
  const time = new Date(input.resolvedAtMs).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: headerText },
      template,
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: input.bodyMarkdown },
      },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `*${headerText} by ${input.resolvedBy} · ${time}*`,
        },
      },
    ],
  };
}

/**
 * Build a one-shot failure card (used when a task fails BEFORE any
 * streaming card was opened — e.g. crash during creation, or
 * verboseLevel=off task).
 */
export function buildFailureCard(input: {
  kind: "failed" | "cancelled";
  taskIdShort: string;
  reason: string | null;
}): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: input.kind === "failed" ? "❌ Task failed" : "⏹ Task cancelled",
      },
      template: input.kind === "failed" ? "red" : "grey",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**task #${input.taskIdShort}**`,
            input.reason ? `Reason: ${input.reason}` : "Reason: unspecified",
          ].join("\n\n"),
        },
      },
    ],
  };
}

/**
 * Build a CardKit response payload for the WS card.action.trigger
 * handler. Wraps the replacement card in `{ type: "raw", data: ... }`
 * which is the canonical schema 2.0 callback-response shape (audit
 * established that bare `{ card: ... }` triggers Feishu error 200672).
 *
 * `toast` is the small ack popup the user sees in addition to the
 * card update.
 */
export function buildCallbackResponse(input: {
  replacementCard: object;
  toastType: "success" | "error" | "warning" | "info";
  toastContent: string;
}): object {
  return {
    toast: {
      type: input.toastType,
      content: input.toastContent,
    },
    card: {
      type: "raw",
      data: input.replacementCard,
    },
  };
}

/**
 * Build the body markdown for an approval card. Pulled out as a
 * standalone helper because both the pending and resolved cards
 * share the same body shape.
 */
export function buildApprovalBodyMarkdown(input: {
  toolName: string;
  command: string | null;
  reason: string | null;
  summary: string;
  isQuestion: boolean;
}): string {
  const lines: string[] = [];
  if (input.isQuestion) {
    lines.push("**❓ Leader needs input**");
    if (input.summary) {
      lines.push("");
      lines.push(input.summary);
    }
    return lines.join("\n");
  }
  lines.push(`**${input.toolName}**`);
  if (input.command) {
    lines.push("");
    lines.push("```");
    lines.push(input.command);
    lines.push("```");
  }
  if (input.reason) {
    lines.push("");
    lines.push(`**Reason:** ${input.reason}`);
  }
  if (input.summary && input.summary !== input.command) {
    lines.push("");
    lines.push(input.summary);
  }
  return lines.join("\n");
}
