import { createHash, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { TaskMediaSelect } from "@magister/db";

import { TaskMediaRepository } from "../repositories/task-media-repository";
import { classifyPathSensitivity } from "./safe-apply/path-sensitivity";

const OUTBOUND_MEDIA_ROOT_REL = ".magister/media/outbound";

export const MAX_OUTBOUND_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTBOUND_VIDEO_BYTES = 100 * 1024 * 1024;

export type OutboundMediaKind = "image" | "video";
export type OutboundMediaDisplay = "inline" | "attachment";
export type OutboundMediaSourceType = "tool_path" | "cli_marker" | "generated" | "remote_url";

export type CreateOutboundMediaInput = {
  taskId: string;
  requestId?: string | null;
  roleRuntimeId?: string | null;
  sourceToolCallId?: string | null;
  sourceType: OutboundMediaSourceType;
  workspaceDir: string;
  path: string;
  caption?: string | null;
  display?: OutboundMediaDisplay;
};

export type MediaSentPayload = {
  mediaId: string;
  kind: OutboundMediaKind;
  mimeType: string;
  filename: string;
  sizeBytes: number;
  caption?: string;
  display: OutboundMediaDisplay;
  width?: number;
  height?: number;
  durationMs?: number;
};

type SniffedMedia = {
  kind: OutboundMediaKind;
  mimeType: string;
};

function outboundDirForTask(taskId: string): string {
  return join(process.cwd(), OUTBOUND_MEDIA_ROOT_REL, taskId);
}

function sanitizeFilename(raw: string): string {
  const name = raw.trim().split(/[\\/]/).pop() ?? "media";
  return name.slice(-200).replace(/[^A-Za-z0-9._-]/g, "_") || "media";
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}

// send_media is bound to the workspace only. `.magister/` (memory, other
// tasks' user uploads, trust ledger state, etc.) is intentionally NOT
// in the allow list — it would let the model exfiltrate cross-task data
// by sending it back as a chat "image". The outbound store under
// .magister/media/outbound/ is written-to by this service but never
// read by send_media itself.
async function allowedRoots(workspaceDir: string): Promise<string[]> {
  const roots = [await fsp.realpath(workspaceDir)];
  if (process.env.MAGISTER_RELAXED_PATH_POLICY === "1") {
    roots.push("/");
  }
  return roots;
}

function assertNotSensitivePath(realPath: string, roots: string[]): void {
  for (const root of roots) {
    if (!isInside(root, realPath)) continue;
    const rel = relative(root, realPath);
    const normalized = rel.split(sep).join("/");
    const segments = normalized.split("/").filter(Boolean);
    const lower = normalized.toLowerCase();
    const lowerSegments = segments.map((s) => s.toLowerCase());
    const lastSegment = lowerSegments[lowerSegments.length - 1] ?? "";
    if (
      lower === "config/secrets.json"
      || lower.endsWith("/config/secrets.json")
      || lowerSegments.some(
        (s) => s === ".git" || s === ".ssh" || s === ".aws" || s === ".gnupg" || s === ".kube" || s.startsWith(".env"),
      )
      || lowerSegments.some(
        (s) =>
          s === "id_rsa"
          || s === "id_ed25519"
          || s === "id_ecdsa"
          || s === "id_dsa"
          || s === ".netrc"
          || s === ".npmrc"
          || s === ".pypirc"
          || s === "credentials"
          || s === ".git-credentials"
          || s.endsWith(".pem")
          || s.endsWith(".key")
          || s.endsWith(".p12")
          || s.endsWith(".pfx")
          || s.endsWith(".crt"),
      )
      // Credential-shaped basenames anywhere in the path
      || /credentials|secret|api[_-]?key|token/i.test(lastSegment)
    ) {
      throw new Error(`Refusing to send media from sensitive path: ${normalized}`);
    }
  }
}

// Defensive belt: route the resolved path through the same sensitivity
// classifier used by bash / write_file. Even though we already
// restrict the allow list to the workspace, this catches the edge
// case of a workspace that itself lives under /etc, ~/.ssh, etc., and
// keeps send_media inside the established safe-apply contract instead
// of carving its own bypass path.
function assertClassifierAllowsRead(realPath: string, workspaceRoot: string): void {
  const classifyOpts: Parameters<typeof classifyPathSensitivity>[2] = {
    workspaceRoot,
    ...(process.env.MAGISTER_INSTALL_DIR ? { magisterInstallDir: process.env.MAGISTER_INSTALL_DIR } : {}),
  };
  const result = classifyPathSensitivity(realPath, "read", classifyOpts);
  if (result.level === "critical") {
    throw new Error(`Refusing to send media: path classified as critical (${result.reason}).`);
  }
}

function sniffMedia(buffer: Buffer): SniffedMedia | null {
  if (
    buffer.length >= 8
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a
  ) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (buffer.length >= 6) {
    const sig = buffer.subarray(0, 6).toString("ascii");
    if (sig === "GIF87a" || sig === "GIF89a") return { kind: "image", mimeType: "image/gif" };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return { kind: "image", mimeType: "image/webp" };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    return { kind: "video", mimeType: "video/mp4" };
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return { kind: "video", mimeType: "video/webm" };
  }
  return null;
}

function imageDimensions(buffer: Buffer, mimeType: string): { width?: number; height?: number } {
  if (mimeType === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mimeType === "image/gif" && buffer.length >= 10) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1] ?? 0;
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + length;
    }
  }
  return {};
}

