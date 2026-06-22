export type CliRuntime = "codex" | "claude-code" | "opencode";

export type ExternalMcpServer = {
  name: string;
  cli: CliRuntime;
  source: "shell-out" | "config-file";
  scope?: string;     // claude-code: local | user | project (or per-project path)
  type?: "stdio" | "http" | "sse" | "remote" | "local";
  command?: string[];
  url?: string;
  raw: Record<string, unknown>;
};
