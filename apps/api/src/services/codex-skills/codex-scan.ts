import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { CodexSkillEntry } from "./codex-probe";

/**
 * Directory-scan fallback for codex skill discovery. We use this
 * when `codex debug prompt-input` (the probe path) fails for any
 * reason: codex CLI not installed, debug command removed in a
 * future version, prompt format drift, or just `spawn` error.
 *
 * Scanning these three source dirs produces the same skill set
 * codex's loader emits in `<skills_instructions>`. If codex adds
 * a new source dir, the scan undercounts; the user notices via the
 * Skills tab "External" section showing fewer entries than expected.
 *
 * Each source has slightly different layout:
 *   - .system/<name>/SKILL.md           — codex's bundled skills
 *   - .agents/skills/<name>/SKILL.md    — Magister-managed pool, shared
 *   - .codex/superpowers/skills/<name>/SKILL.md — meta-pack
 *
 * Names for the `superpowers` pack get a `superpowers:` prefix to
 * match what codex itself emits — that's how the meta-pack
 * convention surfaces in the system prompt.
 */

export type CodexSkillSourceLabel =
  | "codex-bundled"
  | "magister-pool"
  | "codex-superpowers";

export type ScannedSkillEntry = CodexSkillEntry & {
  source: CodexSkillSourceLabel;
};

type ScanSource = {
  label: CodexSkillSourceLabel;
  rootDir: string;
  /** Optional prefix prepended to each skill's name (e.g. `superpowers:`
   *  for the meta-pack). Empty for plain pools. */
  namePrefix: string;
};

function defaultSources(): ScanSource[] {
  const home = homedir();
  return [
    { label: "codex-bundled", rootDir: path.join(home, ".codex/skills/.system"), namePrefix: "" },
    { label: "magister-pool", rootDir: path.join(home, ".agents/skills"), namePrefix: "" },
    {
      label: "codex-superpowers",
      rootDir: path.join(home, ".codex/superpowers/skills"),
      namePrefix: "superpowers:",
    },
  ];
}

/** Read the description from a SKILL.md frontmatter block. Returns
 *  empty string if no frontmatter or no description field — we
 *  still surface the skill so users see it exists. */
async function extractDescription(skillFilePath: string): Promise<string> {
  try {
    const content = await fs.readFile(skillFilePath, "utf-8");
    if (!content.startsWith("---")) return "";
    const end = content.indexOf("\n---", 3);
    if (end < 0) return "";
    const frontmatter = content.slice(3, end);
    const match = frontmatter.match(/^description:\s*(.+?)\s*$/m);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Scan one source dir for `<name>/SKILL.md` entries. */
async function scanSource(source: ScanSource): Promise<ScannedSkillEntry[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(source.rootDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ScannedSkillEntry[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(source.rootDir, entry.name, "SKILL.md");
    let exists = false;
    try {
      const stat = await fs.stat(skillFile);
      exists = stat.isFile();
    } catch { /* missing — skip */ }
    if (!exists) continue;
    const description = await extractDescription(skillFile);
    out.push({
      name: `${source.namePrefix}${entry.name}`,
      description,
      filePath: skillFile,
      source: source.label,
    });
  }
  return out;
}

export async function scanCodexSkills(): Promise<ScannedSkillEntry[]> {
  const sources = defaultSources();
  const results = await Promise.all(sources.map(scanSource));
  return results.flat();
}
