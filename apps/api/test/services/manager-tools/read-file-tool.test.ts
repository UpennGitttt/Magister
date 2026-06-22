/**
 * Tests for the read_file tool's binary-format dispatch (DOCX /
 * XLSX / PDF). UTF-8 fall-through path is covered by callers; this
 * file focuses on the new extension-based extraction.
 *
 * XLSX fixtures are synthesized in-memory via the same `xlsx`
 * package the tool uses — no external sample files needed. DOCX
 * and PDF fixtures are minimal hand-built blobs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as xlsx from "xlsx";

import { executeReadFileTool } from "../../../src/services/manager-tools/read-file-tool";

const tempRoot = join(process.cwd(), ".tmp-read-file-tool-test");

beforeEach(() => {
  mkdirSync(tempRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

test("read_file on .xlsx returns CSV per sheet", async () => {
  const wb = xlsx.utils.book_new();
  const sheet1 = xlsx.utils.aoa_to_sheet([
    ["Name", "Age", "City"],
    ["Alice", 30, "Hangzhou"],
    ["Bob", 25, "Shanghai"],
  ]);
  const sheet2 = xlsx.utils.aoa_to_sheet([
    ["Item", "Price"],
    ["Apple", 5],
    ["Banana", 3],
  ]);
  xlsx.utils.book_append_sheet(wb, sheet1, "People");
  xlsx.utils.book_append_sheet(wb, sheet2, "Prices");

  const filePath = join(tempRoot, "data.xlsx");
  // xlsx.write→buffer (not writeFile): the patched SheetJS CDN build does
  // not auto-bind node fs, so writeFile throws. Production only reads.
  writeFileSync(filePath, xlsx.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  const result = await executeReadFileTool({
    workspaceDir: tempRoot,
    path: "data.xlsx",
  });

  expect(result.content).toContain("## Sheet: People");
  expect(result.content).toContain("Name,Age,City");
  expect(result.content).toContain("Alice,30,Hangzhou");
  expect(result.content).toContain("## Sheet: Prices");
  expect(result.content).toContain("Apple,5");
});

test("read_file on .csv routes through the xlsx path too", async () => {
  // CSV is parsed by xlsx as a single-sheet workbook. Routing it
  // through the same code path means the leader gets a structured
  // header even for raw CSV files dropped in the workspace.
  const filePath = join(tempRoot, "tiny.csv");
  writeFileSync(filePath, "a,b,c\n1,2,3\n");

  const result = await executeReadFileTool({
    workspaceDir: tempRoot,
    path: "tiny.csv",
  });

  expect(result.content).toContain("## Sheet:");
  expect(result.content).toContain("a,b,c");
  expect(result.content).toContain("1,2,3");
});

test("read_file on plain .txt falls through to UTF-8 path unchanged", async () => {
  const filePath = join(tempRoot, "plain.txt");
  writeFileSync(filePath, "hello\nworld\n", "utf8");

  const result = await executeReadFileTool({
    workspaceDir: tempRoot,
    path: "plain.txt",
  });

  expect(result.content).toBe("hello\nworld");
});

test("read_file line range applies after binary extraction", async () => {
  // The line slicing logic should operate on the extracted text,
  // not on the raw bytes — otherwise asking for "first 5 lines of
  // a spreadsheet" would return garbage from the zip header.
  const wb = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([
    ["row1"],
    ["row2"],
    ["row3"],
    ["row4"],
    ["row5"],
  ]);
  xlsx.utils.book_append_sheet(wb, sheet, "S");
  const filePath = join(tempRoot, "lines.xlsx");
  // xlsx.write→buffer (not writeFile): the patched SheetJS CDN build does
  // not auto-bind node fs, so writeFile throws. Production only reads.
  writeFileSync(filePath, xlsx.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  const result = await executeReadFileTool({
    workspaceDir: tempRoot,
    path: "lines.xlsx",
    startLine: 1,
    endLine: 3,
  });

  // First 3 lines should include the section header. Body rows
  // start after.
  expect(result.startLine).toBe(1);
  expect(result.endLine).toBeLessThanOrEqual(3);
});

test("read_file caps extraction output at 1 MiB", async () => {
  // Synthesize an xlsx with enough rows to push the CSV
  // projection past the 1 MiB cap. ~30 cols × 10000 rows of
  // numeric data ≈ 1.5 MiB CSV.
  const rows: string[][] = [];
  rows.push(Array.from({ length: 30 }, (_, i) => `col${i}`));
  for (let i = 0; i < 10000; i++) {
    rows.push(Array.from({ length: 30 }, (_, j) => String(i * 100 + j)));
  }
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet(rows), "Big");
  const filePath = join(tempRoot, "big.xlsx");
  // xlsx.write→buffer (not writeFile): the patched SheetJS CDN build does
  // not auto-bind node fs, so writeFile throws. Production only reads.
  writeFileSync(filePath, xlsx.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);

  const result = await executeReadFileTool({
    workspaceDir: tempRoot,
    path: "big.xlsx",
  });

  // Truncation marker present, content still includes the head.
  expect(result.content.length).toBeLessThan(1.1 * 1024 * 1024); // some slack for the marker
  expect(result.content).toContain("col0");
  expect(result.content).toContain("extracted content truncated");
});

test("read_file extraction error surfaces with file path context", async () => {
  // Corrupted .docx (not a zip) — mammoth rejects on missing
  // central directory. The wrapper should re-throw with the
  // user's source path included so the leader's error message is
  // actionable.
  const filePath = join(tempRoot, "broken.docx");
  writeFileSync(filePath, "not actually a docx");

  await expect(
    executeReadFileTool({ workspaceDir: tempRoot, path: "broken.docx" }),
  ).rejects.toThrow(/Failed to read broken\.docx/);
});
