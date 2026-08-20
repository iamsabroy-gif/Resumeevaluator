/**
 * Bullet parsing.
 *
 * Per the brief's open decision, this is the regex/heuristic approach rather
 * than AI-assisted parsing. That is a deliberate consistency choice, not just
 * a simplicity one: three of the engine's checks (weak openers, bullet length,
 * terminology consistency) run over `extractBullets()`'s output. If this
 * parser recognised a different set of lines as bullets than the engine does,
 * the UI would offer to rewrite bullets that were never scored, and would stay
 * silent about bullets that were.
 *
 * So the bullet regex here is the same one the engine uses. It is defined once
 * below and asserted against the engine's own extraction in the pipeline
 * tests, so the two cannot drift apart unnoticed.
 */

import { newId } from "../domain/ids.js";
import type { Bullet } from "../domain/types.js";

/** Must stay in step with extractBullets() in src/engine/ats-scorer.ts. */
export const BULLET_LINE_RE = /^\s*[-•*·]\s+(.*)$/;

/**
 * A line that reads like a role/section heading: short, not a bullet, and
 * either a known section header or a title-with-dates line. Used only to
 * attribute bullets to a role for the before/after UI — nothing in scoring
 * depends on it.
 */
const HEADING_HINT_RE =
  /^(?:[A-Z][A-Za-z&/ ,.'-]{2,60})(?:\s*[|–—-]\s*.+)?$/;
const DATE_HINT_RE =
  /\b(?:19|20)\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\b/i;

export interface ParsedBullet {
  text: string;
  roleId: string | null;
  order: number;
  sourceLine: number;
}

function looksLikeHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 90) return false;
  if (BULLET_LINE_RE.test(line)) return false;
  // A heading is either a plain title-case line or a title line carrying dates.
  return HEADING_HINT_RE.test(trimmed) || DATE_HINT_RE.test(trimmed);
}

export function parseBullets(rawText: string): ParsedBullet[] {
  const lines = rawText.split("\n");
  const out: ParsedBullet[] = [];
  let currentRole: string | null = null;
  let order = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(BULLET_LINE_RE);
    if (match) {
      const text = match[1].trim();
      if (!text) continue;
      out.push({ text, roleId: currentRole, order: order++, sourceLine: i });
      continue;
    }
    if (looksLikeHeading(line)) {
      currentRole = line.trim();
    }
  }

  return out;
}

export function toBulletEntities(resumeId: string, parsed: ParsedBullet[]): Bullet[] {
  return parsed.map((p) => ({
    id: newId("bul"),
    resumeId,
    roleId: p.roleId,
    originalText: p.text,
    order: p.order,
    sourceLine: p.sourceLine,
  }));
}
