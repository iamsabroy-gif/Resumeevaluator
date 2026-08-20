/**
 * ATS Scoring Engine — TypeScript port
 * -------------------------------------
 * Faithful port of ats_scorer.py v4 per the language-independent spec
 * (ATS Scoring Engine — Implementation Specification, §1-14).
 *
 * Deterministic. No network dependency. Optional semantic layer stubbed
 * as unavailable (returns null) — matches spec §7.3 fallback behaviour.
 *
 * Designed to be dropped into a Base44 backend function's shared folder
 * with zero modification (pure functions, no Base44-specific imports).
 */

// ------------------------------------------------------------------ types

export interface SkillBank {
  domain: string;
  display_name: string;
  detect_terms: string[];
  skill_groups?: Record<string, string[]>;
  skills: string[];
}

export interface ScoreResult {
  domain: string;
  format_quality: number;
  section_structure: number;
  keyword_match: number;
  skills_alignment: number;
  content_density: number;
  recency_multiplier: number;
  knockouts: string[];
  matched_skills: string[];
  missing_skills: string[];
  human_scan_flags: string[];
  human_scan_flags_graded: { message: string; evidence: EvidenceGrade; checkId: string }[];
  semantic: number | null;
  final: number;
}

// ------------------------------------------------------------------ config
// Spec §3 — Configuration Constants. Weights must sum to 1.0.

export const WEIGHTS = {
  keyword_match: 0.35,
  skills_alignment: 0.25,
  format_quality: 0.20,
  section_structure: 0.12,
  content_density: 0.08,
};

const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (Math.abs(weightSum - 1.0) > 1e-9) {
  throw new Error(`WEIGHTS must sum to 1.0, got ${weightSum}`);
}

export const DENSITY_FULL_MARKS_TOKENS = 300;
export const RECENCY_MULTIPLIER = 1.15;
export const RECENCY_TOP_LINES = 12;
export const RECENCY_HIT_THRESHOLD = 0.5;
export const KNOCKOUT_GAP_MONTHS = 6; // descriptive only, see GAP_FLAG_YEARS
export const GAP_FLAG_YEARS = 1; // actual trigger: delta > 1 year
export const MAX_BULLET_WORDS = 30;
export const SCAN_ZONE_LIMIT = 25;
export const COSINE_BLEND = 0.4;
export const COVERAGE_BLEND = 0.6;
export const SEMANTIC_BLEND = 0.4;

// ---- v5 evidence-weighted penalty caps -------------------------------
// Reweighted per "Resume-Screening Heuristics: Evidence-Weighted Review
// (2023-2026)". Each cap below is graded by source quality:
//   (a) rigorous academic/eye-tracking  (b) large-sample vendor study
//   (c) folklore / weakly-sourced advice
// Checks graded (a)/(b) keep or gain weight; checks graded (c) are
// downweighted so a single low-confidence flag can't swing the score as
// hard as a well-evidenced one. See EVIDENCE_GRADE below for the mapping
// surfaced to callers/UI.
export const SPELLING_PENALTY_PER_ERROR = 0.037; // (a) PLOS ONE 2023: ~7.3pt
  // interview-probability drop per 2 errors, ~18.5pt per 5 -> ~3.7pt/error,
  // expressed as a 0-1 format_quality fraction, capped below
export const SPELLING_PENALTY_CAP = 0.20; // (a) highest-evidence check;
  // allowed the largest single-check cap in the engine
export const WEAK_OPENER_PENALTY_CAP = 0.06; // was 0.15 — (c) folklore-grade
  // ("140% more interviews" traces to one unreplicated 2018 vendor blog);
  // kept as a light structural nudge, not a heavily-weighted check
export const BULLET_LENGTH_PENALTY_CAP = 0.10; // (a)/(c) mixed — cognitive-
  // load mechanism is well-supported, the specific 30-word/3-line cutoff
  // is a rule of thumb; cap unchanged
