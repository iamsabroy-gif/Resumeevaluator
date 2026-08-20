/**
 * Suggestion state machine (kickoff brief, Step 7).
 *
 *   suggested -> user_responded -> drafted -> accepted
 *                               -> drafted -> edited -> accepted
 *             -> declined
 *
 * The gate is the point of the whole design: nothing is drafted for a gap
 * until the user has said whether they actually have that experience, and the
 * draft is built only from what they wrote. A declined gap is kept and stays
 * visible as an acknowledged gap — it is never silently dropped and never
 * re-prompted.
 */

import { nowIso } from "../domain/ids.js";
import type { ConfidenceLevel, ResumeSuggestion, SuggestionStatus } from "../domain/types.js";
import { suggestions as suggestionRepo } from "../store/repositories.js";
import { getAiProvider } from "../ai/provider.js";
import { validateDraftedBullet } from "../ai/validation.js";

/** Which statuses each status may move to. */
const ALLOWED_TRANSITIONS: Record<SuggestionStatus, SuggestionStatus[]> = {
  suggested: ["user_responded", "declined"],
  user_responded: ["drafted", "declined"],
  drafted: ["edited", "accepted", "declined"],
  edited: ["accepted", "declined"],
  accepted: [],
  declined: [],
};

export class InvalidTransitionError extends Error {
  readonly status = 409;
  constructor(from: SuggestionStatus, to: SuggestionStatus) {
    super(`A suggestion cannot move from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
  }
}

function assertTransition(from: SuggestionStatus, to: SuggestionStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export interface RespondInput {
  confidenceLevel: ConfidenceLevel;
  userInput: string;
}

/**
 * The user answers a card. "no" declines it outright; "yes"/"partial" record
 * the answer and then draft from their words alone.
 */
export async function respondToSuggestion(
  suggestionId: string,
  input: RespondInput
): Promise<ResumeSuggestion> {
  const suggestion = await suggestionRepo.get(suggestionId);

  if (input.confidenceLevel === "no") {
    assertTransition(suggestion.status, "declined");
    return suggestionRepo.update(suggestionId, {
      status: "declined",
      confidenceLevel: "no",
      userInput: input.userInput || null,
      respondedAt: nowIso(),
    });
  }

  assertTransition(suggestion.status, "user_responded");
  const responded = await suggestionRepo.update(suggestionId, {
    status: "user_responded",
    confidenceLevel: input.confidenceLevel,
    userInput: input.userInput,
    respondedAt: nowIso(),
  });

  return draftForSuggestion(responded.id);
}

/**
 * Drafts a bullet for a suggestion the user has already answered. Split out
 * from respondToSuggestion so a failed draft can be retried without making
 * the user answer the card again.
 */
export async function draftForSuggestion(suggestionId: string): Promise<ResumeSuggestion> {
  const suggestion = await suggestionRepo.get(suggestionId);
  if (suggestion.status !== "user_responded") {
    throw new InvalidTransitionError(suggestion.status, "drafted");
  }
  if (!suggestion.confidenceLevel || !suggestion.userInput) {
    throw new Error("Cannot draft before the user has answered this suggestion");
  }

  const provider = getAiProvider();
  let output;
  try {
    output = await provider.draftBullet({
      gapDescription: suggestion.jdEvidence,
      confidenceLevel: suggestion.confidenceLevel,
      userInput: suggestion.userInput,
    });
  } catch (err: any) {
    return suggestionRepo.update(suggestionId, {
      validationError: `Drafting failed: ${err?.message ?? err}`,
    });
  }

  if (output.status === "insufficient") {
    // Stays at user_responded so the user can add detail and retry. A
    // generic placeholder bullet is explicitly not an acceptable output.
    return suggestionRepo.update(suggestionId, {
      draftBullet: null,
      unquantifiedGaps: output.unquantified_gaps,
      validationError:
        "There wasn't enough detail in your description to draft a bullet without " +
        "inventing specifics. Add a little more and try again.",
    });
  }

  const validation = validateDraftedBullet(suggestion.userInput, output.draft_bullet);
  if (!validation.ok) {
    // Rejected, never silently corrected. The draft is withheld and the
    // suggestion is flagged for manual review.
    return suggestionRepo.update(suggestionId, {
      draftBullet: null,
      unquantifiedGaps: output.unquantified_gaps,
      validationError:
        `The generated bullet was rejected because it did not match what you described: ` +
        validation.reasons.join("; "),
    });
  }

  return suggestionRepo.update(suggestionId, {
    status: "drafted",
    draftBullet: output.draft_bullet,
    unquantifiedGaps: output.unquantified_gaps,
    validationError: null,
  });
}

/** The user hand-edits the drafted bullet. Their text is taken as written. */
export async function editDraft(
  suggestionId: string,
  text: string
): Promise<ResumeSuggestion> {
  const suggestion = await suggestionRepo.get(suggestionId);
  assertTransition(suggestion.status, "edited");
  if (!text.trim()) throw new Error("An edited bullet cannot be empty");
  return suggestionRepo.update(suggestionId, {
    status: "edited",
    draftBullet: text.trim(),
    validationError: null,
  });
}

export async function acceptSuggestion(suggestionId: string): Promise<ResumeSuggestion> {
  const suggestion = await suggestionRepo.get(suggestionId);
  assertTransition(suggestion.status, "accepted");
  if (!suggestion.draftBullet) {
    throw new Error("Cannot accept a suggestion that has no drafted bullet");
  }
  return suggestionRepo.update(suggestionId, { status: "accepted" });
}

export async function declineSuggestion(suggestionId: string): Promise<ResumeSuggestion> {
  const suggestion = await suggestionRepo.get(suggestionId);
  assertTransition(suggestion.status, "declined");
  return suggestionRepo.update(suggestionId, {
    status: "declined",
    respondedAt: suggestion.respondedAt ?? nowIso(),
  });
}
