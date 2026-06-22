import type {
  LeaderResultBlock,
  LeaderResultContent,
  LeaderTool,
  LeaderToolUseContext,
  MessageUpdate,
  ToolUseBlock,
  LeaderPermissionResult,
  PreToolUseHookResult,
  PostToolUseHookResult,
} from "./autonomous-types";
import { findToolByName } from "./tool-registry";
import { z } from "zod";
import {
  evaluateToolCallAgainstExecutionPolicy,
  getEnforcementLevel,
  modeIsEnforcedAtLevel,
} from "../../leader-execution-policy-service";

async function runPreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  context: LeaderToolUseContext
): Promise<PreToolUseHookResult[]> {
  if (!context.preToolUseHooks?.length) return [];
  const results: PreToolUseHookResult[] = [];
  for (const hook of context.preToolUseHooks) {
    results.push(await hook(toolName, input, context));
  }
  return results;
}

async function runPostToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
  context: LeaderToolUseContext
): Promise<PostToolUseHookResult[]> {
  if (!context.postToolUseHooks?.length) return [];
  const results: PostToolUseHookResult[] = [];
  for (const hook of context.postToolUseHooks) {
    results.push(await hook(toolName, input, output, context));
  }
  return results;
}

/**
 * Execution-policy gate helper.
 *
 * Evaluates `tool` against `toolUseContext.executionPolicy` and returns an
 * object describing what to do:
 * - `{ action: "allow" }` — proceed normally.
 * - `{ action: "block", content, blocking }` — yield a blocked tool_result and
 *   return (when `blocking` is true), or emit a non-blocking observe event and
 *   continue (when `blocking` is false).
 *
 * `rawInput` is the (possibly un-parsed) tool input. For the normal path this
 * is the post-parse `input`; for the remoteExecute early path it is
 * `toolUse.input` (always a Record per the protocol).
 */
async function checkExecutionPolicyGate(
  tool: LeaderTool,
  toolUse: ToolUseBlock,
  rawInput: Record<string, unknown>,
  toolUseContext: LeaderToolUseContext,
): Promise<
  | { action: "allow" }
  | { action: "block"; content: string; blocking: boolean }
> {
  const policy = toolUseContext.executionPolicy;
  const enforcement = getEnforcementLevel(process.env as Record<string, string | undefined>);
  if (!policy || enforcement === "off") return { action: "allow" };

  // bash.isReadOnly is always false; the evaluator classifies bash by command internally.
  // For all other tools call isReadOnly if present; fall back to false (safe default).
  const toolIsReadOnly =
    tool.name === "bash"
      ? false
      : tool.isReadOnly
        ? Boolean(tool.isReadOnly(rawInput))
        : false;

  const verdict = evaluateToolCallAgainstExecutionPolicy({
    policy,
    toolName: tool.name,
    toolInput: rawInput,
    toolIsReadOnly,
    enforcement,
  });

  if (verdict.allow) {
    // Telemetry: when a mutating tool is allowed under direct_override, emit one
    // observability event so override usage is traceable. Read-only tools are
    // excluded to avoid spamming on every grep/read call.
    if (policy.mode === "direct_override" && !toolIsReadOnly) {
      await toolUseContext.recordEvent({
        type: "leader.execution_policy_override_used",
        timestamp: new Date().toISOString(),
        data: {
          toolUseId: toolUse.id,
          toolName: tool.name,
          requestId: toolUseContext.requestId,
          turnIndex: toolUseContext.turnIndex,
        },
      });
    }
    return { action: "allow" };
  }

  const blocking = modeIsEnforcedAtLevel(policy.mode, enforcement);
  await toolUseContext.recordEvent({
    type: "leader.execution_policy_blocked_tool",
    timestamp: new Date().toISOString(),
    data: {
      toolUseId: toolUse.id,
      toolName: tool.name,
      mode: policy.mode,
      reason: verdict.reason,
      nextAction: verdict.nextAction,
      blocking,
      requestId: toolUseContext.requestId,
      turnIndex: toolUseContext.turnIndex,
    },
  });

  if (blocking) {
    return {
      action: "block",
      content: `<tool_use_error>Execution policy blocked ${tool.name}.\nMode: ${policy.mode}.\nReason: ${verdict.reason}\nNext action: ${verdict.nextAction}</tool_use_error>`,
      blocking: true,
    };
  }

  // observe / non-blocking: emit the event (done above) but allow the call through.
  return { action: "allow" };
}

