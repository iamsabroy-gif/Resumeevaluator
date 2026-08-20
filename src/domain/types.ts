/**
 * Entity definitions.
 *
 * These mirror the entity set described in the kickoff brief (Step 2). The
 * brief targeted Base44's NoSQL entity editor; here they are plain TypeScript
 * records persisted by the JSON store in src/store. The shapes are
 * deliberately flat and JSON-serialisable so they can be lifted into Base44
 * entities (or any document DB) without restructuring.
 */

import type { EvidenceGrade } from "../engine/ats-scorer.js";

/** Bumped whenever scoring behaviour changes. Stamped on every score record. */
export const ENGINE_VERSION = "v5";

export type FileType = "pdf" | "docx" | "txt";

export type ExtractionConfidence = "high" | "low" | "failed";

/**
 * Scoring mode. The engine takes different paths when a JD is present versus
 * absent (keyword target falls back to the skill bank, recency multiplier is
 * skipped, skills alignment scores against the whole bank). Two scores are
 * only comparable when mode matches, so it is stamped on every record.
 */
export type ScoreMode = "jd_targeted" | "generic";

export interface Resume {
  id: string;
  userId: string;
  originalFileUrl: string;
  fileName: string;
  fileType: FileType;
  rawText: string;
  extractionConfidence: ExtractionConfidence;
  extractionNotes: string[];
  bulletIds: string[];
  createdAt: string;
}

export interface Bullet {
  id: string;
  resumeId: string;
  /** Section/role heading the bullet sits under, when one could be inferred. */
  roleId: string | null;
  originalText: string;
  /** Position within the resume, 0-based, in document order. */
  order: number;
  /** Line index in the source rawText, for round-tripping edits. */
  sourceLine: number;
}

export interface JobDescription {
  id: string;
  userId: string;
  rawText: string;
  title: string;
  pastedAt: string;
}

export interface SkillBankRecord {
  id: string;
  domain: string;
  display_name: string;
  detect_terms: string[];
  skill_groups: Record<string, string[]>;
  skills: string[];
}

export interface GradedFlag {
  message: string;
  evidence: EvidenceGrade;
  checkId: string;
}

/**
 * Persisted score. Carries the five signal scores plus the four
 * comparability keys (engineVersion, domain, mode, semanticAvailable) that
 * the spec requires be held constant for two scores to be compared.
 */
export interface ScoreResultRecord {
  id: string;
  resumeId: string;
  jdId: string | null;
  /** Set when this score is a re-score of a draft rather than the original. */
  draftId: string | null;
  domain: string;
  mode: ScoreMode;
  semanticAvailable: boolean;
  engineVersion: string;

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
  human_scan_flags_graded: GradedFlag[];
  semantic: number | null;
  final: number;
  createdAt: string;
}

export type GapType = "skill" | "metric" | "governance" | "phrasing";

export type SuggestionStatus =
  | "suggested"
  | "user_responded"
  | "drafted"
  | "edited"
  | "accepted"
  | "declined";

export type ConfidenceLevel = "yes" | "partial" | "no";

export interface ResumeSuggestion {
  id: string;
  scoreResultId: string;
  resumeId: string;
  gapType: GapType;
  /** What in the JD (or which engine flag) motivated this suggestion. */
  jdEvidence: string;
  /** Stable id of the engine check behind this card, when it came from one. */
  checkId: string | null;
  evidence: EvidenceGrade | null;
  targetBulletId: string | null;
  status: SuggestionStatus;
  confidenceLevel: ConfidenceLevel | null;
  userInput: string | null;
  draftBullet: string | null;
  unquantifiedGaps: string[];
  /** Populated when the code-side validation layer rejected an AI draft. */
  validationError: string | null;
  createdAt: string;
  respondedAt: string | null;
}

export interface DraftBulletEntry {
  bulletId: string | null;
  originalText: string | null;
  finalText: string;
  /** Where this line came from, for the before/after view. */
  origin: "unchanged" | "auto_edit" | "suggestion";
  suggestionId: string | null;
  changesMade: string[];
}

export interface ResumeDraft {
  id: string;
  resumeId: string;
  version: number;
  bullets: DraftBulletEntry[];
  /** Full reconstructed resume text, used for re-scoring. */
  rawText: string;
  sourceScoreResultId: string;
  rescoreResultId: string | null;
  createdAt: string;
}
