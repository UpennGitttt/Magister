/**
 * Sandbox-elevation v4.3 §4.6 — justification sanitizer.
 *
 * The `justification` field is model-generated free-text that renders
 * directly into the approval card. Without sanitization the model
 * could stage prompt-injection attacks against the user:
 *   - fake `⚠️ SYSTEM: ...` lines mimicking Magister chrome
 *   - U+202E RTL override to visually reverse text (hide dangerous
 *     paths past viewport)
 *   - zero-width chars to bypass substring filters
 *   - combining diacritics / variation selectors / tag chars to
 *     forge spoofed glyphs
 *   - C1 control chars (terminal renders empty / boxes) for path
 *     display-spoofing in the approval card
 *
 * Server-side strip is defense at source: even if the client misses
 * a render-time guard, the stored payload is already clean. Client
 * still renders as a plain text node + grey background + 5-line cap
 * + "🤖 Model's reason:" server-controlled label.
 *
 * Range list audited by codex + kimi reviews (spec §4.6 +
 * appendix entry #6).
 */

const MAX_JUSTIFICATION_LENGTH = 500;

// C0 controls (U+0000-001F) except \n + DEL (U+007F) + C1 controls (U+0080-009F)
const CONTROL_CHARS = /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g;

// Zero-width + bidirectional overrides + bidirectional isolates + BOM
//   U+200B-200D zero-width space/non-joiner/joiner
//   U+200E-200F LRM / RLM (directional marks)
//   U+202A-202E LRE/RLE/PDF/LRO/RLO (bidirectional embedding/override)
//   U+2066-2069 LRI/RLI/FSI/PDI (bidirectional isolates)
//   U+FEFF      BOM / zero-width no-break space
const ZERO_WIDTH_AND_BIDI = /[​-‏‪-‮⁦-⁩﻿]/g;

// Combining diacritical marks — can visually merge into existing chars
// to forge spoofed glyphs (e.g. `ä` → ä in rendering).
//   U+0300-036F Combining Diacritical Marks
//   U+1AB0-1AFF Extended-C
//   U+1DC0-1DFF Supplement
//   U+20D0-20FF for Symbols
//   U+FE20-FE2F Half Marks
const COMBINING_DIACRITICS = /[̀-ͯ᪰-᫿᷀-᷿⃐-⃿︠-︯]/g;

// Variation selectors (alter glyph rendering without changing codepoint).
//   U+FE00-FE0F   VS1-VS16
//   U+E0100-E01EF VS17-VS256 (supplementary plane)
const VARIATION_SELECTORS = /[︀-️]/g;
const VARIATION_SELECTORS_SUPPLEMENT = /[\u{E0100}-\u{E01EF}]/gu;

// Tag characters — deprecated Unicode but still renderable on some
// platforms; can encode hidden text inside seemingly-normal strings.
//   U+E0000-U+E007F
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

/**
 * Sanitize a model-supplied justification string for safe rendering
 * in the approval card. Idempotent. Returns "" for null/undefined/empty.
 */
export function sanitizeJustification(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "";

  // 1. Hard cap at 500 chars
  let s = raw.slice(0, MAX_JUSTIFICATION_LENGTH);

  // 2. Strip C0/C1 controls (except newline)
  s = s.replace(CONTROL_CHARS, "");

  // 3. Strip zero-width + bidi overrides + isolates + BOM
  s = s.replace(ZERO_WIDTH_AND_BIDI, "");

  // 4. Strip combining diacritics
  s = s.replace(COMBINING_DIACRITICS, "");

  // 5. Strip variation selectors (both planes)
  s = s.replace(VARIATION_SELECTORS, "");
  s = s.replace(VARIATION_SELECTORS_SUPPLEMENT, "");

  // 6. Strip tag characters
  s = s.replace(TAG_CHARACTERS, "");

  // 7. Collapse runs of whitespace (no padding-out attacks)
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/[ \t]{4,}/g, "   ");

  // 8. Trim leading/trailing whitespace
  return s.trim();
}

/**
 * Re-export the cap so callers (Zod schemas) can DRY against it.
 */
export const JUSTIFICATION_MAX_LENGTH = MAX_JUSTIFICATION_LENGTH;