export async function* runToolUse(
  toolUse: ToolUseBlock,
  tools: readonly LeaderTool[],
  toolUseContext: LeaderToolUseContext
): AsyncGenerator<MessageUpdate, void> {
  const tool = findToolByName(tools, toolUse.name);

  if (!tool) {
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: `<tool_use_error>Error: No such tool available: ${toolUse.name}</tool_use_error>`,
        isError: true,
      },
    };
    return;
  }

  if (toolUseContext.abortController.signal.aborted) {
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: "<tool_use_error>Tool execution cancelled by user</tool_use_error>",
        isError: true,
      },
    };
    return;
  }

  if (tool.remoteExecute) {
    // Policy gate for remoteExecute path.
    // `toolUse.input` is used directly because the parsed `input` is not
    // available until after remoteExecute would have already fired.
    // `toolUse.input` is always a Record<string, unknown> per the protocol.
    const policyCheckRemote = await checkExecutionPolicyGate(
      tool,
      toolUse,
      toolUse.input as Record<string, unknown>,
      toolUseContext,
    );
    if (policyCheckRemote.action === "block") {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: policyCheckRemote.content,
          isError: true,
        },
      };
      return;
    }
    yield* tool.remoteExecute(toolUse, toolUseContext);
    return;
  }

  const parsedInput = tool.inputSchema.safeParse(toolUse.input);
  if (!parsedInput.success) {
    const errorMessage = formatZodError(parsedInput.error);
    // fix#1 — make the error actionable when the shape looks truncated.
    const shape = classifyValidationFailure(toolUse.input, parsedInput.error);
    let hint = "";
    if (shape === "truncated") {
      hint =
        " — this call may have been TRUNCATED before all required fields were emitted"
        + " (the most common cause is hitting the output token limit on a very large call)."
        + " Re-send a SHORTER call: keep the required fields, shorten or summarize large"
        + " optional/free-text fields (e.g. a huge `goal` or `expected_output`).";
    } else if (shape === "empty") {
      hint = " — ensure all required fields are present.";
    }
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: `<tool_use_error>InputValidationError: ${errorMessage}${hint}</tool_use_error>`,
        isError: true,
      },
    };
    return;
  }

  let processedInput = parsedInput.data;

  // Plan-mode gate. When the leader is in plan mode (PLANNING /
  // AWAITING_APPROVAL — see docs/specs/2026-04-26-plan-mode-spec.md §8),
  // any tool whose `isPlanSafe()` returns falsy is rejected with a
  // deterministic error before any side-effect can occur. Default-deny
  // — undefined `isPlanSafe` is treated as unsafe, forcing explicit
  // opt-in for every tool. Bash uses a dynamic classifier (§8.2) by
  // calling `isPlanSafe(args)` against the command string.
  if (toolUseContext.inPlanMode === true) {
    const planSafe = tool.isPlanSafe ? Boolean(tool.isPlanSafe(processedInput)) : false;
    if (!planSafe) {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `Cannot use \`${tool.name}\` in plan mode. Either exit plan mode (call exit_plan_mode) or stay read-only.`,
          isError: true,
        },
      };
      return;
    }
  }

  const preHookResults = await runPreToolUseHooks(tool.name, processedInput, toolUseContext);
  for (const result of preHookResults) {
    if (result.behavior === "deny") {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `<tool_use_error>${result.message ?? "Hook blocked tool execution"}</tool_use_error>`,
          isError: true,
        },
      };
      await toolUseContext.recordEvent({
        type: "tool.hook_blocked",
        timestamp: new Date().toISOString(),
        data: { toolUseId: toolUse.id, toolName: tool.name, hookType: "pre", reason: result.message },
      });
      return;
    }
    if (result.behavior === "modify" && result.updatedInput) {
      processedInput = result.updatedInput;
    }
  }

  if (toolUseContext.canUseTool) {
    const canUseResult = await toolUseContext.canUseTool(tool.name, processedInput);
    if (canUseResult.behavior === "deny") {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `<tool_use_error>${canUseResult.message ?? "Tool use denied"}</tool_use_error>`,
          isError: true,
        },
      };
      return;
    }
    if (canUseResult.behavior === "ask") {
      // fail-safe. Previously this branch silently
      // fell through to execute when `requestApproval` wasn't wired
      // (current default — nobody plumbs the callback). Any future
      // tool returning "ask" via canUseTool would have been
      // fail-open. We now refuse when the caller asked for approval
      // but the runtime can't gather it. Bash/MCP go through their
      // own gated path (await waitForApproval in the tool's call()
      // body), so they're unaffected.
      if (!toolUseContext.requestApproval) {
        yield {
          message: {
            type: "tool_result",
            toolUseId: toolUse.id,
            content: `<tool_use_error>${canUseResult.message ?? `Tool '${tool.name}' requires approval but no approval channel is wired.`}</tool_use_error>`,
            isError: true,
          },
        };
        return;
      }
      const approvalResult = await toolUseContext.requestApproval({
        toolName: tool.name,
        toolInput: processedInput,
        toolUseId: toolUse.id,
        message: canUseResult.message ?? `Allow tool call: ${tool.name}?`,
      });
      if (approvalResult.decision === "reject") {
        yield {
          message: {
            type: "tool_result",
            toolUseId: toolUse.id,
            content: `<tool_use_error>${approvalResult.feedback ?? "User rejected"}</tool_use_error>`,
            isError: true,
          },
        };
        return;
      }
    }
  }

  let permissionResult: LeaderPermissionResult = { behavior: "allow" };
  if (tool.checkPermissions) {
    permissionResult = await tool.checkPermissions(processedInput, toolUseContext);
  }

  if (permissionResult.behavior === "deny") {
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: `<tool_use_error>${permissionResult.message ?? "Permission denied"}</tool_use_error>`,
        isError: true,
      },
    };
    return;
  }

  if (permissionResult.behavior === "ask") {
    // 2026-05-24 fail-safe (same as above). No requestApproval
    // wired ⇒ refuse, don't fall through.
    if (!toolUseContext.requestApproval) {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `<tool_use_error>${permissionResult.message ?? `Tool '${tool.name}' requires approval but no approval channel is wired.`}</tool_use_error>`,
          isError: true,
        },
      };
      return;
    }
    const approvalResult = await toolUseContext.requestApproval({
      toolName: tool.name,
      toolInput: processedInput,
      toolUseId: toolUse.id,
      message: permissionResult.message ?? `Allow tool call: ${tool.name}?`,
    });

    if (approvalResult.decision === "reject") {
      yield {
        message: {
          type: "tool_result",
          toolUseId: toolUse.id,
          content: `<tool_use_error>${approvalResult.feedback ?? "User rejected"}</tool_use_error>`,
          isError: true,
        },
      };
      return;
    }
  }

  const input = permissionResult.updatedInput ?? processedInput;

  // Execution-policy gate (normal / non-remoteExecute path).
  // Runs after input is fully parsed and permission-resolved, so the
  // evaluator gets accurate parsed args (e.g. bash.command, edit_file.path).
  const policyCheck = await checkExecutionPolicyGate(tool, toolUse, input, toolUseContext);
  if (policyCheck.action === "block") {
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: policyCheck.content,
        isError: true,
      },
    };
    return;
  }

  const toolSafety = summarizeToolSafetyForEvent(tool, input);

  // Emit BOTH the truncated `inputSummary` (back-compat for any
  // existing consumer that already parses it) AND the structured
  // `input` (small, scrubbed shape) so frontends can render
  // first-class affordances without re-parsing a possibly-truncated
  // JSON string. spawn_teammate visualization in particular reads
  // `data.input.role` / `data.input.goal` directly.
  const summarizedInput = summarizeToolInputForEvent(input);
  await toolUseContext.recordEvent({
    type: "leader.tool_call",
    timestamp: new Date().toISOString(),
    data: {
      toolName: tool.name,
      toolUseId: toolUse.id,
      inputSummary: JSON.stringify(input).slice(0, 2_000),
      input: summarizedInput,
      toolSafety,
    },
  });

  // Step 0a. Stamp the in-flight tool_use_id onto the
  // context handed to `tool.call`. spawn_teammate reads it to emit
  // `parentToolUseId` in `leader.teammate_spawned` (and through the
  // projector envelope onto every nested teammate event). Spread, not
  // mutation — sibling tools running in parallel each get their own
  // scoped context. Nested teammates do NOT inherit this value (their
  // own loop's tool-execution stamps a fresh one per call).
  const callContext: typeof toolUseContext = {
    ...toolUseContext,
    currentToolUseId: toolUse.id,
  };

  // per-tool wall-time timeout.
  // Composite AbortController: aborts on (a) parent task cancel, or
  // (b) tool's defaultTimeoutMs deadline. Bash + any future signal-
  // aware tool stops cleanly via this signal. `Promise.race` is a
  // hard exit for tools that ignore the signal — the tool's promise
  // continues as a zombie, but we surface a timeout `tool_result`
  // to the leader instead of blocking the loop indefinitely.
  // The original hang we're protecting against: a `bash & ...` that
  // backgrounded `vite dev`, vite kept stdout fd open, bash never
  // exited, `tool.call` never resolved, leader idle for 12.5 hours.
  //
  // 2026-05-12 P1 — model override path. Honor `input.timeout` as a
  // per-call MILLISECOND override only when the tool explicitly opts
  // in via `acceptsTimeoutOverride: true`. Bash uses this to bump to
  // 15 minutes for a long build without lifting the 5-minute default
  // for every other bash call. Tool-defined ceiling (in the zod
  // `.max(...)`) is the absolute upper bound — input never bypasses
  // it.
  //
  // 2026-05-12 hotfix — the previous version read `input.timeout`
  // from EVERY tool, which collided with `request_human_input.timeout`
  // (declared in seconds) — a model that passed `timeout: 60` (seconds)
  // got a 60-ms timer and an instant abort. Opt-in flag eliminates
  // the collision at the type level.
  const inputTimeoutOverride =
    tool.acceptsTimeoutOverride
    && typeof (input as Record<string, unknown>)?.timeout === "number"
    && Number.isFinite((input as { timeout: number }).timeout)
    && (input as { timeout: number }).timeout > 0
      ? (input as { timeout: number }).timeout
      : null;
  const toolTimeoutMs = inputTimeoutOverride ?? tool.defaultTimeoutMs;
  const scopedController = new AbortController();
  const parentSignal = toolUseContext.abortController.signal;
  const onParentAbort = () => scopedController.abort(parentSignal.reason ?? "parent_cancel");
  if (parentSignal.aborted) {
    scopedController.abort(parentSignal.reason ?? "parent_cancel");
  } else {
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  if (toolTimeoutMs && toolTimeoutMs > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      scopedController.abort("tool_timeout");
    }, toolTimeoutMs);
  }
  const scopedContext: typeof callContext = {
    ...callContext,
    abortController: scopedController,
  };

  try {
    const callPromise = tool.call(input, scopedContext, (data) => {
      toolUseContext.recordEvent({
        type: "tool.progress",
        timestamp: new Date().toISOString(),
        data: { toolUseId: toolUse.id, progress: data },
      });
    });

    // Promise.race with a never-resolving timeout sentinel. The actual
    // timeout firing aborts `scopedController`; well-behaved tools
    // (bash, fetch-based) will then resolve via their signal handler.
    // For misbehaving tools we still need to bail — the sentinel
    // rejects when the controller aborts due to timeout.
    const timeoutSentinel = toolTimeoutMs && toolTimeoutMs > 0
      ? new Promise<never>((_, reject) => {
          const onAbort = () => {
            scopedController.signal.removeEventListener("abort", onAbort);
            if (scopedController.signal.reason === "tool_timeout") {
              reject(Object.assign(new Error(`tool_timeout`), { __toolTimeout: true }));
            }
            // parent_cancel: let tool.call resolve normally (it
            // observed the abort and returned an error); don't
            // double-handle here.
          };
          scopedController.signal.addEventListener("abort", onAbort);
        })
      : null;

    const result = timeoutSentinel
      ? await Promise.race([callPromise, timeoutSentinel])
      : await callPromise;

    let outputData = result.data;
    const postHookResults = await runPostToolUseHooks(tool.name, input, outputData, toolUseContext);
    for (const hookResult of postHookResults) {
      if (hookResult.modifiedOutput !== undefined) {
        outputData = hookResult.modifiedOutput;
      }
    }

    const contextUpdate = result.contextModifier?.(toolUseContext);
    // Spec §2 — when the tool returns a `LeaderResultBlock[]`, pass
    // it through unchanged so plugins can encode text + image blocks
    // natively (Anthropic) or fall back to placeholders (OpenAI-compat).
    // Otherwise stringify as before so existing tools keep working.
    const resolvedContent = isLeaderResultBlockArray(outputData)
      ? outputData
      : formatToolResult(outputData);
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: resolvedContent,
      },
      ...(contextUpdate ? { newContext: contextUpdate } : {}),
    };

    await toolUseContext.recordEvent({
      type: "leader.tool_result",
      timestamp: new Date().toISOString(),
      data: { toolUseId: toolUse.id, toolName: tool.name, isError: false, outputSummary: summarizeToolResultForEvent(resolvedContent).slice(0, 8_000) },
    });
  } catch (error) {
    // Distinguish tool-timeout from any other thrown error so the
    // model sees an actionable message ("split the work or change
    // the approach") rather than a generic exception trace.
    const isTimeout = timedOut
      || (error as { __toolTimeout?: boolean })?.__toolTimeout === true;
    const errorMessage = isTimeout
      ? `Tool '${tool.name}' timed out after ${toolTimeoutMs}ms. The tool was sent an abort signal; any spawned child process should have been SIGTERMed by now. If this is a legitimate long operation (build / test suite / large search), split it into smaller calls. If a backgrounded process is keeping the tool alive (e.g. \`cmd & ...\` in bash), use \`nohup setsid cmd >/tmp/log 2>&1 < /dev/null &\` and redirect ALL stdio so the parent shell can detach cleanly.`
      : error instanceof Error ? error.message : String(error);
    yield {
      message: {
        type: "tool_result",
        toolUseId: toolUse.id,
        content: `<tool_use_error>${errorMessage}</tool_use_error>`,
        isError: true,
      },
    };

    await toolUseContext.recordEvent({
      type: isTimeout ? "leader.tool_timeout" : "leader.tool_result",
      timestamp: new Date().toISOString(),
      data: {
        toolUseId: toolUse.id,
        toolName: tool.name,
        isError: true,
        ...(isTimeout ? { timeoutMs: toolTimeoutMs } : {}),
        outputSummary: errorMessage.slice(0, 8_000),
      },
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Produce a structured, size-bounded copy of a tool's input for the
 * `leader.tool_call` event payload. Frontends use this to render
 * first-class affordances (e.g. `spawn_teammate` shows role + goal
 * preview instead of generic JSON args). String values inside the
 * input are truncated individually so the resulting object is always
 * valid JSON — the prior `JSON.stringify(input).slice(0, 500)`
 * approach could cut mid-string and yield unparseable JSON.
 */
export function summarizeToolInputForEvent(input: unknown): unknown {
  // raised from 240 → 4000.
  // Approval-pending bash commands (rm -rf, multi-line scripts) were
  // landing in the chat UI's "Args" expand pane truncated at 240
  // chars with "…", so the user couldn't see the full command they
  // were being asked to approve. 4000 chars covers >99% of real
  // commands without bloating SSE event payloads (per-string only;
  // the parent JSON.stringify(input).slice(0, 2_000) cap downstream
  // is on the LEGACY inputSummary field which the modern projector
  // doesn't read).
  const STRING_FIELD_CAP = 4000;
  const ARRAY_LEN_CAP = 20;
  const OBJECT_KEY_CAP = 30;

  function visit(value: unknown, depth: number): unknown {
    if (depth > 4) return undefined;
    if (typeof value === "string") {
      return value.length > STRING_FIELD_CAP ? value.slice(0, STRING_FIELD_CAP - 1) + "…" : value;
    }
    if (typeof value !== "object" || value === null) return value;
    if (Array.isArray(value)) {
      const limited = value.slice(0, ARRAY_LEN_CAP).map((v) => visit(v, depth + 1));
      if (value.length > ARRAY_LEN_CAP) limited.push(`…+${value.length - ARRAY_LEN_CAP} more`);
      return limited;
    }
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, v] of Object.entries(value)) {
      if (i >= OBJECT_KEY_CAP) {
        out["__truncated"] = `…+${Object.keys(value).length - OBJECT_KEY_CAP} keys`;
        break;
      }
      out[k] = visit(v, depth + 1);
      i++;
    }
    return out;
  }

  return visit(input, 0);
}

function summarizeToolSafetyForEvent(
  tool: LeaderTool,
  input: Record<string, unknown>,
): {
  classification: "read_only" | "mutating" | "unknown";
  readOnly: boolean | null;
  planSafe: boolean | null;
} {
  let readOnly: boolean | null = null;
  try {
    readOnly = Boolean(tool.isReadOnly(input));
  } catch {
    readOnly = null;
  }

  let planSafe: boolean | null = null;
  try {
    planSafe = tool.isPlanSafe ? Boolean(tool.isPlanSafe(input)) : null;
  } catch {
    planSafe = null;
  }

  return {
    classification: readOnly === true ? "read_only" : readOnly === false ? "mutating" : "unknown",
    readOnly,
    planSafe,
  };
}

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return `${path}: ${issue.message}`;
  });
  return issues.join("; ");
}

