/**
 * On-disk attachment storage for task user prompts. The frontend
 * sends file bytes (Phase 1 = images only) as base64 in the JSON
 * body of `POST /tasks` or `POST /tasks/:id/messages`; this
 * service decodes them, writes to the upload pool, indexes the
 * metadata, and produces `LeaderContentBlock[]` for the leader
 * runtime to inline into the user message.
 *
 * Storage layout:
 *   <cwd>/.magister/uploads/<task_id>/<sha256>-<safe-filename>
 *
 * The sha256 prefix dedupes repeats within a task without needing
 * a content-addressable store; safe-filename preserves the
 * user-meaningful name for the dashboard. Files are unlinked when
 * the task is purged via the task-retention sweep — see
 * `purgeForTask` and the hook in `task-retention-service.ts`.
 */
import { promises as fsp, createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import type { LeaderContentBlock } from "./manager-automation/autonomous-loop/autonomous-types";
import { TaskAttachmentRepository } from "../repositories/task-attachment-repository";

const UPLOAD_ROOT_REL = ".magister/uploads";

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
] as const;

/** Plain-text formats inlined verbatim as text blocks. No extraction
 *  step — bytes go in as-is.
 *
 *  Browsers send `.md` as `text/markdown` (RFC 7763) on Chrome/FF,
 *  but older Safari and some servers fall back to `text/plain` —
 *  accept both. */
export const ALLOWED_TEXT_MIME_TYPES = [
  "text/markdown",
  "text/plain",
  "text/csv",
] as const;

/** Binary document formats — DOCX / XLSX / PDF. Bytes are stored
 *  on disk same as everything else, but at load time we route
 *  through mammoth / xlsx / unpdf to extract text/markdown that
 *  lands as a `LeaderContentBlock` text block. The leader then
 *  reasons over the extracted prose / CSV / paragraphs the same
 *  way it does for plain markdown attachments. */
export const ALLOWED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  // Word
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // Excel
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
] as const;

export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
/** Smaller cap for inlined text — anything bigger burns context
 *  with no benefit to the model. 1 MiB is ≈ 200k tokens of dense
 *  text, well past anything you'd want as a single attachment. */
export const MAX_TEXT_SIZE_BYTES = 1 * 1024 * 1024; // 1 MiB
/** Documents are stored compressed (zip-XML for OOXML, native for
 *  PDF) so the on-disk byte cap can be more generous than the
 *  inlined text cap. The extracted text gets re-capped at
 *  `MAX_EXTRACTED_DOCUMENT_BYTES` after extraction, mirroring the
 *  read_file tool's 1 MiB extraction guarantee. */
export const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB
const MAX_EXTRACTED_DOCUMENT_BYTES = 1 * 1024 * 1024; // 1 MiB

export type AttachmentInput = {
  /** Display name; will be sanitized for filesystem use. */
  filename: string;
  /** MIME type from the upload — validated against the whitelist. */
  mimeType: string;
  /** Raw base64 of the file bytes. NO `data:` URL prefix; just
   *  the payload — that's the wire-stripping convention we already
   *  use for `LeaderContentBlock` images. */
  dataBase64: string;
};

export type SavedAttachment = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
};

export type AttachmentValidationError = {
  filename: string;
  reason: string;
};

export type SaveAttachmentsResult = {
  saved: SavedAttachment[];
  rejected: AttachmentValidationError[];
};

function uploadDirForTask(taskId: string): string {
  // Server-cwd anchored intentionally. Magister uploads are server-side
  // metadata that backs the chat attachment flow — they get inlined
  // into the model's first turn and aren't part of the user's
  // project files. Putting them under the workspace's basePath
  // would litter the user's project (`<myapp>/.magister/uploads/`)
  // with our internal storage. Path A reaffirmed this layout.
  return join(process.cwd(), UPLOAD_ROOT_REL, taskId);
}

/** Strip path separators and weird characters from a user-supplied
 *  filename. We keep dots, dashes, and word chars; everything else
 *  becomes `_`. Cap at 200 chars so a hostile upload can't make a
 *  pathologically long path. */
function sanitizeFilename(raw: string): string {
  const trimmed = raw.trim().slice(-200);
  return trimmed.replace(/[^A-Za-z0-9._-]/g, "_") || "upload";
}

