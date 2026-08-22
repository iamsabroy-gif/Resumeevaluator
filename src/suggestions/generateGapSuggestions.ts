/**
 * Gap suggestion generation (kickoff brief, Step 5).
 *
 * Reads `missing_skills` and `human_scan_flags` off a persisted score and
 * turns them into actionable cards. No AI call happens here — this is purely
 * structuring the gap report. Drafting is a separate, user-gated step.
 */

import { newId, nowIso } from "../domain/ids.js";
import type {
  Bullet,
  GapType,
  ResumeSuggestion,
  ScoreResultRecord,
} from "../domain/types.js";
import {
  bulletsForResume,
  jobDescriptions,
  scoreResults,
  suggestions as suggestionRepo,
} from "../store/repositories.js";

/** How many missing-skill cards to raise at most, highest-signal first. */
export const MAX_SKILL_CARDS = 12;
/** How many "this bullet has no number in it" cards to raise at most. */
export const MAX_METRIC_CARDS = 5;

/**
 * Which gap type each engine check maps to. Checks absent from this map fall
 * back to "phrasing".
 */
const CHECK_GAP_TYPE: Record<string, GapType> = {
  spelling_consistency: "phrasing",
  weak_openers: "phrasing",
  bullet_length: "phrasing",
  scan_zone: "governance",
  closing_section: "governance",
  table_or_tab_format: "governance",
  graphic_bullets: "governance",
  header_footer_noise: "governance",
};

function hasMetric(text: string): boolean {
  // A number, a percentage, a currency amount, or a written scale word.
  return /\d/.test(text) || /\b(?:doubled|tripled|halved)\b/i.test(text);
}

/**
 * Ranks missing skills by how prominent they are in the JD. A term the JD
 * repeats is a term the recruiter cares about; a term mentioned once in a
 * "nice to have" list is not worth a card ahead of it.
 */
function rankMissingSkills(missing: string[], jdText: string): string[] {
  const jdLow = jdText.toLowerCase();
  const scored = missing.map((skill) => {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hits = (jdLow.match(new RegExp(escaped, "g")) ?? []).length;
    return { skill, hits };
  });
  scored.sort((a, b) => b.hits - a.hits || a.skill.localeCompare(b.skill));
  return scored.map((s) => s.skill);
}

function makeSuggestion(
  score: ScoreResultRecord,
  fields: Partial<ResumeSuggestion> & { gapType: GapType; jdEvidence: string; missingSkill?: string | null }
): ResumeSuggestion {
  return {
    id: newId("sug"),
    scoreResultId: score.id,
    resumeId: score.resumeId,
    gapType: fields.gapType,
    jdEvidence: fields.jdEvidence,
    checkId: fields.checkId ?? null,
    evidence: fields.evidence ?? null,
    targetBulletId: fields.targetBulletId ?? null,
    status: "suggested",
    confidenceLevel: null,
    userInput: null,
    draftBullet: null,
    unquantifiedGaps: [],
    validationError: null,
    missingSkill: fields.missingSkill ?? null,
    studyLinks: null,
    createdAt: nowIso(),
    respondedAt: null,
  };
}

/**
 * A stable key for "the same gap", used to avoid re-raising something the
 * user already declined on an earlier score of the same resume. The brief is
 * explicit that a declined gap stays visible as an acknowledged gap but must
 * not be re-prompted.
 */
export function gapKey(s: Pick<ResumeSuggestion, "gapType" | "jdEvidence" | "checkId">): string {
  return `${s.gapType}::${s.checkId ?? ""}::${s.jdEvidence.slice(0, 120)}`;
}

export async function generateGapSuggestions(
  scoreResultId: string
): Promise<ResumeSuggestion[]> {
  const score = await scoreResults.get(scoreResultId);

  // Idempotent: calling twice for the same score returns what already exists
  // rather than doubling every card.
  const existing = await suggestionRepo.filter((s) => s.scoreResultId === scoreResultId);
  if (existing.length > 0) {
    return existing.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // Gaps the user has already said "no" to, on any earlier score of this
  // resume. Those stay on the record but are not put back in front of them.
  const priorForResume = await suggestionRepo.filter(
    (s) => s.resumeId === score.resumeId && s.status === "declined"
  );
  const declinedKeys = new Set(priorForResume.map(gapKey));

  const jd = score.jdId ? await jobDescriptions.find(score.jdId) : null;
  const jdText = jd?.rawText ?? "";
  const bullets = await bulletsForResume(score.resumeId);

  const drafted: ResumeSuggestion[] = [];

  // 1. Missing skills the JD asked for.
  const ranked = rankMissingSkills(score.missing_skills, jdText).slice(0, MAX_SKILL_CARDS);
  for (const skill of ranked) {
    drafted.push(
      makeSuggestion(score, {
        gapType: "skill",
        checkId: "keyword_coverage",
        evidence: "b",
        missingSkill: skill,
        jdEvidence: jd
          ? `The job description asks for "${skill}", which doesn't appear anywhere in your resume.`
          : `"${skill}" is a core skill for the ${score.domain} domain and doesn't appear in your resume.`,
      })
    );
  }

  // 2. Engine flags, carrying their evidence grade through to the card so the
  // UI can show the user how well-supported each one is.
  for (const flag of score.human_scan_flags_graded) {
    drafted.push(
      makeSuggestion(score, {
        gapType: CHECK_GAP_TYPE[flag.checkId] ?? "phrasing",
        checkId: flag.checkId,
        evidence: flag.evidence,
        jdEvidence: flag.message,
      })
    );
  }

  // 3. Employment-gap knockouts.
  for (const knockout of score.knockouts) {
    drafted.push(
      makeSuggestion(score, {
        gapType: "governance",
        checkId: "employment_gap",
        evidence: "a",
        jdEvidence: knockout,
      })
    );
  }

  // 4. Bullets carrying no quantification at all. These are the cards most
  // likely to produce a genuinely better resume, and the ones where the AI
  // must not invent the number itself — hence the human-in-the-loop gate.
  const unquantified = bullets.filter((b: Bullet) => !hasMetric(b.originalText));
  for (const bullet of unquantified.slice(0, MAX_METRIC_CARDS)) {
    drafted.push(
      makeSuggestion(score, {
        gapType: "metric",
        checkId: null,
        evidence: null,
        targetBulletId: bullet.id,
        jdEvidence:
          `This bullet states what you did but not at what scale or to what effect: ` +
          `"${bullet.originalText.slice(0, 120)}". A number here is one of the few ` +
          `changes that reliably shifts a human reader.`,
      })
    );
  }

  const fresh = drafted.filter((s) => !declinedKeys.has(gapKey(s)));
  for (const s of fresh) {
    await suggestionRepo.insert(s);
  }
  return fresh;
}
