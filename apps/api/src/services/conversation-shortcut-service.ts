import type { ManagerToolObservation } from "./manager-tool-service";

type ConversationalShortcutPolicy = "strict" | "broad";

const STRICT_CONVERSATIONAL_PATTERNS = [
  /^你好[。！!?\s]*$/u,
  /^您好[。！!?\s]*$/u,
  /^是[吗么嘛][。！!？?\s]*$/u,
  /^真的吗[。！!？?\s]*$/u,
  /^hello[.!?\s]*$/iu,
  /^hi[.!?\s]*$/iu,
  /^hey[.!?\s]*$/iu,
  /^really[?!. \s]*$/iu,
  /^你是谁[？?\s]*$/u,
  /^你能做什么[？?\s]*$/u,
  /^你现在能做什么[？?\s]*$/u,
  /^(你好|您好)[，,\s]*你是谁[？?\s]*$/u,
  /^who are you[?!. \s]*$/iu,
  /^what can you do[?!. \s]*$/iu,
  /^啥情况啊?[？?\s]*$/u,
  /^怎么回事啊?[？?\s]*$/u,
  /^为什么 blocked[？?\s]*$/iu,
  /^blocked 是什么意思[？?\s]*$/iu,
];

const BROAD_CONVERSATIONAL_PATTERNS = [
  ...STRICT_CONVERSATIONAL_PATTERNS,
];