/**
 * fix#1 — classify a tool-arg validation failure so the model gets an
 * ACTIONABLE error instead of a generic one.
 *
 * Root cause (prod incident task_1780397792126_b4pxp1): a large
 * `spawn_teammate` call (goal ~1-2k tokens) hit the OUTPUT token limit
 * mid-emission, so the streamed args reassembled to a PARTIAL object
 * (e.g. `{role, expected_output}` with the required `goal` cut off).
 * zod safeParse fails with a bare "goal required", the model can't tell
 * it was TRUNCATED, re-emits the identical huge call, re-truncates, and
 * doom-loops. (Fix #2 catches most of these at the stream level; this is
 * the belt-and-suspenders for providers whose stop signal doesn't reveal
 * the truncation, and for partial-object cases generally.)
 *
 * Hallmark of a truncated call: the input is a NON-EMPTY object that is
 * missing one or more REQUIRED fields (a JSON object cut off before its
 * later keys). We surface a "may have been truncated → re-send a SHORTER
 * call" hint in that case.
 *
 * Empty `{}` is a DIFFERENT failure (the model emitted no args at all),
 * so we don't claim truncation there — just a brief required-fields nudge.
 */
type ValidationShape = "truncated" | "empty" | "other";

function classifyValidationFailure(input: unknown, error: z.ZodError): ValidationShape {
  // Only object inputs can be "partial" in the truncation sense.
  const isObject = typeof input === "object" && input !== null && !Array.isArray(input);
  const keyCount = isObject ? Object.keys(input as Record<string, unknown>).length : 0;

  // A missing-required-field issue: zod reports an `invalid_type` (or
  // a v3 "Required") whose path points at a top-level key that is absent
  // from the supplied input. We treat "received: undefined" / "Required"
  // message text as the signal, which is dialect-stable across zod v3/v4.
  const hasMissingRequired = error.issues.some((issue) => {
    const code = issue.code;
    const msg = (issue.message ?? "").toLowerCase();
    const looksMissing =
      code === "invalid_type"
      || msg.includes("required")
      || msg.includes("received undefined");
    if (!looksMissing) return false;
    const topKey = issue.path[0];
    if (typeof topKey !== "string") return looksMissing;
    // The field is "missing" if it isn't present in the input object.
    return !isObject || !(topKey in (input as Record<string, unknown>));
  });

  if (!hasMissingRequired) return "other";
  if (keyCount === 0) return "empty";
  return "truncated";
}

function formatToolResult(data: unknown): string {
  if (typeof data === "string") return data;
  if (data === undefined || data === null) return "";
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * Spec §2 — detect a `LeaderResultBlock[]` shape from the tool's
 * raw return. We accept arrays containing only `text` or `image`
 * blocks; anything else falls back to stringification so the
 * dispatcher stays robust against malformed tool returns.
 */
function isLeaderResultBlockArray(value: unknown): value is LeaderResultBlock[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const block of value) {
    if (!block || typeof block !== "object") return false;
    const type = (block as { type?: unknown }).type;
    if (type === "text") {
      if (typeof (block as { text?: unknown }).text !== "string") return false;
    } else if (type === "image") {
      const mt = (block as { mediaType?: unknown }).mediaType;
      const data = (block as { data?: unknown }).data;
      if (typeof mt !== "string" || typeof data !== "string") return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Spec §2 — produce a string preview of a tool_result message
 * content for the `leader.tool_result` event payload (UI / replay).
 * Images collapse to `[image: <mime>]` markers so the event log
 * stays grep-able without inlining base64 blobs.
 */
function summarizeToolResultForEvent(content: LeaderResultContent): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : `[image: ${b.mediaType}]`))
    .join("\n");
}