export const SCAN_ZONE_NOT_FOUND_PENALTY = 0.10; // was 0.15 — (c)
  // extrapolated from the single TheLadders vendor study (n=30); the
  // *mechanism* (top-third placement matters) is well-corroborated by
  // primacy + top-left-dominance research, but the specific "lose
  // interest" depth has no independent measurement
export const SCAN_ZONE_TOO_DEEP_PENALTY_CAP = 0.10; // was 0.15, same basis
export const TERMINOLOGY_PENALTY_CAP = 0.15; // (a) unchanged — halo/horns
  // effect is well-established (Sterkens et al. 2023; Thorndike 1920)
export const CLOSING_SECTION_PENALTY = 0.03; // was 0.05 — (c) weakest
  // check in the engine: primacy/recency is real cognition research, but
  // no resume-specific study measures "what section it closes on"

export type EvidenceGrade = "a" | "b" | "c";

export const EVIDENCE_GRADE: Record<string, EvidenceGrade> = {
  table_or_tab_format: "b", // multi-column/table ATS-parse failure — strong
  graphic_bullets: "b",
  header_footer_noise: "b",
  spelling_consistency: "a", // Sterkens et al., PLOS ONE 2023, n=445 recruiters
  weak_openers: "c", // TalentWorks 2018 blog, unreplicated, non-causal
  bullet_length: "c",
  scan_zone: "c", // TheLadders eye-tracking study, n=30, non-peer-reviewed
  closing_section: "c",
  keyword_coverage: "b",
  skills_alignment: "b",
  recency_multiplier: "b",
  employment_gap: "a", // Kristal et al., Nature Human Behaviour 2022
};

export const STANDARD_HEADERS = [
  "professional summary",
  "summary",
  "work experience",
  "experience",
  "education",
  "skills",
  "certifications",
];

export const STOPWORDS = new Set(
  `a an the and or of to in for with on at by from as is are be this
   that we our i you your it its using used will can within across into over per`
    .split(/\s+/)
    .filter(Boolean)
);

export const ACRONYM_STOPWORDS = new Set([
  "AND", "THE", "FOR", "WITH", "YOU", "OUR", "ARE", "ALL", "NEW", "PLC",
  "LTD", "INC", "USD", "GBP", "INR", "JR", "ID",
]);

export const WEAK_OPENERS = new Set(["handling", "responsible", "leading", "ensuring"]);

export const CLOSING_LOWER_PRIORITY = new Set(["certifications", "certification"]);

const EDUCATION_LINE_RE = /\b(university|college|institute|b\.?\s?tech|b\.?\s?e\.?|bachelor|master|cgpa|gpa|wbut|school)\b/i;

const MONTH_RE = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

// Accepts ASCII hyphen AND en dash (U+2013) — spec §13 porting note.
const RANGE_PATTERN = new RegExp(
  `\\b(?:${MONTH_RE}\\s+)?((?:19|20)\\d{2})\\s*[-\u2013]\\s*(?:${MONTH_RE}\\s+)?(present|(?:19|20)\\d{2})`,
  "gi"
);

// ------------------------------------------------------------------ normalisation (§5)

export function normalize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[a-z0-9][a-z0-9\-.\/]*/g) || [];
  return tokens.filter((t) => !STOPWORDS.has(t) && t.length > 1);
}

// ------------------------------------------------------------------ acronym extraction (§7.2)

export function extractAcronyms(raw: string): Set<string> {
  const found = new Set<string>();
  const matches = raw.match(/\b[A-Z]{2,6}[A-Z0-9]?\b/g) || [];
  for (const tok of matches) {
    if (ACRONYM_STOPWORDS.has(tok)) continue;
    if (STOPWORDS.has(tok.toLowerCase())) continue; // sentence-initial caps
    found.add(tok.toLowerCase());
  }
  return found;
}

// ------------------------------------------------------------------ TF-IDF + cosine (§7.1.1)

