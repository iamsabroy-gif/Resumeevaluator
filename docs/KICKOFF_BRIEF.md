# ATS Resume Scoring & Rewriting App — Claude Code Kickoff Brief

## What this is
A Base44 app: users upload a resume (PDF/DOCX), paste a job description, get
an ATS-style score with a full breakdown, and can accept AI-drafted resume
improvements — with a human-in-the-loop gate on anything the AI can't verify
from the source resume alone.

## Status
- **Scoring engine: DONE and verified — now v5, evidence-weighted.**
  `ats-scorer.ts` is a complete, tested TypeScript port of the scoring
  spec, updated per "Resume-Screening Heuristics: Evidence-Weighted
  Review (2023-2026)". 28/28 tests passing across two suites:
  - `acceptance-tests.ts` — the original spec §12's 11 test vectors
  - `evidence-weighting-tests.ts` — new tests covering the v5 changes
  - `smoke-test.ts` — real-world sanity check, updated to show graded
    output

  **What changed in v5:**
  - **Added spelling/typo detection** (was entirely absent). This is now
    the highest-evidence check in the engine, anchored to Sterkens et
    al., PLOS ONE (2023) — 445 recruiters, 1,335 resumes, showing
    measurable interview-probability drops per error. Dependency-free
    heuristic: triple-repeated-letter detection, a curated common-
    misspellings list (extensible via `mergeCommonMisspellings()`), and
    bullet-scoped spacing-artifact detection. Penalty capped at 0.20 —
    the largest single-check cap in the engine, reflecting the strength
    of the underlying evidence.
  - **Downweighted the weak-verb-opener penalty** (0.15 → 0.06 cap). The
    "140% more interviews" claim behind this advice traces to a single
    unreplicated 2018 vendor blog post, not a rigorous study.
  - **Downweighted scan-zone and closing-section penalties.** Both derive
    from the same single small, non-peer-reviewed vendor eye-tracking
    study (TheLadders, n=30). The underlying mechanism (top-third
    placement matters) is well-corroborated by independent primacy/
    top-left-scanning research, but the specific thresholds are not.
  - **Softened employment-gap flag language** from an implied hard
    disqualifier to advisory/mitigable framing, per Kristal et al.,
    Nature Human Behaviour (2022) — a preregistered UK audit (n=9,022)
    showing the gap penalty is real but narrows substantially with a
    years-only date format or a stated reason.
  - **Removed the literal "7.4-second skim" claim** from all user-facing
    flag text — it's a metaphor for "the first pass is fast," not a
    measured constant, per the same single vendor study above.
  - **Added evidence grading** — every `ScoreResult.human_scan_flags_graded`
    entry now carries `evidence: "a" | "b" | "c"` (rigorous academic /
    large-sample vendor / advisory heuristic) and a stable `checkId`, so
    the frontend can visually distinguish well-evidenced findings from
    softer heuristics rather than presenting all flags with equal
    authority. `EVIDENCE_GRADE` exports the full check→grade map.

  Drop `ats-scorer.ts` into `base44/functions/shared/` unmodified — still
  zero Base44-specific imports.
- **Everything else: not built yet.** Ingestion, entities, backend
  function wiring, the rewriter, and the frontend all need scaffolding.

## Step 1 — Project setup
```bash
npm install -g base44@latest
base44 login
base44 create   # or open an existing project
```
Confirm the project has `base44/functions/` and a shared-code path. Copy
`ats-scorer.ts` in as-is. Run `npx tsx acceptance-tests.ts` inside the new
project once wired in, to confirm the port still passes after any path/import
adjustments Base44's structure requires.

