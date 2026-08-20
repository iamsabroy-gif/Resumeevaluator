/**
 * The two drafting prompts (kickoff brief, Step 6).
 *
 * They are kept verbatim from the brief and separated deliberately, because
 * they carry different risk profiles: the auto-edit prompt may only rephrase
 * facts already on the page, while the gated prompt may only use what the
 * user just told us. Neither is ever allowed to invent.
 *
 * Both are backed by the code-side checks in validation.ts. The prompt is the
 * first line of defence, not the only one.
 */

export const AUTO_EDIT_SYSTEM = `You may ONLY rephrase, reorder, or add JD-matching terminology for facts
already stated in the ORIGINAL BULLET. You must NOT add any metric, scope,
tool, outcome, or claim not already present in the original text. If the
JD uses a synonym for something the bullet already says, prefer the JD's
exact term. Do not change any number, date, percentage, or named entity.`;

export const GATED_DRAFT_SYSTEM = `Draft ONE new resume bullet based ONLY on the user's own description below.
Do not add any detail, metric, tool, or outcome the user did not state.
If confidence_level is "partial", hedge appropriately (e.g. "contributed
to" rather than "owned"). If the user's input is insufficient, return
status "insufficient" with no bullet — never draft a generic placeholder.`;

export function autoEditUserMessage(params: {
  originalBullet: string;
  jdText: string;
  targetTerms: string[];
}): string {
  const jdBlock = params.jdText.trim()
    ? `JOB DESCRIPTION:\n${params.jdText.slice(0, 6000)}`
    : `JOB DESCRIPTION:\n(none provided — do not introduce terminology from outside the original bullet)`;
  const terms = params.targetTerms.length
    ? `\n\nTERMS THE JOB DESCRIPTION USES (prefer these wordings only where the bullet already expresses the same thing):\n${params.targetTerms.join(", ")}`
    : "";
  return `${jdBlock}\n\nORIGINAL BULLET:\n${params.originalBullet}${terms}`;
}

export function gatedDraftUserMessage(params: {
  gapDescription: string;
  confidenceLevel: string;
  userInput: string;
}): string {
  return [
    `GAP BEING ADDRESSED:`,
    params.gapDescription,
    ``,
    `CONFIDENCE_LEVEL: ${params.confidenceLevel}`,
    ``,
    `USER'S OWN DESCRIPTION OF THEIR EXPERIENCE:`,
    params.userInput,
  ].join("\n");
}