function freqMap(tokens: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

export function tfIdfVector(
  docTokens: string[],
  otherTokens: string[]
): Map<string, number> {
  const counts = freqMap(docTokens);
  const otherCounts = freqMap(otherTokens);
  const vector = new Map<string, number>();
  for (const [term, count] of counts) {
    const df = (counts.has(term) ? 1 : 0) + (otherCounts.has(term) ? 1 : 0);
    const idf = Math.log((2 + 1) / (df + 1)) + 1; // natural log, smoothed
    vector.set(term, (count / docTokens.length) * idf);
  }
  return vector;
}

export function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [term, va] of a) {
    const vb = b.get(term);
    if (vb !== undefined) dot += va * vb;
  }
  let normA = 0;
  for (const v of a.values()) normA += v * v;
  normA = Math.sqrt(normA);
  let normB = 0;
  for (const v of b.values()) normB += v * v;
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0.0;
  return dot / (normA * normB);
}

// ------------------------------------------------------------------ Stage 1: format quality (§6)

function looksLikeTable(raw: string): boolean {
  let linesWithPipes = 0;
  for (const line of raw.split("\n")) {
    const n = (line.match(/\|/g) || []).length;
    if (n >= 3) return true; // one row, several column delimiters
    if (n >= 1) linesWithPipes += 1;
  }
  return linesWithPipes >= 2; // repeated across lines = multi-row table
}

export function scoreFormat(raw: string): number {
  let score = 1.0;
  if (raw.includes("\t") || looksLikeTable(raw)) score -= 0.4;
  if (/[│┃▪◦◆■●]/.test(raw)) score -= 0.2;
  if (/\b(page \d+|confidential)\b/i.test(raw)) score -= 0.15;
  return Math.max(0.0, score);
}

// ---- spelling / typo detection (§6.2 addition, v5) --------------------
// Evidence grade (a): Sterkens et al., "Costly mistakes: Why and when
// spelling errors in resumes jeopardise interview chances," PLOS ONE
// (2023) — 445 recruiters, 1,335 resumes. 2 errors -> -7.3pt interview
// probability; 5 errors -> -18.5pt. This is the single strongest-evidence
// check available and was previously absent from the engine entirely.
//
// Dependency-free heuristic (no external dictionary): flags a small set
// of structural anomaly patterns rather than doing full spellcheck,
// since a false-positive-heavy checker would be worse than none. Three
// signal types:
//   1. Triple-or-more repeated letters (e.g. "commmitted") — essentially
//      always a typo, never a real English word.
//   2. A small curated list of resume/tech terms that are frequently
//      misspelled in this domain (extensible; seed list below), matched
//      case-insensitively against known-correct forms.
//   3. Doubled space or space-before-punctuation artifacts, which often
//      indicate a botched edit/deletion and correlate with the same
//      "carelessness" signal the PLOS ONE study measures.
// This intentionally does NOT attempt general-purpose spellcheck (that
// requires a real dictionary dependency and has a high false-positive
// rate against proper nouns, product names, and domain jargon).

const COMMON_MISSPELLINGS: Record<string, string> = {
  // seed list — extend per-domain via mergeCommonMisspellings()
  recieve: "receive",
  seperate: "separate",
  managment: "management",
  acheive: "achieve",
  occured: "occurred",
  succesful: "successful",
  responsibilty: "responsibility",
  enviroment: "environment",
  collabration: "collaboration",
  developement: "development",
  intergrated: "integrated",
  maintainance: "maintenance",
  neccessary: "necessary",
  liason: "liaison",
  buisness: "business",
  acomplish: "accomplish",
  comittee: "committee",
  excelent: "excellent",
  reccommend: "recommend",
  strengh: "strength",
};

export function mergeCommonMisspellings(extra: Record<string, string>): void {
  Object.assign(COMMON_MISSPELLINGS, extra);
}

export interface SpellingCheckResult {
  errorCount: number;
  flagged: string[]; // human-readable, e.g. "recieve -> receive"
}