function isImageMime(mimeType: string): boolean {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

function isTextMime(mimeType: string): boolean {
  return (ALLOWED_TEXT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

function isDocumentMime(mimeType: string): boolean {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mimeType.toLowerCase());
}

function isAllowedMime(mimeType: string): boolean {
  return isImageMime(mimeType) || isTextMime(mimeType) || isDocumentMime(mimeType);
}

function maxBytesFor(mimeType: string): number {
  if (isImageMime(mimeType)) return MAX_IMAGE_SIZE_BYTES;
  if (isDocumentMime(mimeType)) return MAX_DOCUMENT_SIZE_BYTES;
  return MAX_TEXT_SIZE_BYTES;
}

/** Truncate extracted document text by UTF-8 byte length to keep
 *  the leader's context bounded. Marker line tells the model the
 *  extraction was capped so it can mention that to the user
 *  instead of pretending it read the whole 100-page PDF. Mirrors
 *  the read_file tool's identical guarantee. */
function capExtracted(text: string, sourceLabel: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_EXTRACTED_DOCUMENT_BYTES) return text;
  const ratio = MAX_EXTRACTED_DOCUMENT_BYTES / bytes;
  const charCount = Math.floor(text.length * ratio) - 64;
  return (
    text.slice(0, Math.max(0, charCount))
    + `\n\n[${sourceLabel} was ${(bytes / (1024 * 1024)).toFixed(1)} MiB extracted; `
    + `truncated to fit context]`
  );
}

/** Pure-JS extraction for the binary document formats. Same libs
 *  the read_file tool uses; loaded dynamically so the rare
 *  attachment path doesn't pay the import cost on every request.
 *  Returns null when the mime isn't a document we know how to
 *  extract — caller falls back to "store-only" or rejects. */
async function extractDocumentText(
  mimeType: string,
  buffer: Buffer,
): Promise<string | null> {
  const mt = mimeType.toLowerCase();
  if (mt === "application/pdf") {
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    return typeof result.text === "string"
      ? result.text
      : (result.text as string[]).join("\n\n");
  }
  if (mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer });
    return value;
  }
  if (
    mt === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    || mt === "application/vnd.ms-excel"
  ) {
    const xlsx = await import("xlsx");
    const wb = xlsx.read(buffer, { type: "buffer" });
    const sections = wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      if (!sheet) return "";
      const csv = xlsx.utils.sheet_to_csv(sheet);
      return `## Sheet: ${name}\n\n\`\`\`csv\n${csv}\`\`\``;
    }).filter(Boolean);
    return sections.join("\n\n");
  }
  return null;
}

/**
 * Decode + validate + write a batch of attachments for a single
 * user prompt. Each file is checked individually; failures are
 * surfaced in `rejected` so the caller can decide whether to abort
 * the whole task creation or proceed without the bad files. We
 * process sequentially to keep the disk write cost predictable —
 * a 10× parallel decode of large images can spike memory.
 */
