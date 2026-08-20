/**
 * Optional semantic-similarity layer (spec §7.3).
 *
 * The engine accepts a similarity in [0,1] and blends it into keyword_match;
 * when none is supplied it falls back cleanly and reports `semantic: null`.
 * No embedding model is wired up here, so the default provider returns null
 * and the whole system runs deterministically offline.
 *
 * `semanticAvailable` is recorded on every score record because a score with
 * the semantic layer on is not comparable to one with it off — swapping this
 * provider for a real embedding model changes what the numbers mean, and the
 * stamp is what lets the UI refuse to diff across that change.
 */

export interface SemanticProvider {
  readonly name: string;
  /** Returns a similarity in [0,1], or null when unavailable. */
  similarity(resumeText: string, jdText: string): Promise<number | null>;
}

export const nullSemanticProvider: SemanticProvider = {
  name: "none",
  async similarity() {
    return null;
  },
};

let active: SemanticProvider = nullSemanticProvider;

export function setSemanticProvider(provider: SemanticProvider): void {
  active = provider;
}

export function getSemanticProvider(): SemanticProvider {
  return active;
}