export function checkSpelling(raw: string): SpellingCheckResult {
  const flagged: string[] = [];

  // 1. Triple-repeated letters
  const tripleRepeats = raw.match(/\b\w*([a-zA-Z])\1{2,}\w*\b/g) || [];
  for (const word of tripleRepeats) {
    flagged.push(`repeated-letter anomaly: "${word}"`);
  }

  // 2. Curated misspelling list, whole-word, case-insensitive
  const words = raw.match(/[a-zA-Z]+/g) || [];
  const seen = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase();
    if (COMMON_MISSPELLINGS[lw] && !seen.has(lw)) {
      flagged.push(`"${w}" -> likely "${COMMON_MISSPELLINGS[lw]}"`);
      seen.add(lw);
    }
  }

  // 3. Double-space / space-before-punctuation artifacts (light signal,
  // counted but capped in contribution below). Checked line-by-line and
  // restricted to bullet lines (extractBullets) rather than the whole
  // resume: title/date header lines legitimately use double-space or tab
  // as a visual separator between a role title and its dates (e.g.
  // "Senior Manager  Jul 2024 - Present"), and flagging that as a typo
  // artifact would false-positive on normal, deliberate formatting.
  // Prose bullets don't have that legitimate use case, so restricting
  // detection to bullets avoids the false positive while still catching
  // real double-space typos within sentences.
  const bulletsForArtifacts = extractBullets(raw);
  let rawArtifactCount = 0;
  for (const line of bulletsForArtifacts) {
    rawArtifactCount += (line.match(/[a-zA-Z]  [a-zA-Z]/g) || []).length;
    rawArtifactCount += (line.match(/[a-zA-Z] [,.;:]/g) || []).length;
  }
  const artifactCount = Math.min(3, rawArtifactCount); // cap contribution
  // from this weaker sub-signal so it can't dominate
  if (rawArtifactCount > 0) {
    flagged.push(
      `${rawArtifactCount} spacing/punctuation artifact(s) in bullet text (double space or space before punctuation)`
    );
  }

  const errorCount = tripleRepeats.length + Object.keys(
    words.reduce((acc, w) => {
      const lw = w.toLowerCase();
      if (COMMON_MISSPELLINGS[lw]) acc[lw] = true;
      return acc;
    }, {} as Record<string, boolean>)
  ).length + artifactCount;

  return { errorCount, flagged };
}

export function scoreSections(raw: string): { score: number; found: number } {
  const low = raw.toLowerCase();
  const found = STANDARD_HEADERS.filter((h) => low.includes(h)).length;
  return { score: Math.min(1.0, found / 5), found };
}

export function scoreDensity(tokens: string[]): number {
  return Math.min(1.0, tokens.length / DENSITY_FULL_MARKS_TOKENS);
}

// ---- human-screening heuristics (§6.2) --------------------------------

export function extractBullets(raw: string): string[] {
  const bullets: string[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*[-•*·]\s+(.*)$/);
    if (m && m[1].trim()) bullets.push(m[1].trim());
  }
  return bullets;
}