function assertSizeAllowed(kind: OutboundMediaKind, sizeBytes: number): void {
  const max = kind === "image" ? MAX_OUTBOUND_IMAGE_BYTES : MAX_OUTBOUND_VIDEO_BYTES;
  if (sizeBytes > max) {
    throw new Error(`Media file too large (${sizeBytes} bytes). Max ${max} bytes for ${kind}.`);
  }
}

export async function createOutboundMediaFromPath(input: CreateOutboundMediaInput): Promise<TaskMediaSelect> {
  const candidatePath = isAbsolute(input.path) ? input.path : join(input.workspaceDir, input.path);
  const roots = await allowedRoots(input.workspaceDir);
  const realPath = await fsp.realpath(candidatePath);
  if (!roots.some((root) => isInside(root, realPath))) {
    throw new Error(`Media path resolves outside allowed media roots: ${input.path}`);
  }
  assertNotSensitivePath(realPath, roots);
  assertClassifierAllowsRead(realPath, roots[0]!);

  const stat = await fsp.stat(realPath);
  if (!stat.isFile()) throw new Error(`Media path is not a file: ${input.path}`);
  if (stat.size > MAX_OUTBOUND_VIDEO_BYTES) {
    throw new Error(`Media file too large (${stat.size} bytes). Max ${MAX_OUTBOUND_VIDEO_BYTES} bytes.`);
  }

  const buffer = await fsp.readFile(realPath);
  const sniffed = sniffMedia(buffer);
  if (!sniffed) throw new Error("Unsupported media type. Allowed output media: PNG, JPEG, WebP, GIF, MP4, WebM.");
  assertSizeAllowed(sniffed.kind, buffer.byteLength);

  const hash = createHash("sha256").update(buffer).digest("hex");
  const mediaId = `media_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const safeName = sanitizeFilename(realPath);
  const dir = join(outboundDirForTask(input.taskId), mediaId);
  await fsp.mkdir(dir, { recursive: true });
  const storagePath = join(dir, safeName);
  await fsp.writeFile(storagePath, buffer);

  const dims = sniffed.kind === "image" ? imageDimensions(buffer, sniffed.mimeType) : {};
  const now = new Date();
  const row = {
    id: mediaId,
    taskId: input.taskId,
    requestId: input.requestId ?? null,
    roleRuntimeId: input.roleRuntimeId ?? null,
    sourceToolCallId: input.sourceToolCallId ?? null,
    sourceType: input.sourceType,
    filename: safeName,
    mimeType: sniffed.mimeType,
    kind: sniffed.kind,
    sizeBytes: buffer.byteLength,
    contentHash: hash,
    storagePath,
    width: dims.width ?? null,
    height: dims.height ?? null,
    durationMs: null,
    caption: input.caption?.trim() || null,
    display: input.display ?? "inline",
    status: "ready",
    metadataJson: null,
    createdAt: now,
    deletedAt: null,
    retainedUntil: null,
  } satisfies Parameters<TaskMediaRepository["create"]>[0];

  await new TaskMediaRepository().create(row);
  return row as TaskMediaSelect;
}

export function toMediaSentPayload(media: TaskMediaSelect): MediaSentPayload {
  const payload: MediaSentPayload = {
    mediaId: media.id,
    kind: media.kind === "video" ? "video" : "image",
    mimeType: media.mimeType,
    filename: media.filename,
    sizeBytes: media.sizeBytes,
    display: media.display === "attachment" ? "attachment" : "inline",
  };
  if (media.caption) payload.caption = media.caption;
  if (typeof media.width === "number") payload.width = media.width;
  if (typeof media.height === "number") payload.height = media.height;
  if (typeof media.durationMs === "number") payload.durationMs = media.durationMs;
  return payload;
}

export async function purgeOutboundMediaForTask(taskId: string): Promise<void> {
  const repo = new TaskMediaRepository();
  const rows = await repo.listByTaskId(taskId);
  const taskDir = outboundDirForTask(taskId);
  for (const row of rows) {
    await fsp.rm(row.storagePath, { force: true }).catch(() => {});
    await fsp.rm(join(taskDir, row.id), { recursive: true, force: true }).catch(() => {});
  }
  await fsp.rm(taskDir, { recursive: true, force: true }).catch(() => {});
  await repo.deleteByTaskId(taskId);
}