function normalizeCandidate(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function isConversationalShortcutText(value: string) {
  return isConversationalShortcutTextWithPolicy(value, "broad");
}

function isConversationalShortcutTextWithPolicy(
  value: string,
  policy: ConversationalShortcutPolicy,
) {
  const candidate = normalizeCandidate(value);
  if (!candidate || candidate.length > 180) {
    return false;
  }

  const patterns =
    policy === "strict"
      ? STRICT_CONVERSATIONAL_PATTERNS
      : BROAD_CONVERSATIONAL_PATTERNS;
  return patterns.some((pattern) => pattern.test(candidate));
}

export function shouldUseConversationalShortcutTask(task: {
  title: string;
  description?: string | null;
}, options?: {
  policy?: ConversationalShortcutPolicy;
}) {
  const policy = options?.policy ?? "strict";

  return [task.title, task.description ?? ""]
    .map(normalizeCandidate)
    .filter((candidate) => candidate.length > 0)
    .some((candidate) => isConversationalShortcutTextWithPolicy(candidate, policy));
}

export function isConversationalShortcutTextWithOptions(
  value: string,
  options?: {
    policy?: ConversationalShortcutPolicy;
  },
) {
  return isConversationalShortcutTextWithPolicy(value, options?.policy ?? "broad");
}

/**
 * Build a deterministic reply for a conversational shortcut prompt.
 * `workspaceDir` is the path the agent is grounded against — pass
 * `process.cwd()` if you genuinely want server-cwd, but with Path A
 * the caller should be threading the active workspace's basePath
 * through so "current directory" reflects the project the user is
 * working on, not Magister's own install location.
 */
export function buildConversationalShortcutReply(prompt: string, workspaceDir?: string) {
  const candidate = normalizeCandidate(prompt);
  const effectiveDir = workspaceDir ?? process.cwd();

  if (
    /当前(?:的)?(工作)?(目录|文件夹)/u.test(candidate) ||
    /current (working )?directory/iu.test(candidate)
  ) {
    return `当前目录是 ${effectiveDir}。`;
  }

  if (
    /你能看(到)?哪些文件/u.test(candidate) ||
    /你能访问哪些文件/u.test(candidate) ||
    /你能读哪些文件/u.test(candidate) ||
    /what files can you (?:see|access|read)/iu.test(candidate)
  ) {
    return `我当前能读取工作区 ${effectiveDir} 里的文件，并基于这个工作区继续查看和修改项目内容；工作区之外的文件默认不会假设可用。`;
  }

  if (/你(现在)?能做什么/u.test(candidate) || /what can you do/iu.test(candidate)) {
    return "我可以直接回答简单问题、解释当前任务状态、联网搜索信息，也可以把明确的研发任务拆成内部工作项并继续调度执行。";
  }

  if (/^啥情况啊?$/u.test(candidate) || /^怎么回事啊?$/u.test(candidate)) {
    return "如果你是在问当前任务状态，我会直接告诉你当前任务在做什么、卡在哪里、下一步该怎么继续；如果你是在问某条结果异常，请把那条结果贴给我，我会解释。";
  }

  if (/^是[吗么嘛][。！!？?\s]*$/u.test(candidate) || /^真的吗[。！!？?\s]*$/u.test(candidate) || /^really[?!. \s]*$/iu.test(candidate)) {
    return "对。如果你要继续，我可以直接接着处理下一步，或者你也可以继续追问。";
  }

  if (/下一步.*(是什么意思|是啥意思)/u.test(candidate) || /what does next step mean/iu.test(candidate)) {
    return "这里的“下一步”是 Leader 建议的下一动作。对纯对话任务，它表示你可以继续追问，或者直接再给我一个具体任务，不是要求你去排障。";
  }

  if (/(^为什么 blocked$)|(blocked|阻塞|任务链路已阻塞).*(是什么意思|是啥意思)?/iu.test(candidate)) {
    return "这里的“阻塞”表示 Leader 判断当前链路暂时不能继续推进，常见原因是缺输入、缺配置，或者某个内部工作项失败，需要补充信息或修复后再继续。";
  }

  if (/你是谁/u.test(candidate) || /who are you/iu.test(candidate)) {
    return "我是 Magister。负责接收任务、调度 work items，并通过飞书和桌面控制台回报进度。";
  }

  if (/^(你好|您好|hello|hi|hey)/iu.test(candidate)) {
    return "你好，我是 Magister。你可以直接给我一个任务，我会创建并调度执行链。";
  }

  if (/^什么是/u.test(candidate) || /^what is /iu.test(candidate)) {
    return "这是一个对话型请求。我可以继续解释，也可以直接帮你创建和调度一个具体任务。";
  }

  return "已收到。这是一条对话型请求，你可以继续追问，或者直接给我一个具体任务。";
}

export function getManagerGroundingRepairHint(task: {
  title: string;
  description?: string | null;
}) {
  return getManagerGroundingRequirement(task)?.message ?? null;
}

export function getManagerGroundingRequirement(task: {
  title: string;
  description?: string | null;
}) {
  const candidates = [task.title, task.description ?? ""]
    .map(normalizeCandidate)
    .filter((candidate) => candidate.length > 0);

  if (
    candidates.some(
      (candidate) =>
        /当前(?:的)?(工作)?(目录|文件夹)/u.test(candidate) ||
        /current (working )?directory/iu.test(candidate),
    )
  ) {
    return {
      message:
        "This asks for the current working directory. Call the relevant base tool before answering. Use bash with `pwd` if needed.",
      forcedToolCall: {
        toolName: "bash",
        arguments: {
          command: "pwd",
        },
      },
    };
  }

  if (
    candidates.some(
      (candidate) =>
        /你能看(到)?哪些文件/u.test(candidate) ||
        /你能访问哪些文件/u.test(candidate) ||
        /你能读哪些文件/u.test(candidate) ||
        /what files can you (?:see|access|read)/iu.test(candidate),
    )
  ) {
    return {
      message:
        "This asks what files are visible in the workspace. Call the relevant base tool before answering. Use list_dir if needed.",
      forcedToolCall: {
        toolName: "list_dir",
        arguments: {
          path: ".",
        },
      },
    };
  }

  return null;
}

export function coerceGroundedManagerReply(input: {
  task: {
    title: string;
    description?: string | null;
  };
  observations: ManagerToolObservation[];
  reply: string | null;
}) {
  const requirement = getManagerGroundingRequirement(input.task);
  if (!requirement || input.observations.length === 0) {
    return null;
  }

  if (
    requirement.forcedToolCall.toolName === "bash" &&
    requirement.forcedToolCall.arguments.command === "pwd"
  ) {
    const observation = input.observations.find(
      (candidate) =>
        candidate.toolName === "bash" &&
        candidate.ok &&
        typeof (candidate.result as { stdout?: unknown } | undefined)?.stdout === "string" &&
        String((candidate.result as { stdout?: string }).stdout).trim().length > 0,
    );
    const observedPath = observation
      ? String((observation.result as { stdout?: string }).stdout).trim()
      : null;
    if (!observedPath) {
      return null;
    }
    if (input.reply?.includes(observedPath)) {
      return null;
    }
    return `当前工作目录是 ${observedPath}。`;
  }

  if (requirement.forcedToolCall.toolName === "list_dir") {
    const observation = input.observations.find(
      (candidate) =>
        candidate.toolName === "list_dir" &&
        candidate.ok &&
        Array.isArray((candidate.result as { entries?: unknown } | undefined)?.entries),
    );
    if (!observation) {
      return null;
    }
    const result = observation.result as {
      path?: string;
      entries?: Array<{ name?: string }>;
    };
    const entries = (result.entries ?? [])
      .map((entry) => (typeof entry.name === "string" ? entry.name : ""))
      .filter((name) => name.length > 0);
    const visibleEntries = entries.filter((name) => !name.startsWith("."));
    const previewEntries = (visibleEntries.length > 0 ? visibleEntries : entries).slice(0, 5);
    const preview = previewEntries.join("、");
    const pathLabel = result.path && result.path !== "." ? result.path : "当前工作区";
    if (preview.length === 0) {
      return `我当前可以查看 ${pathLabel} 下的文件和目录。`;
    }
    return `我当前可以查看 ${pathLabel} 下的文件和目录，例如：${preview}。`;
  }

  return null;
}