function scoreWeakOpeners(bullets: string[]): { frac: number; flagged: string[] } {
  if (bullets.length === 0) return { frac: 0, flagged: [] };
  const flagged: string[] = [];
  for (const b of bullets) {
    const m = b.match(/^[A-Za-z']+/);
    if (m && WEAK_OPENERS.has(m[0].toLowerCase())) flagged.push(b.slice(0, 70));
  }
  return { frac: flagged.length / bullets.length, flagged };
}

function scoreBulletLength(bullets: string[]): { frac: number; flagged: string[] } {
  if (bullets.length === 0) return { frac: 0, flagged: [] };
  const flagged = bullets
    .filter((b) => b.split(/\s+/).length > MAX_BULLET_WORDS)
    .map((b) => b.slice(0, 70));
  return { frac: flagged.length / bullets.length, flagged };
}

function scoreScanZone(raw: string): number {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (EDUCATION_LINE_RE.test(lines[i])) continue;
    RANGE_PATTERN.lastIndex = 0;
    if (RANGE_PATTERN.test(lines[i])) return i;
  }
  return -1;
}

function scoreTerminologyConsistency(bullets: string[]): string[] {
  const forms = new Map<string, Set<string>>();
  for (const b of bullets) {
    const words = b.match(/[A-Za-z][A-Za-z-]{2,}/g) || [];
    words.forEach((w, idx) => {
      if (idx === 0) return; // sentence-initial capitalisation is normal
      const key = w.toLowerCase();
      if (!forms.has(key)) forms.set(key, new Set());
      forms.get(key)!.add(w);
    });
  }
  return Array.from(forms.entries())
    .filter(([, variants]) => variants.size > 1)
    .map(([k]) => k)
    .sort();
}

function scoreClosingSection(raw: string): string | null {
  const low = raw.toLowerCase();
  const positions: Record<string, number> = {};
  for (const h of STANDARD_HEADERS) {
    const idx = low.lastIndexOf(h);
    if (idx !== -1) positions[h] = idx;
  }
  const keys = Object.keys(positions);
  if (keys.length === 0) return null;
  return keys.reduce((a, b) => (positions[a] > positions[b] ? a : b));
}

export interface FormatWithFlags {
  format_quality: number;
  human_scan_flags: string[];
  human_scan_flags_graded: { message: string; evidence: EvidenceGrade; checkId: string }[];
}

export function scoreFormatWithHumanScreening(raw: string): FormatWithFlags {
  let formatQuality = scoreFormat(raw);
  const bullets = extractBullets(raw);
  const { frac: weakFrac, flagged: weakFlagged } = scoreWeakOpeners(bullets);
  const { frac: longFrac, flagged: longFlagged } = scoreBulletLength(bullets);
  const scanLine = scoreScanZone(raw);
  const inconsistentTerms = scoreTerminologyConsistency(bullets);
  const lastSection = scoreClosingSection(raw);
  const spelling = checkSpelling(raw);

  let penalty = 0;
  const flags: string[] = [];
  const gradedFlags: { message: string; evidence: EvidenceGrade; checkId: string }[] = [];

  // Highest-evidence check first: spelling/typo consistency.
  // (a) Sterkens et al., PLOS ONE 2023 (n=445 recruiters, 1,335 resumes):
  // ~7.3pt interview-probability drop at 2 errors, ~18.5pt at 5 errors.
  if (spelling.errorCount > 0) {
    const pen = Math.min(SPELLING_PENALTY_CAP, spelling.errorCount * SPELLING_PENALTY_PER_ERROR);
    penalty += pen;
    const msg =
      `${spelling.errorCount} likely spelling/typo issue(s) detected: ` +
      `${spelling.flagged.slice(0, 5).join("; ")}${spelling.flagged.length > 5 ? "..." : ""} -- ` +
      `spelling errors carry the strongest documented interview-probability impact of any ` +
      `formatting signal (recruiter studies show real, measured penalties for this)`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "a", checkId: "spelling_consistency" });
  }

  if (weakFlagged.length > 0) {
    const pen = Math.min(WEAK_OPENER_PENALTY_CAP, weakFrac * 0.3);
    penalty += pen;
    const msg =
      `${weakFlagged.length}/${bullets.length} bullet(s) open with a weak filler verb ` +
      `(Responsible for / Handling / Leading / Ensuring) instead of a strong action verb -- ` +
      `advisory nudge, not a heavily-weighted signal: ${weakFlagged.slice(0, 3).join("; ")}`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "c", checkId: "weak_openers" });
  }
  if (longFlagged.length > 0) {
    const pen = Math.min(BULLET_LENGTH_PENALTY_CAP, longFrac * 0.2);
    penalty += pen;
    const msg =
      `${longFlagged.length}/${bullets.length} bullet(s) exceed ~${MAX_BULLET_WORDS} words ` +
      `and likely wrap 3+ lines, raising cognitive load during a fast skim`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "c", checkId: "bullet_length" });
  }
  if (scanLine === -1) {
    penalty += SCAN_ZONE_NOT_FOUND_PENALTY;
    const msg =
      "No clear current-employment date range detected near the top of the resume -- " +
      "advisory: placing the current title/employer/dates near the top is well-supported by " +
      "primacy and top-left-scanning research, though the specific depth threshold is a heuristic";
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "c", checkId: "scan_zone" });
  } else if (scanLine > SCAN_ZONE_LIMIT) {
    const pen = Math.min(SCAN_ZONE_TOO_DEEP_PENALTY_CAP, (scanLine - SCAN_ZONE_LIMIT) * 0.01);
    penalty += pen;
    const msg =
      `Current title/employer/dates line doesn't appear until line ${scanLine + 1} -- ` +
      `Summary/Competencies block may be pushing it down; advisory signal`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "c", checkId: "scan_zone" });
  }
  if (inconsistentTerms.length > 0) {
    const pen = Math.min(TERMINOLOGY_PENALTY_CAP, inconsistentTerms.length * 0.03);
    penalty += pen;
    const shown = inconsistentTerms.slice(0, 8).join(", ");
    const more = inconsistentTerms.length > 8 ? "..." : "";
    const msg =
      `Inconsistent spelling/capitalization for: ${shown}${more} -- ` +
      `well-documented halo/horns effect from recruiter research`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "a", checkId: "spelling_consistency" });
  }
  if (lastSection && CLOSING_LOWER_PRIORITY.has(lastSection)) {
    penalty += CLOSING_SECTION_PENALTY;
    const msg =
      `Resume closes on '${lastSection}' -- weak advisory signal based on general primacy/` +
      `recency cognition research; consider closing on Education or a positioning note instead`;
    flags.push(msg);
    gradedFlags.push({ message: msg, evidence: "c", checkId: "closing_section" });
  }

  formatQuality = Math.max(0.0, formatQuality - penalty);
  return { format_quality: formatQuality, human_scan_flags: flags, human_scan_flags_graded: gradedFlags };
}

