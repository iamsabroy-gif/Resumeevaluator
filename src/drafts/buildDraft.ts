/**
 * Draft assembly and re-scoring (kickoff brief, Step 8).
 *
 * Merges the auto-edit pass and every accepted suggestion into a new
 * ResumeDraft, then re-scores it so the user sees a concrete v1 -> v2 delta
 * driven by their own input rather than a cosmetic rewrite.
 */

import { newId, nowIso } from "../domain/ids.js";
import type { DraftBulletEntry, ResumeDraft } from "../domain/types.js";
import {
  bulletsForResume,
  draftsForResume,
  drafts as draftRepo,
  jobDescriptions,
  resumes,
  scoreResults,
  suggestionsForScore,
} from "../store/repositories.js";
import { autoEditResume } from "../ai/autoEdit.js";
import type { AutoEditProposal } from "../ai/autoEdit.js";
import { runScore } from "../scoring/runScore.js";
import type { ScoreOutcome } from "../scoring/runScore.js";
import { BULLET_LINE_RE } from "../ingestion/parseBullets.js";

/** Pulls "  - " off the front of a bullet line so a rewrite keeps its marker. */
function bulletPrefix(line: string): string {
  const match = line.match(/^(\s*[-•*·]\s+)/);
  return match ? match[1] : "- ";
}

export interface BuildDraftResult {
  draft: ResumeDraft;
  autoEdits: AutoEditProposal[];
  /** Auto-edits that failed validation and were therefore not applied. */
  rejectedAutoEdits: AutoEditProposal[];
}

export async function buildDraft(
  resumeId: string,
  scoreResultId: string
): Promise<BuildDraftResult> {
  const resume = await resumes.get(resumeId);
  const score = await scoreResults.get(scoreResultId);
  const bullets = await bulletsForResume(resumeId);
  const allSuggestions = await suggestionsForScore(scoreResultId);
  const accepted = allSuggestions.filter((s) => s.status === "accepted" && s.draftBullet);

  const jd = score.jdId ? await jobDescriptions.find(score.jdId) : null;
  const jdText = jd?.rawText ?? "";

  // Terms worth aligning to: what the JD asked for and the resume already
  // matched. Missing skills are deliberately excluded — the auto-edit pass
  // must not be handed a vocabulary of things the user never claimed.
  const targetTerms = score.matched_skills.slice(0, 20);

  const autoEdits = await autoEditResume(resumeId, jdText, targetTerms);
  const applied = new Map(
    autoEdits.filter((p) => p.applied).map((p) => [p.bulletId, p])
  );

  const lines = resume.rawText.split("\n");
  const bulletById = new Map(bullets.map((b) => [b.id, b]));

  // Rewrite edited bullets in place, keeping their original marker so the
  // reconstructed text still parses as bullets on the re-score.
  for (const [bulletId, proposal] of applied) {
    const bullet = bulletById.get(bulletId);
    if (!bullet) continue;
    const line = lines[bullet.sourceLine];
    if (line === undefined || !BULLET_LINE_RE.test(line)) continue;
    lines[bullet.sourceLine] = `${bulletPrefix(line)}${proposal.revisedText}`;
  }

  // New bullets from accepted suggestions go after the bullet they relate to,
  // or after the last bullet in the resume when they relate to none.
  const lastBulletLine = bullets.length
    ? Math.max(...bullets.map((b) => b.sourceLine))
    : lines.length - 1;
  const insertions = new Map<number, string[]>();
  for (const suggestion of accepted) {
    const target = suggestion.targetBulletId
      ? bulletById.get(suggestion.targetBulletId)
      : undefined;
    const at = target ? target.sourceLine : lastBulletLine;
    const anchorLine = lines[at] ?? "";
    const prefix = BULLET_LINE_RE.test(anchorLine) ? bulletPrefix(anchorLine) : "- ";
    const list = insertions.get(at) ?? [];
    list.push(`${prefix}${suggestion.draftBullet!.trim()}`);
    insertions.set(at, list);
  }

  const rebuilt: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    rebuilt.push(lines[i]);
    const extra = insertions.get(i);
    if (extra) rebuilt.push(...extra);
  }
  const rawText = rebuilt.join("\n");

  // Snapshot, in reading order, with provenance for the before/after view.
  const entries: DraftBulletEntry[] = [];
  for (const bullet of bullets) {
    const proposal = applied.get(bullet.id);
    entries.push({
      bulletId: bullet.id,
      originalText: bullet.originalText,
      finalText: proposal ? proposal.revisedText : bullet.originalText,
      origin: proposal ? "auto_edit" : "unchanged",
      suggestionId: null,
      changesMade: proposal ? proposal.changesMade : [],
    });
  }
  for (const suggestion of accepted) {
    entries.push({
      bulletId: null,
      originalText: null,
      finalText: suggestion.draftBullet!.trim(),
      origin: "suggestion",
      suggestionId: suggestion.id,
      changesMade: [`Added from your answer to a ${suggestion.gapType} gap`],
    });
  }

  const existing = await draftsForResume(resumeId);
  const draft: ResumeDraft = {
    id: newId("drf"),
    resumeId,
    version: existing.length + 2, // the original resume is version 1
    bullets: entries,
    rawText,
    sourceScoreResultId: scoreResultId,
    rescoreResultId: null,
    createdAt: nowIso(),
  };
  await draftRepo.insert(draft);

  return {
    draft,
    autoEdits,
    rejectedAutoEdits: autoEdits.filter((p) => p.rejectionReasons.length > 0),
  };
}

/**
 * Re-scores a draft. The JD defaults to whichever one the source score used,
 * because scoring a draft against a different JD produces a delta that says
 * nothing about whether the rewrite helped.
 */
export async function rescoreDraft(
  draftId: string,
  jdId?: string | null
): Promise<{ draft: ResumeDraft; outcome: ScoreOutcome }> {
  const draft = await draftRepo.get(draftId);
  const sourceScore = await scoreResults.get(draft.sourceScoreResultId);
  const effectiveJdId = jdId === undefined ? sourceScore.jdId : jdId;

  const outcome = await runScore(draft.resumeId, effectiveJdId, {
    textOverride: draft.rawText,
    draftId: draft.id,
    // Pin the domain to the source score's. A rewrite can shift automatic
    // domain detection, and a score computed against a different skill bank
    // is not comparable to the one it is being diffed against.
    forcedDomain: sourceScore.domain,
  });

  const updated = await draftRepo.update(draftId, { rescoreResultId: outcome.record.id });
  return { draft: updated, outcome };
}
