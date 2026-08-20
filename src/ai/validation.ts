/**
 * Anti-fabrication validation (kickoff brief, Step 6).
 *
 * This is the safety net that does not depend on the model behaving. The
 * prompts instruct the model not to invent facts; this layer checks that it
 * didn't, and rejects the output when it did. A prompt is a request, and the
 * whole point of the human-in-the-loop design is that an invented metric on
 * someone's resume is a real harm to them in an interview — so the rule is
 * enforced where it cannot be talked out of.
 *
 * On failure the caller re-flags for manual review. Nothing here silently
 * "corrects" a fabricated number.
 */

/** How much longer than the original an auto-edit may be. */
export const MAX_LENGTH_RATIO = 1.5;
/**
 * Absolute slack added to the ratio limit. On a 20-character bullet, 1.5x is
 * 10 characters of headroom, which a legitimate reword ("Handled X" ->
 * "Owned end-to-end X") blows through without adding any claim. The ratio is
 * the real guard on long bullets; this stops it firing spuriously on short
 * ones.
 */
export const LENGTH_SLACK_CHARS = 25;

/**
 * Pulls the numeric claims out of a string in a comparable, normalised form.
 *
 * Normalisation matters more than it looks. "$1,200,000", "1200000" and
 * "1.2M" are the same claim written three ways, and a naive extractor would
 * treat a rewrite between them as a fabricated number and reject a perfectly
 * good edit. Conversely "30%" and "3%" must never compare equal.
 *
 * Returns canonical decimal strings, so 1.2M -> "1200000" and 30% -> "30".
 */
export function extractNumbers(text: string): string[] {
  const out: string[] = [];
  // Number, optional thousands separators, optional decimal, optional
  // magnitude suffix. The suffix alternation is ordered longest-first and
  // guarded by a negative lookahead for a following letter — without that,
  // "5 members" parses as 5 million and "3 keys" as 3,000.
  const re =
    /(\d[\d,]*(?:\.\d+)?)(?:\s*(million|billion|thousand|crore|lakh|mm|bn|k|m|b)(?![a-zA-Z]))?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const digits = match[1].replace(/,/g, "");
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const suffix = (match[2] ?? "").toLowerCase();
    const multiplier: Record<string, number> = {
      k: 1e3,
      thousand: 1e3,
      m: 1e6,
      mm: 1e6,
      million: 1e6,
      b: 1e9,
      bn: 1e9,
      billion: 1e9,
      lakh: 1e5,
      crore: 1e7,
    };
    if (suffix && multiplier[suffix]) value *= multiplier[suffix];
    // Canonical form: strip trailing zeros from the decimal part so
    // "5.0" and "5" compare equal.
    out.push(String(value));
  }
  return out;
}

/** Multiset difference: entries in `a` not covered by `b`, counting repeats. */
function missingFrom(a: string[], b: string[]): string[] {
  const pool = [...b];
  const missing: string[] = [];
  for (const item of a) {
    const idx = pool.indexOf(item);
    if (idx === -1) missing.push(item);
    else pool.splice(idx, 1);
  }
  return missing;
}

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

/**
 * Auto-edit rule: rephrasing only. Any number in the revision must already
 * have been in the original, and the revision must not balloon in length.
 *
 * Dropped numbers are also rejected. The prompt says not to change any
 * number, and a rewrite that quietly deletes "reduced costs by 30%" has
 * changed the claim just as surely as one that invents it — it just fails in
 * the direction that makes the resume weaker instead of false.
 */
export function validateAutoEdit(original: string, revised: string): ValidationResult {
  const reasons: string[] = [];
  const origNumbers = extractNumbers(original);
  const revNumbers = extractNumbers(revised);

  const invented = missingFrom(revNumbers, origNumbers);
  if (invented.length) {
    reasons.push(
      `Revision introduces ${invented.length} number(s) not present in the original: ${invented.join(", ")}`
    );
  }

  const dropped = missingFrom(origNumbers, revNumbers);
  if (dropped.length) {
    reasons.push(
      `Revision drops ${dropped.length} number(s) that were in the original: ${dropped.join(", ")}`
    );
  }

  const lengthLimit = original.length * MAX_LENGTH_RATIO + LENGTH_SLACK_CHARS;
  if (revised.length > lengthLimit) {
    reasons.push(
      `Revision is ${(revised.length / original.length).toFixed(2)}x the original length ` +
        `(limit ${MAX_LENGTH_RATIO}x plus ${LENGTH_SLACK_CHARS} characters) — ` +
        `rephrasing should not add material`
    );
  }

  if (!revised.trim()) {
    reasons.push("Revision is empty");
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Gated-draft rule: every number in the draft must come from what the user
 * actually told us. The user's own input is the only permitted source of
 * fact for a bullet describing experience the resume didn't contain.
 */
export function validateDraftedBullet(userInput: string, draft: string): ValidationResult {
  const reasons: string[] = [];
  const inputNumbers = extractNumbers(userInput);
  const draftNumbers = extractNumbers(draft);

  const invented = missingFrom(draftNumbers, inputNumbers);
  if (invented.length) {
    reasons.push(
      `Draft contains ${invented.length} number(s) the user never stated: ${invented.join(", ")}`
    );
  }

  if (!draft.trim()) {
    reasons.push("Draft is empty");
  }

  return { ok: reasons.length === 0, reasons };
}