// ------------------------------------------------------------------ Stage 2: matching (§7)

export function scoreKeywordMatch(
  resumeText: string,
  jdText: string,
  bankSkills: string[],
  semanticSimilarity: number | null = null
): { keyword_match: number; semantic: number | null } {
  const jdTokens = jdText.trim() ? normalize(jdText) : bankSkills.slice();
  const rTokens = normalize(resumeText);

  const va = tfIdfVector(rTokens, jdTokens);
  const vb = tfIdfVector(jdTokens, rTokens);
  const cos = cosine(va, vb);

  const jdTerms = new Set(jdTokens.filter((t) => !STOPWORDS.has(t)));
  const rSet = new Set(rTokens);
  let intersectCount = 0;
  for (const t of jdTerms) if (rSet.has(t)) intersectCount++;
  const coverage = jdTerms.size > 0 ? intersectCount / jdTerms.size : 0.0;

  let keywordMatch = COSINE_BLEND * cos + COVERAGE_BLEND * coverage;

  let semantic: number | null = semanticSimilarity;
  if (jdText.trim() && semantic !== null) {
    keywordMatch = (1 - SEMANTIC_BLEND) * keywordMatch + SEMANTIC_BLEND * semantic;
  } else {
    semantic = null;
  }

  return { keyword_match: keywordMatch, semantic };
}

