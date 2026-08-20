/**
 * Scoring orchestration (kickoff brief, Step 4).
 *
 * Thin wrapper over the engine: load entities, resolve the domain, call the
 * pure scoring function, persist the result stamped with the four
 * comparability keys, return it.
 *
 * All scoring logic lives in src/engine/ats-scorer.ts and nothing here
 * duplicates or second-guesses it — that file is the verified artefact and
 * stays importable into Base44 unmodified.
 */

import {
  resolveDomain,
  runScore as runEngineScore,
  explain as explainEngineResult,
} from "../engine/ats-scorer.js";
import type { ScoreResult as EngineScoreResult } from "../engine/ats-scorer.js";
import { newId, nowIso } from "../domain/ids.js";
import { ENGINE_VERSION } from "../domain/types.js";
import type { ScoreMode, ScoreResultRecord } from "../domain/types.js";
import { jobDescriptions, resumes, scoreResults } from "../store/repositories.js";
import { SKILL_BANKS, bankByDomain } from "./skillBanks.js";
import { getSemanticProvider } from "./semantic.js";

export interface RunScoreOptions {
  forcedDomain?: string;
  /**
   * Score this text instead of the resume's stored rawText. Used when
   * re-scoring a draft, so the draft's score record still hangs off the
   * original resume and the two are directly comparable.
   */
  textOverride?: string;
  draftId?: string;
}

export interface ScoreOutcome {
  record: ScoreResultRecord;
  engine: EngineScoreResult;
  explanation: string;
}

export async function runScore(
  resumeId: string,
  jdId?: string | null,
  options: RunScoreOptions = {}
): Promise<ScoreOutcome> {
  const resume = await resumes.get(resumeId);
  const jd = jdId ? await jobDescriptions.get(jdId) : null;

  const resumeText = options.textOverride ?? resume.rawText;
  const jdText = jd?.rawText ?? "";
  const mode: ScoreMode = jdText.trim() ? "jd_targeted" : "generic";

  const domain = resolveDomain(resumeText, jdText, SKILL_BANKS, options.forcedDomain);
  const bank = bankByDomain(domain);

  // Semantic similarity only means anything against a real JD; with no JD the
  // engine ignores it anyway (§7.3), so don't spend a provider call on it.
  const provider = getSemanticProvider();
  const semanticSimilarity =
    mode === "jd_targeted" ? await provider.similarity(resumeText, jdText) : null;

  const engine = runEngineScore(resumeText, jdText, bank, { semanticSimilarity });

  const record: ScoreResultRecord = {
    id: newId("scr"),
    resumeId,
    jdId: jd?.id ?? null,
    draftId: options.draftId ?? null,
    domain: engine.domain,
    mode,
    semanticAvailable: engine.semantic !== null,
    engineVersion: ENGINE_VERSION,

    format_quality: engine.format_quality,
    section_structure: engine.section_structure,
    keyword_match: engine.keyword_match,
    skills_alignment: engine.skills_alignment,
    content_density: engine.content_density,

    recency_multiplier: engine.recency_multiplier,
    knockouts: engine.knockouts,
    matched_skills: engine.matched_skills,
    missing_skills: engine.missing_skills,
    human_scan_flags: engine.human_scan_flags,
    human_scan_flags_graded: engine.human_scan_flags_graded,
    semantic: engine.semantic,
    final: engine.final,
    createdAt: nowIso(),
  };

  await scoreResults.insert(record);

  return { record, engine, explanation: explainEngineResult(engine) };
}

/**
 * Whether two score records can be meaningfully diffed. The spec requires
 * engineVersion, domain, mode and semanticAvailable to be held constant; if
 * any of them moved, the delta between the two numbers is not attributable to
 * the resume changing.
 */
export function comparabilityIssues(
  a: ScoreResultRecord,
  b: ScoreResultRecord
): string[] {
  const issues: string[] = [];
  if (a.engineVersion !== b.engineVersion) {
    issues.push(`scoring engine changed (${a.engineVersion} to ${b.engineVersion})`);
  }
  if (a.domain !== b.domain) {
    issues.push(`skill domain changed (${a.domain} to ${b.domain})`);
  }
  if (a.mode !== b.mode) {
    issues.push(`scoring mode changed (${a.mode} to ${b.mode})`);
  }
  if (a.semanticAvailable !== b.semanticAvailable) {
    issues.push("semantic similarity layer was available for only one of the two scores");
  }
  return issues;
}
