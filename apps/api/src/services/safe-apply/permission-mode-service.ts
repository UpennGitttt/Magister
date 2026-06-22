import type { PermissionMode, RuntimeSource } from "./safe-apply-types";

type SandboxMode = "read-only" | "workspace-write" | "danger-full-access" | null;

export type DerivePermissionModeInput = {
  runtimeSource: RuntimeSource;
  argv: string[];
  sandboxMode: SandboxMode;
  envPermissionHints: string[];
  hasInteractiveApprovalChannel?: boolean;
};

export type PermissionModeResult = {
  permissionMode: PermissionMode;
  permissionSignals: string[];
};

function hasArg(argv: string[], flag: string) {
  return argv.includes(flag);
}

function argValue(argv: string[], flag: string) {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  return value && !value.startsWith("-") ? value : null;
}

function firstArg(argv: string[]) {
  return argv[0]?.trim().toLowerCase() ?? "";
}

function hasClaudePrintPrompt(argv: string[]) {
  return hasArg(argv, "-p") || hasArg(argv, "--print");
}

function hasPermissionOverrideHint(hints: string[]) {
  return hints.some((hint) => {
    const normalized = hint.trim().toUpperCase();
    return normalized === "OPENCODE_PERMISSION" || normalized.includes("PERMISSION");
  });
}

export function derivePermissionMode(input: DerivePermissionModeInput): PermissionModeResult {
  const signals: string[] = [];

  for (const hint of input.envPermissionHints) {
    const normalized = hint.trim();
    if (normalized.length === 0) continue;
    if (normalized === "IS_SANDBOX" || normalized.toUpperCase().includes("PERMISSION")) {
      signals.push(`env:${normalized}`);
    }
  }

  if (hasPermissionOverrideHint(input.envPermissionHints)) {
    return {
      permissionMode: "bypassed",
      permissionSignals: signals,
    };
  }

  if (input.sandboxMode === "danger-full-access") {
    return {
      permissionMode: "bypassed",
      permissionSignals: [...signals, "sandbox:danger-full-access"],
    };
  }

  if (input.runtimeSource === "ucm") {
    return {
      permissionMode: "interactive",
      permissionSignals: [...signals, "runtime:ucm"],
    };
  }

  if (input.runtimeSource === "codex") {
    if (hasArg(input.argv, "--dangerously-bypass-approvals-and-sandbox")) {
      return {
        permissionMode: "bypassed",
        permissionSignals: [...signals, "argv:--dangerously-bypass-approvals-and-sandbox"],
      };
    }
    if (hasArg(input.argv, "--full-auto")) {
      return {
        permissionMode: "headless",
        permissionSignals: [...signals, "argv:--full-auto"],
      };
    }
    if (firstArg(input.argv) === "exec" && input.hasInteractiveApprovalChannel !== true) {
      return {
        permissionMode: "headless",
        permissionSignals: [...signals, "argv:exec", "approval:non-interactive"],
      };
    }
  }

  if (input.runtimeSource === "claude-code") {
    const permissionMode = argValue(input.argv, "--permission-mode");
    if (permissionMode === "bypassPermissions") {
      return {
        permissionMode: "bypassed",
        permissionSignals: [...signals, "argv:--permission-mode=bypassPermissions"],
      };
    }
    if (hasArg(input.argv, "--dangerously-skip-permissions")) {
      return {
        permissionMode: "bypassed",
        permissionSignals: [...signals, "argv:--dangerously-skip-permissions"],
      };
    }
    if (
      input.envPermissionHints.includes("IS_SANDBOX") &&
      input.hasInteractiveApprovalChannel !== true
    ) {
      return {
        permissionMode: "bypassed",
        permissionSignals: [...signals, "env:IS_SANDBOX", "approval:non-interactive"],
      };
    }
    if (hasClaudePrintPrompt(input.argv) && input.hasInteractiveApprovalChannel !== true) {
      return {
        permissionMode: "headless",
        permissionSignals: [
          ...signals,
          hasArg(input.argv, "-p") ? "argv:-p" : "argv:--print",
          ...(permissionMode ? [`argv:--permission-mode=${permissionMode}`] : []),
          "approval:non-interactive",
        ],
      };
    }
  }

  if (input.runtimeSource === "opencode") {
    if (hasArg(input.argv, "--dangerously-skip-permissions")) {
      return {
        permissionMode: "bypassed",
        permissionSignals: [...signals, "argv:--dangerously-skip-permissions"],
      };
    }
    if (firstArg(input.argv) === "run") {
      return {
        permissionMode: "headless",
        permissionSignals: [...signals, "argv:run"],
      };
    }
  }

  return {
    permissionMode: "unknown",
    permissionSignals: [...signals, `runtime:${input.runtimeSource}`],
  };
}

export function extractPermissionRelevantArgvFlags(argv: string[]) {
  const result: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (i === 0 && (arg === "exec" || arg === "run")) {
      result.push(arg);
      continue;
    }
    if (
      arg === "--full-auto" ||
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--dangerously-skip-permissions" ||
      arg === "-p" ||
      arg === "--print"
    ) {
      result.push(arg);
      continue;
    }
    if (arg === "--permission-mode") {
      result.push(arg);
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        result.push(argv[i + 1]!);
        i += 1;
      }
      continue;
    }
    if (arg === "--sandbox") {
      result.push(arg);
      if (argv[i + 1] && !argv[i + 1]!.startsWith("-")) {
        result.push(argv[i + 1]!);
        i += 1;
      }
    }
  }
  return result;
}