export function scoreSkillsAlignment(
  resumeText: string,
  jdText: string,
  bank: SkillBank
): { skills_alignment: number; matched: string[]; missing: string[] } {
  const jdLow = jdText.toLowerCase();
  const resumeLow = resumeText.toLowerCase();
  const jdTrimmed = jdText.trim().length > 0;

  const bankInJd = new Set(
    bank.skills.filter((s) => !jdTrimmed || jdLow.includes(s))
  );
  const jdAcronyms = jdTrimmed ? extractAcronyms(jdText) : new Set<string>();

  let target = new Set<string>([...bankInJd, ...jdAcronyms]);
  if (jdTrimmed && target.size === 0) {
    target = new Set(bank.skills); // never divide by zero (spec §7.2)
  }

  const present = new Set<string>();
  for (const s of bankInJd) {
    if (resumeLow.includes(s)) present.add(s);
  }
  for (const a of jdAcronyms) {
    const wordBoundaryRe = new RegExp(`\\b${escapeRegex(a)}\\b`);
    if (wordBoundaryRe.test(resumeLow)) present.add(a);
  }

  const alignment = target.size > 0 ? present.size / target.size : 0.0;
  const missing = Array.from(target).filter((s) => !present.has(s)).sort();

  return {
    skills_alignment: alignment,
    matched: Array.from(present).sort(),
    missing,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ------------------------------------------------------------------ Stage 4: multiplier + knockouts (§9)

export function detectRecencyMultiplier(
  raw: string,
  jd: string,
  bankSkills: string[]
): number {
  if (!jd.trim()) return 1.0;
  let jdTitle = "";
  for (const line of jd.split("\n")) {
    if (line.trim()) {
      jdTitle = line.trim().toLowerCase();
      break;
    }
  }
  if (!jdTitle) return 1.0;

  const top = raw.split("\n").slice(0, RECENCY_TOP_LINES).join("\n").toLowerCase();
  const bankSkillSet = new Set(bankSkills);
  const keyWords = normalize(jdTitle)
    .filter((w) => !bankSkillSet.has(w))
    .slice(0, 4);

  if (keyWords.length === 0) return 1.0;
  const hits = keyWords.filter((w) => top.includes(w)).length;
  return hits / keyWords.length >= RECENCY_HIT_THRESHOLD ? RECENCY_MULTIPLIER : 1.0;
}

export function findGaps(raw: string): string[] {
  const ranges: [number, number][] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Education context can appear on the same line as the range, or on
    // the immediately adjacent line (degree-title-with-dates followed by
    // institution name, or institution name followed by a dates-only
    // line) — real resumes use both layouts. Check a 1-line lookback and
    // lookahead window so neither ordering false-triggers a gap.
    const prev = i > 0 ? lines[i - 1] : "";
    const next = i < lines.length - 1 ? lines[i + 1] : "";
    if (
      EDUCATION_LINE_RE.test(line) ||
      EDUCATION_LINE_RE.test(prev) ||
      EDUCATION_LINE_RE.test(next)
    ) {
      continue;
    }
    RANGE_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RANGE_PATTERN.exec(line)) !== null) {
      const start = parseInt(m[1], 10);
      const endRaw = m[2].toLowerCase();
      const end = endRaw.includes("present") ? 9999 : parseInt(endRaw, 10);
      ranges.push([start, end]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const flags: string[] = [];
  for (let i = 0; i < ranges.length - 1; i++) {
    const [, e1] = ranges[i];
    const [s2] = ranges[i + 1];
    if (e1 !== 9999 && s2 - e1 > GAP_FLAG_YEARS) {
      // Evidence grade (a): Kristal et al., Nature Human Behaviour (2022),
      // preregistered UK audit (n=9,022). Gaps still reduce callbacks, but
      // the penalty is mitigable — listing years-worked instead of exact
      // dates, or stating a reason, measurably narrows the gap. Framed as
      // advisory rather than a hard disqualifier accordingly.
      flags.push(
        `Possible >${KNOCKOUT_GAP_MONTHS}-month gap between ${e1} and ${s2} -- ` +
          `advisory: employment gaps are shown to reduce callbacks, but the effect is ` +
          `mitigable (e.g. a years-only date format or a brief stated reason measurably ` +
          `narrows the gap in resume-audit research)`
      );
    }
  }
  return flags;
}

// ------------------------------------------------------------------ domain resolution (§2.1)

export function resolveDomain(
  resume: string,
  jd: string,
  banks: SkillBank[],
  forcedDomain?: string
): string {
  if (forcedDomain && banks.some((b) => b.domain === forcedDomain)) {
    return forcedDomain;
  }
  const probeText = jd.trim() ? jd : resume;
  const probeLow = probeText.toLowerCase();
  let best = "generic";
  let bestHits = 0;
  for (const bank of banks) {
    if (bank.detect_terms.length === 0) continue; // generic never auto-wins
    const hits = bank.detect_terms.filter((term) => probeLow.includes(term.toLowerCase())).length;
    if (hits > bestHits) {
      best = bank.domain;
      bestHits = hits;
    }
  }
  return best;
}

// ------------------------------------------------------------------ orchestrator (§10)

export function runScore(
  resumeText: string,
  jdText: string,
  bank: SkillBank,
  options: { semanticSimilarity?: number | null } = {}
): ScoreResult {
  const rTokens = normalize(resumeText);

  const { format_quality, human_scan_flags, human_scan_flags_graded } =
    scoreFormatWithHumanScreening(resumeText);
  const { score: section_structure } = scoreSections(resumeText);

  const { keyword_match, semantic } = scoreKeywordMatch(
    resumeText,
    jdText,
    bank.skills,
    options.semanticSimilarity ?? null
  );

  const { skills_alignment, matched, missing } = scoreSkillsAlignment(
    resumeText,
    jdText,
    bank
  );

  const content_density = scoreDensity(rTokens);
  const recency_multiplier = detectRecencyMultiplier(resumeText, jdText, bank.skills);
  const knockouts = findGaps(resumeText);

  const base =
    WEIGHTS.keyword_match * keyword_match +
    WEIGHTS.skills_alignment * skills_alignment +
    WEIGHTS.format_quality * format_quality +
    WEIGHTS.section_structure * section_structure +
    WEIGHTS.content_density * content_density;

  const final = Math.round(Math.min(1.0, base * recency_multiplier) * 1000) / 10;

  return {
    domain: bank.domain,
    format_quality,
    section_structure,
    keyword_match,
    skills_alignment,
    content_density,
    recency_multiplier,
    knockouts,
    matched_skills: matched,
    missing_skills: missing,
    human_scan_flags,
    human_scan_flags_graded,
    semantic,
    final,
  };
}

export function explain(r: ScoreResult): string {
  const contrib: Record<string, number> = {
    "Keyword match": WEIGHTS.keyword_match * r.keyword_match,
    "Skills alignment": WEIGHTS.skills_alignment * r.skills_alignment,
    "Format quality": WEIGHTS.format_quality * r.format_quality,
    "Section structure": WEIGHTS.section_structure * r.section_structure,
    "Content density": WEIGHTS.content_density * r.content_density,
  };
  const lines = [
    `FINAL SCORE: ${r.final}/100`,
    `Domain: ${r.domain}`,
    `Recency multiplier applied: x${r.recency_multiplier}`,
    "",
    "Contribution breakdown (of 100):",
  ];
  for (const [k, v] of Object.entries(contrib).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${k.padEnd(20)} ${(v * 100).toFixed(1)}`);
  }
  if (r.semantic !== null) lines.push(`\nSemantic similarity: ${r.semantic.toFixed(2)}`);
  if (r.matched_skills.length) {
    lines.push(`\nJD skills matched (${r.matched_skills.length}): ${r.matched_skills.join(", ")}`);
  }
  if (r.missing_skills.length) {
    lines.push(`\nJD skills missing (${r.missing_skills.length}): ${r.missing_skills.join(", ")}`);
  }
  if (r.knockouts.length) {
    lines.push("\nKnockout flags:");
    r.knockouts.forEach((k) => lines.push(`  ! ${k}`));
  }
  if (r.human_scan_flags_graded.length) {
    const gradeLabel: Record<EvidenceGrade, string> = {
      a: "[strong evidence]",
      b: "[vendor/industry study]",
      c: "[advisory heuristic]",
    };
    lines.push("\nHuman-screening flags (graded by evidence strength):");
    r.human_scan_flags_graded.forEach((f) =>
      lines.push(`  ${gradeLabel[f.evidence].padEnd(24)} ${f.message}`)
    );
  }
  return lines.join("\n");
}
