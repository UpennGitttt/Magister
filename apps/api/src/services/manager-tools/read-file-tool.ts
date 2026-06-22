import { extname } from "node:path";

import {
  hasBinaryExtension,
  isBinaryContent,
  resolveInsideWorkspace,
  safeReadFileBytes,
} from "./workspace-path";

/** Extensions read_file extracts to text — these bypass the binary
 *  reject because we have a real extraction pipeline. Everything else
 *  in BINARY_EXTENSIONS gets rejected up front. */
const EXTRACTABLE_BINARY_EXTS = new Set([".docx", ".xlsx", ".xls", ".pdf"]);
// .csv has a text extension; it's NOT in BINARY_EXTENSIONS, so it
// already takes the UTF-8 path — it just happens to also dispatch
// through tryExtractBinary. No extra entry needed.

/** Cap the extracted text from binary formats. A 100 MB PDF or a
 *  multi-sheet workbook with millions of cells would otherwise be
 *  loaded fully into the leader's context — cheap to extract, but
 *  expensive on tokens and cache. The cap lets the leader still
 *  inspect the head of huge documents (typical use case: a
 *  table-of-contents or first few chapters) and explicitly signals
 *  truncation so the model can quote that boundary instead of
 *  pretending it read the whole thing. */
const MAX_EXTRACTED_TEXT_BYTES = 1 * 1024 * 1024; // 1 MiB
const TRUNCATION_MARKER = "\n\n... [extracted content truncated at 1 MiB. Use startLine/endLine to read further sections.]";

function capExtracted(text: string, sourceLabel: string): string {
  // Use byte length, not string length — 1 MiB of CJK characters
  // would still blow context if we counted code points.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_EXTRACTED_TEXT_BYTES) return text;
  // Truncate by approximate char count; UTF-8 may split a multibyte
  // char at the boundary but the marker line that follows makes
  // that obvious. Slightly conservative: shrink by a fixed margin
  // so we never overshoot.
  const ratio = MAX_EXTRACTED_TEXT_BYTES / bytes;
  const charCount = Math.floor(text.length * ratio) - 64;
  return text.slice(0, Math.max(0, charCount))
    + `\n\n[${sourceLabel} was ${(bytes / (1024 * 1024)).toFixed(1)} MiB extracted]`
    + TRUNCATION_MARKER;
}

/** Convert binary office formats and PDF to plain-text / markdown
 *  on the fly. We dispatch by extension rather than by sniffing
 *  magic bytes — these formats have well-known extensions and
 *  user-controlled file naming is not a security concern here
 *  (the extraction libs themselves treat the bytes as data, not
 *  code). Returns null when the extension isn't a known binary
 *  format, signalling "fall back to UTF-8". */
async function tryExtractBinary(filePath: string): Promise<string | null> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".docx") {
    const buffer = await safeReadFileBytes(filePath);
    const mammoth = await import("mammoth");
    // extractRawText returns paragraph-separated plain text — denser
    // than convertToHtml for a model to digest, no markup to parse.
    // We lose formatting (bold, headings) but keep the prose, which
    // is what the leader actually reasons over.
    const { value } = await mammoth.extractRawText({ buffer });
    return capExtracted(value, filePath);
  }
  if (ext === ".xlsx" || ext === ".xls" || ext === ".csv") {
    const buffer = await safeReadFileBytes(filePath);
    const xlsx = await import("xlsx");
    const wb = xlsx.read(buffer, { type: "buffer" });
    // Emit each sheet as a fenced CSV section with a header so the
    // model can scope its reasoning per sheet. CSV is the densest
    // representation that preserves cell relationships without
    // tripping HTML parsers downstream.
    const sections = wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      if (!sheet) return "";
      const csv = xlsx.utils.sheet_to_csv(sheet);
      return `## Sheet: ${name}\n\n\`\`\`csv\n${csv}\`\`\``;
    }).filter(Boolean);
    return capExtracted(sections.join("\n\n"), filePath);
  }
  if (ext === ".pdf") {
    const buffer = await safeReadFileBytes(filePath);
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    // unpdf returns { text, totalPages }; merged is a single string
    const text = typeof result.text === "string" ? result.text : (result.text as string[]).join("\n\n");
    return capExtracted(text, filePath);
  }
  return null;
}

export async function executeReadFileTool(input: {
  workspaceDir: string;
  path: string;
  startLine?: number;
  endLine?: number;
}) {
  const result = await resolveInsideWorkspace(input.workspaceDir, input.path, { intent: "read" });
  if (!result.ok) {
    // Surface the actual reason (denylist vs escape vs symlink) so the
    // model gets actionable text instead of a generic refusal.
    throw new Error(`Cannot read ${input.path}: ${result.error}`);
  }
  const resolvedPath = result.resolved;

  // Layer 2/3 — refuse known-binary extensions we can't extract. The
  // model would otherwise get bytes-as-utf8 garbage back (or for the
  // 2026-05-03 incident, megabytes of SQLite payload). Extractable
  // formats (.docx/.xlsx/.pdf) bypass this and go through the
  // mammoth/xlsx/unpdf path below.
  const extLower = extname(resolvedPath).toLowerCase();
  if (hasBinaryExtension(resolvedPath) && !EXTRACTABLE_BINARY_EXTS.has(extLower)) {
    throw new Error(
      `Cannot read ${input.path}: binary file (${extLower}). Use a different tool, extract the content first, or for documents try a supported format (.docx/.xlsx/.pdf).`,
    );
  }

  // Binary formats (DOCX / XLSX / PDF) get extracted to text first;
  // line slicing then operates on the extracted output, same as the
  // text path. For everything else, use safeReadFile which adds
  // O_NOFOLLOW + regular-file checks against TOCTOU symlink swaps.
  let content: string;
  try {
    const extracted = await tryExtractBinary(resolvedPath);
    if (extracted !== null) {
      content = extracted;
    } else {
      // For unknown / text extensions, sniff the first 8 KiB to catch
      // mislabeled binary (compressed .log, raw .dat-as-text, etc.)
      // before we hand bytes-as-utf8 to the model.
      const bytes = await safeReadFileBytes(resolvedPath);
      if (isBinaryContent(bytes)) {
        throw new Error(
          `Cannot read ${input.path}: file contains binary content (NUL bytes or >10% non-printable in first 8 KiB).`,
        );
      }
      content = bytes.toString("utf-8");
    }
  } catch (err) {
    // Re-throw with the source-file path so the leader's error
    // message has actionable context (otherwise extraction errors
    // surface as a bare "Cannot read property X of Y" from inside
    // mammoth/xlsx/unpdf).
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${input.path}: ${message}`);
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const startLine = Math.max(input.startLine ?? 1, 1);
  const endLine = Math.max(input.endLine ?? lines.length, startLine);
  const sliced = lines.slice(startLine - 1, endLine);
  while (sliced.length > 0 && sliced.at(-1) === "") {
    sliced.pop();
  }

  return {
    path: input.path,
    startLine,
    endLine: startLine + Math.max(sliced.length - 1, 0),
    content: sliced.join("\n"),
  };
}
