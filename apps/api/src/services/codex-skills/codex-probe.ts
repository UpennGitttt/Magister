import { spawn } from "node:child_process";

/**
 * Probe `codex debug prompt-input` to get the EXACT list of skills
 * codex's loader will inject into the model's system prompt. Two
 * parse layers:
 *
 *   1. Outer JSON — `codex debug prompt-input` emits a structured
 *      array of message blocks. We pick the developer-role message
 *      and find the input_text whose body starts with
 *      `<skills_instructions>`. This part is stable as long as
 *      codex emits valid JSON.
 *
 *   2. Inner text — inside that block, the skill list is a markdown
 *      bullet section under `### Available skills`. Each entry has
 *      shape `- <name>: <description> (file: <absolute-path>)`.
 *      This format is undocumented and subject to change between
 *      codex versions; the orchestrator (cli-skill-discovery)
 *      treats any parse failure as a soft fail and falls back to
 *      directory scanning.
 *
 * The command is local-only — no API calls, no network, no cost.
 * Cold-start cost is ~3.6 s on this box (codex CLI process
 * initialization + prompt rendering); the orchestrator caches
 * results for 5 minutes to amortize.
 */

export type CodexSkillEntry = {
  /** Canonical name codex uses, e.g. "imagegen" or "superpowers:brainstorming". */
  name: string;
  description: string;
  /** Absolute path to the SKILL.md, taken verbatim from codex's output. */
  filePath: string;
};

export type CodexProbeResult =
  | { ok: true; skills: CodexSkillEntry[]; codexVersion?: string }
  | { ok: false; reason: string };

/** Spawn `codex debug prompt-input` with a no-op user prompt and
 *  capture stdout. Times out after `timeoutMs` ms (default 6 s).
 *
 *  We intentionally pass a minimal prompt argument (a single
 *  underscore) — the value doesn't affect the rendered system-
 *  prompt portion that contains skills. */
async function spawnCodexDebug(opts: { timeoutMs: number }): Promise<
  | { ok: true; stdout: string }
  | { ok: false; reason: string }
> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

    function clearTimers() {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (sigkillTimer) { clearTimeout(sigkillTimer); sigkillTimer = null; }
    }
    const settle = (result: { ok: true; stdout: string } | { ok: false; reason: string }) => {
      if (settled) return;
      settled = true;
      // Kimi review I9 — clear BOTH timers on settle; previously the
      // SIGKILL backstop kept ticking after a late error event because
      // it was only cleared from the close handler.
      clearTimers();
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["debug", "prompt-input", "_"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      settle({ ok: false, reason: `spawn failed: ${(err as Error).message}` });
      return;
    }

    killTimer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      // SIGKILL backstop — codex with a hung tokio runtime can ignore SIGTERM
      sigkillTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 1500);
      settle({ ok: false, reason: `timed out after ${opts.timeoutMs}ms` });
    }, opts.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      // ENOENT = codex CLI not on PATH. Treat as a soft fail.
      settle({ ok: false, reason: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        const trimmed = stderr.trim().slice(0, 200);
        settle({ ok: false, reason: `exit ${code}${trimmed ? ` — ${trimmed}` : ""}` });
        return;
      }
      settle({ ok: true, stdout });
    });
  });
}

/** Pull the `<skills_instructions>` text block out of codex's
 *  prompt JSON. Walks the array → finds developer message →
 *  finds the input_text whose body begins with the section header.
 *
 *  Exported for unit-test reuse — flagged that the
 *  test was duplicating this logic, so production drift wouldn't
 *  fail any assertion. */
export function findSkillsBlock(json: unknown): string | null {
  if (!Array.isArray(json)) return null;
  for (const message of json) {
    if (
      typeof message !== "object" ||
      message === null ||
      (message as { role?: unknown }).role !== "developer"
    ) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text !== "string") continue;
      if (text.startsWith("<skills_instructions>")) return text;
    }
  }
  return null;
}

/** Extract skill entries from the markdown bullet list inside the
 *  skills_instructions block. Format observed on codex 0.128.0:
 *
 *      ### Available skills
 *      - imagegen: Generate or edit raster images... (file: /root/.codex/skills/.system/imagegen/SKILL.md)
 *      - superpowers:brainstorming: You MUST... (file: /root/.codex/superpowers/skills/brainstorming/SKILL.md)
 *      ### How to use skills
 *
 *  Parsing rules :
 *    - Section terminator detected with `/^###\s/m` so a description
 *      containing `###` (or a `####` subheader) doesn't truncate.
 *    - Each line is split FROM THE END on the last ` (file: ` token,
 *      and the trailing `)` is stripped. This survives `)` inside
 *      file paths or descriptions that contain literal `(file: ...)`.
 *    - Names tolerate `:` (meta-pack convention `superpowers:foo`).
 *
 *  Exported for unit-test reuse — drives the same code production
 *  uses so a regex drift breaks the parser tests. */
export function parseSkillEntries(skillsBlock: string): CodexSkillEntry[] {
  const sectionStart = skillsBlock.indexOf("### Available skills");
  if (sectionStart < 0) return [];
  const afterHeader = skillsBlock.slice(sectionStart + "### Available skills".length);
  // Find the next line-anchored `### ` header, not any `###` substring.
  // /m flag makes `^` match line starts inside the multi-line text.
  const headerMatch = /^###\s/m.exec(afterHeader);
  const section = headerMatch ? afterHeader.slice(0, headerMatch.index) : afterHeader;

  const entries: CodexSkillEntry[] = [];
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2).trim(); // strip the leading "- "

    // Split from the END on the last ` (file: ` so descriptions
    // containing parens or even a literal `(file: ...)` substring
    // don't fool the parser.
    const fileMarker = " (file: ";
    const fileIdx = body.lastIndexOf(fileMarker);
    if (fileIdx < 0 || !body.endsWith(")")) continue;
    const beforeFile = body.slice(0, fileIdx);
    const filePath = body.slice(fileIdx + fileMarker.length, -1).trim();

    // The remaining `name: description` — split on the FIRST ": "
    // (with a space) so meta-pack names like `superpowers:foo`
    // (no space after colon) don't get split mid-name.
    const colonIdx = beforeFile.indexOf(": ");
    if (colonIdx < 0) continue;
    const name = beforeFile.slice(0, colonIdx).trim();
    const description = beforeFile.slice(colonIdx + 2).trim();
    if (!name || !description || !filePath) continue;
    entries.push({ name, description, filePath });
  }
  return entries;
}

export async function probeCodexSkills(opts?: { timeoutMs?: number }): Promise<CodexProbeResult> {
  // 12 s default — measured cold-start cost on dev box is 3-6 s
  // (codex CLI process init + prompt rendering); leave headroom
  // for slow disks / busy hosts. The result caches for 5 min so
  // this only fires once per UI session.
  const timeoutMs = opts?.timeoutMs ?? 12000;
  const spawnResult = await spawnCodexDebug({ timeoutMs });
  if (!spawnResult.ok) return { ok: false, reason: spawnResult.reason };

  let parsed: unknown;
  try {
    parsed = JSON.parse(spawnResult.stdout);
  } catch (err) {
    return { ok: false, reason: `JSON parse failed: ${(err as Error).message}` };
  }

  const skillsBlock = findSkillsBlock(parsed);
  if (!skillsBlock) {
    return { ok: false, reason: "no skills_instructions block in prompt JSON" };
  }

  const skills = parseSkillEntries(skillsBlock);
  if (skills.length === 0) {
    return { ok: false, reason: "skills_instructions block produced zero entries (parser drift?)" };
  }

  return { ok: true, skills };
}