export async function saveAttachments(
  taskId: string,
  requestId: string,
  inputs: AttachmentInput[],
): Promise<SaveAttachmentsResult> {
  if (inputs.length === 0) return { saved: [], rejected: [] };

  const repo = new TaskAttachmentRepository();
  const dir = uploadDirForTask(taskId);
  await fsp.mkdir(dir, { recursive: true });

  const saved: SavedAttachment[] = [];
  const rejected: AttachmentValidationError[] = [];

  for (const input of inputs) {
    const filename = sanitizeFilename(input.filename || "upload");

    if (!isAllowedMime(input.mimeType)) {
      rejected.push({
        filename,
        reason:
          `Unsupported mime type "${input.mimeType}". Allowed: `
          + `${ALLOWED_IMAGE_MIME_TYPES.join(", ")}, `
          + `${ALLOWED_TEXT_MIME_TYPES.join(", ")}, `
          + `${ALLOWED_DOCUMENT_MIME_TYPES.join(", ")}`,
      });
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(input.dataBase64, "base64");
    } catch (err) {
      rejected.push({
        filename,
        reason: `Failed to decode base64: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    if (buffer.byteLength === 0) {
      rejected.push({ filename, reason: "Empty file" });
      continue;
    }
    const maxBytes = maxBytesFor(input.mimeType);
    if (buffer.byteLength > maxBytes) {
      rejected.push({
        filename,
        reason: `File too large (${buffer.byteLength} bytes). Max ${maxBytes} bytes for ${input.mimeType}.`,
      });
      continue;
    }

    const sha = createHash("sha256").update(buffer).digest("hex");
    // SHA prefix dedupes within a task; safe-filename preserves
    // the human-readable name for dashboard display.
    const onDiskName = `${sha.slice(0, 16)}-${filename}`;
    const storagePath = join(dir, onDiskName);

    // Write atomically (temp + rename) so a crash mid-write
    // doesn't leave a half-decoded file readable by the runtime.
    const tmp = `${storagePath}.tmp.${process.pid}.${Date.now()}`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, storagePath);

    const id = `att_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await repo.create({
      id,
      taskId,
      requestId,
      filename,
      mimeType: input.mimeType.toLowerCase(),
      sha256: sha,
      sizeBytes: buffer.byteLength,
      storagePath,
      uploadedAt: new Date(now),
    });

    saved.push({
      id,
      filename,
      mimeType: input.mimeType.toLowerCase(),
      sizeBytes: buffer.byteLength,
      sha256: sha,
      storagePath,
    });
  }

  return { saved, rejected };
}

/**
 * Build LeaderContentBlock[] for a specific (taskId, requestId)
 * tuple — the per-turn attachment scope. Images become a
 * `{type: "image"}` block; text formats (markdown, plain) become
 * a `{type: "text"}` block with a small filename header so the
 * leader knows which source the content came from. Read errors
 * degrade silently to skipped entries so a corrupted upload can't
 * block a whole turn.
 */
/** Build a single LeaderContentBlock from an attachment row.
 *  Handles all three branches (image / text / document) and
 *  centralizes the text-fencing convention so both loaders stay
 *  in lockstep. Returns null when the bytes can't be read or the
 *  document extractor errors — caller skips on null. */
async function rowToBlock(row: {
  filename: string;
  mimeType: string;
  storagePath: string;
}): Promise<LeaderContentBlock | null> {
  let buffer: Buffer;
  try {
    buffer = await fsp.readFile(row.storagePath);
  } catch (err) {
    console.warn(
      `[attachment] failed to read ${row.storagePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  if (isTextMime(row.mimeType)) {
    const fenceLang =
      row.mimeType === "text/markdown" ? "markdown"
      : row.mimeType === "text/csv" ? "csv"
      : "text";
    return {
      type: "text",
      text: `# Attached file: ${row.filename}\n\n\`\`\`${fenceLang}\n${buffer.toString("utf8")}\n\`\`\``,
    };
  }

  if (isDocumentMime(row.mimeType)) {
    try {
      const extracted = await extractDocumentText(row.mimeType, buffer);
      if (extracted === null) return null;
      const capped = capExtracted(extracted, row.filename);
      return {
        type: "text",
        text: `# Attached file: ${row.filename} (${row.mimeType})\n\n${capped}`,
      };
    } catch (err) {
      console.warn(
        `[attachment] failed to extract ${row.storagePath} (${row.mimeType}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  // Image fallback (anything that passed the whitelist but isn't
  // text or document is, by elimination, an image format).
  return {
    type: "image",
    mediaType: row.mimeType,
    data: buffer.toString("base64"),
  };
}

export async function loadAttachmentBlocksForRequest(
  taskId: string,
  requestId: string,
): Promise<LeaderContentBlock[]> {
  const repo = new TaskAttachmentRepository();
  const rows = await repo.listByTaskIdAndRequest(taskId, requestId);
  const blocks: LeaderContentBlock[] = [];
  for (const row of rows) {
    const block = await rowToBlock(row);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Build LeaderContentBlock[] for ALL attachments in a task,
 * regardless of which turn they were uploaded on. Used by
 * spawn_teammate so a teammate spawned on turn N still sees a
 * file the user uploaded on turn 1 — without this, attachments
 * are silently invisible to teammates spawned in later turns
 * (their `context.requestId` doesn't match the upload's
 * requestId, so the per-turn lookup misses).
 *
 * Same row-level error tolerance as the per-request loader: a
 * corrupted upload is logged and skipped, never aborts the spawn.
 */
export async function loadAttachmentBlocksForTask(
  taskId: string,
): Promise<LeaderContentBlock[]> {
  const repo = new TaskAttachmentRepository();
  const rows = await repo.listByTaskId(taskId);
  // Order by upload time so the teammate sees attachments in the
  // order the user added them — matches their conversation flow.
  rows.sort((a, b) => {
    const at = a.uploadedAt instanceof Date ? a.uploadedAt.getTime() : Number(a.uploadedAt);
    const bt = b.uploadedAt instanceof Date ? b.uploadedAt.getTime() : Number(b.uploadedAt);
    return at - bt;
  });
  // Dedupe by sha256 — if the user re-uploaded the same file across
  // turns we only inline it once.
  const seenSha = new Set<string>();
  const blocks: LeaderContentBlock[] = [];
  for (const row of rows) {
    if (seenSha.has(row.sha256)) continue;
    seenSha.add(row.sha256);
    const block = await rowToBlock(row);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Cleanup hook for `task-retention-service.ts` — called when a
 * task is purged. Deletes the upload directory tree (best-effort)
 * and removes the metadata rows.
 */
export async function purgeForTask(taskId: string): Promise<void> {
  const repo = new TaskAttachmentRepository();
  const rows = await repo.listByTaskId(taskId);
  // Delete files first so a crash mid-purge doesn't leave orphan
  // disk content with no DB row pointing at it for cleanup.
  const dir = uploadDirForTask(taskId);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort. Per-file failures are logged but don't block
    // the row removal — orphan disk files are easier to find
    // than orphan DB rows.
  }
  await repo.deleteByTaskId(taskId);
  void rows; // silence unused — listed for future logging
  void createReadStream; // currently unused; reserved for streaming download endpoint in a later phase
}