## Step 2 — Entities
Define these (Base44's schema is flexible/NoSQL — exact field types are a
starting point, adjust as the editor's entity UI requires):

- **Resume** — id, userId, originalFileUrl, fileType (pdf/docx), rawText,
  extractionConfidence (high/low/failed), bullets[], createdAt
- **Bullet** — id, resumeId, roleId, originalText, order
- **JobDescription** — id, userId, rawText, pastedAt
- **SkillBank** — domain, display_name, detect_terms[], skill_groups,
  skills[] — seed from the project's existing 15 domain skill banks
  (payments bank is the reference/most-developed one)
- **ScoreResult** — resumeId, jdId (nullable), domain, mode, semanticAvailable,
  engineVersion, all 5 signal scores, recency_multiplier, knockouts[],
  matched_skills[], missing_skills[], human_scan_flags[], semantic
  (nullable), final, createdAt — **store engineVersion/domain/mode/
  semanticAvailable on every record**; the spec requires these four held
  constant for scores to be comparable
- **ResumeSuggestion** — scoreResultId, gapType (skill/metric/governance/
  phrasing), jdEvidence, targetBulletId (nullable), status (suggested →
  user_responded → drafted → accepted/declined), confidenceLevel
  (yes/partial/no), userInput, draftBullet, unquantifiedGaps[], createdAt,
  respondedAt
- **ResumeDraft** — resumeId, version, bullets[] (snapshot), sourceScoreResultId,
  rescoreResultId (nullable), createdAt

## Step 3 — Ingestion function
`extractResumeText(fileUrl, fileType)`:
- DOCX → `mammoth` (npm, ESM, Deno-compatible)
- PDF → `pdf-parse` or equivalent; text-layer only, no OCR
- Return `{ rawText, confidence }` — flag `low`/`failed` on very low token
  count or high garbled-character ratio so the UI can warn the user before
  they trust a score built on bad extraction
- This is the highest real-world failure risk in the whole system — budget
  time here, test against actual multi-column/table/graphic resumes, not
  just clean ones

## Step 4 — Scoring functions
Thin wrappers around `ats-scorer.ts`'s exported functions, orchestrated by
one `runScore(resumeId, jdId?, forcedDomain?)` function that:
1. Loads resume + JD text from entities
2. Resolves domain via `resolveDomain()`
3. Calls `runScore()` from the shared module
4. Persists a `ScoreResult` record (stamped with engineVersion etc.)
5. Returns it to the frontend

## Step 5 — Suggestion generation
`generateGapSuggestions(scoreResultId)` — reads `missing_skills` and
`human_scan_flags` off the score, creates `ResumeSuggestion` rows with
status `suggested`. No AI call at this stage — just structuring the gap
report into actionable cards.

## Step 6 — AI drafting (two prompts, different risk profiles)

**Auto-edit prompt** (rephrasing only, no new claims) — use for existing
bullets, safe to apply without confirmation, still shown as before→after:
```
You may ONLY rephrase, reorder, or add JD-matching terminology for facts
already stated in the ORIGINAL BULLET. You must NOT add any metric, scope,
tool, outcome, or claim not already present in the original text. If the
JD uses a synonym for something the bullet already says, prefer the JD's
exact term. Do not change any number, date, percentage, or named entity.
Output strict JSON: { revised_bullet, changes_made[], flagged_for_review }
```

**Gated-suggestion drafting prompt** — only fires after the user answers a
suggestion card with confidence level + free-text description:
```
Draft ONE new resume bullet based ONLY on the user's own description below.
Do not add any detail, metric, tool, or outcome the user did not state.
If confidence_level is "partial", hedge appropriately (e.g. "contributed
to" rather than "owned"). If the user's input is insufficient, return
status "insufficient" with no bullet — never draft a generic placeholder.
Output strict JSON: { status, draft_bullet, unquantified_gaps[] }
```

Use Base44's built-in AI text-generation integration (server-side, keys
never touch the frontend) rather than wiring a separate LLM API.

**Validation layer — enforce this in code, not just the prompt:**
```typescript
function validateAutoEdit(original: string, revised: string): boolean {
  const origNumbers = extractNumbers(original);
  const revNumbers = extractNumbers(revised);
  if (revNumbers.some(n => !origNumbers.includes(n))) return false;
  if (revised.length > original.length * 1.5) return false;
  return true;
}
function validateDraftedBullet(userInput: string, draft: string): boolean {
  const inputNumbers = extractNumbers(userInput);
  const draftNumbers = extractNumbers(draft);
  return draftNumbers.every(n => inputNumbers.includes(n));
}
```
Reject and re-flag for manual review on validation failure — never silently
auto-correct a fabricated number.

## Step 7 — Suggestion state machine (human-in-the-loop UI)
Per suggestion: `suggested → user_responded → (drafted → accepted |
drafted → edited → accepted | declined)`. Render as cards:
- "Yes, I have this experience" → opens free-text input → drafts from that
  input only
- "Partial/adjacent" → same flow, hedged language
- "No" → suggestion marked declined, stays visible as an acknowledged
  gap in the score report (don't silently drop it, and don't re-prompt
  for it again)

## Step 8 — Draft assembly + re-scoring
`buildDraft(resumeId, scoreResultId)` merges auto-edits + all accepted
suggestions into a `ResumeDraft`. `rescoreDraft(draftId, jdId)` re-runs
`runScore()` against the new draft so the user sees a concrete score delta
(v1 → v2) from their own input, not just cosmetic rewriting.

## Step 9 — Frontend
Base44 hosting supports SPA only. Minimum screens:
1. Upload resume + paste JD
2. Score report (contribution breakdown, matched/missing skills, flags —
   mirrors the `explain()` output format from `ats-scorer.ts`). **Surface
   evidence grades visually** — e.g. a solid badge for grade (a), a lighter
   badge for (b), and a subtle/dashed badge for (c) — so users can tell a
   well-evidenced finding (spelling, ATS parseability) apart from a softer
   heuristic (weak-verb openers, closing-section placement) at a glance.
   Read `checkId` and `evidence` off `ScoreResult.human_scan_flags_graded`.
3. Suggestion review (cards, one gap at a time or batch)
4. Draft preview (before→after per bullet) + re-scored result

## Known open decisions (flagged, not blocking)
- `parseBullets`: regex/heuristic (matches spec's own bullet extraction
  approach, predictable but may miss unconventional formatting) vs. AI-
  assisted parsing for non-standard resumes — recommend starting with
  regex, since it's what the verified scoring engine already assumes for
  bullet-level checks (weak openers, length, terminology consistency)
- Whether score history should be visible across resume versions (v1 vs v2
  vs v3) as a trend, not just a single before/after diff

## Files in this delivery
- `ats-engine-typescript/ats-scorer.ts` — verified engine, ready to import
- `ats-engine-typescript/acceptance-tests.ts` — spec §12's 11 test vectors,
  all passing; re-run after any edits to the engine
- `ats-engine-typescript/smoke-test.ts` — real-world sanity check using a
  realistic payments resume + JD
