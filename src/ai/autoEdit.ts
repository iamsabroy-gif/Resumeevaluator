/**
 * Auto-edit pass: rephrasing only, no new claims.
 *
 * Safe to apply without a confirmation gate, but still surfaced as a
 * before/after so the user sees every change. Anything the validation layer
 * rejects is dropped rather than applied — a failed auto-edit leaves the
 * original bullet untouched and says why.
 */

import type { Bullet } from "../domain/types.js";
import { bulletsForResume } from "../store/repositories.js";
import { getAiProvider } from "./provider.js";
import { validateAutoEdit } from "./validation.js";

export interface AutoEditProposal {
  bulletId: string;
  originalText: string;
  revisedText: string;
  changesMade: string[];
  /** True when the model itself asked for a human look. */
  flaggedForReview: boolean;
  /** True when the change passed validation and may be applied. */
  applied: boolean;
  rejectionReasons: string[];
}

export async function autoEditBullet(
  bullet: Bullet,
  jdText: string,
  targetTerms: string[]
): Promise<AutoEditProposal> {
  const provider = getAiProvider();

  let output;
  try {
    output = await provider.autoEdit({
      originalBullet: bullet.originalText,
      jdText,
      targetTerms,
    });
  } catch (err: any) {
    return {
      bulletId: bullet.id,
      originalText: bullet.originalText,
      revisedText: bullet.originalText,
      changesMade: [],
      flaggedForReview: true,
      applied: false,
      rejectionReasons: [`Drafting failed: ${err?.message ?? err}`],
    };
  }

  const revised = output.revised_bullet.trim();
  const validation = validateAutoEdit(bullet.originalText, revised);
  const unchanged = revised === bullet.originalText.trim();

  return {
    bulletId: bullet.id,
    originalText: bullet.originalText,
    revisedText: validation.ok ? revised : bullet.originalText,
    changesMade: validation.ok ? output.changes_made : [],
    flaggedForReview: output.flagged_for_review || !validation.ok,
    applied: validation.ok && !unchanged,
    rejectionReasons: validation.reasons,
  };
}

export async function autoEditResume(
  resumeId: string,
  jdText: string,
  targetTerms: string[]
): Promise<AutoEditProposal[]> {
  const bullets = await bulletsForResume(resumeId);
  const out: AutoEditProposal[] = [];
  for (const bullet of bullets) {
    out.push(await autoEditBullet(bullet, jdText, targetTerms));
  }
  return out;
}
