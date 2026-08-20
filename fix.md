# Fix: Format Quality score/weight label ambiguity

## Context

In the ATS resume evaluator UI (`public/app.js`, `public/styles.css`), each
scoring row (Keyword match, Skills, Format Quality, Section, Density) is
rendered as a 3-column grid: left = category weight %, middle = bar,
right = actual score %. Both numbers are correct but unlabeled, so users
read them as contradictory (e.g. Format Quality: left "20%" = weight,
right "90%" = measured score).

Root cause investigated and confirmed — not a data bug, single source of
truth for `format_quality`:
- Computed: `src/engine/ats-scorer.ts:430`, `:514-515`, returned `:739`
- Persisted: `src/scoring/runScore.ts:76`
- Typed: `src/domain/types.ts:92`
- Rendered: `public/app.js:250-290` (`renderScoreScreen`)

The row is a 3-column CSS grid (`public/styles.css:136`, `140px 1fr 48px`):
- Left value = `SIGNAL_WEIGHTS[key] * 100` (`public/app.js:282`) — a fixed
  constant weight, same for every resume.
- Right value = `score.format_quality * 100` (`public/app.js:279,284`) —
  the actual measured score, matches the bar fill.

Same ambiguity exists on all 5 signal rows; Format Quality just has the
widest weight/score gap, making it look broken.

## Task 1 — Disambiguate the weight label

**File:** `public/app.js`
**Location:** ~line 282, inside `renderScoreScreen`, where
`SIGNAL_WEIGHTS[key] * 100` is rendered as the left-column value.

- Change the rendered text from a bare
  `${Math.round(SIGNAL_WEIGHTS[key] * 100)}%` to something like
  `wt ${Math.round(SIGNAL_WEIGHTS[key] * 100)}%` (or `20% of final`, pick
  house style).
- Add a `title="Weight of this category in the overall score"` attribute
  to that element.

## Task 2 — Clarify the score column

**File:** `public/app.js`
**Location:** ~lines 279 and 284, where `score.format_quality * 100` (and
equivalents for other signals) is rendered as `.bar-value`.

- Add `title="Score: X of 100"` (or `aria-label`) to the `.bar-value`
  element using the actual rounded score.

## Task 3 — CSS check

**File:** `public/styles.css` (~line 136, grid `140px 1fr 48px`)

- Confirm the left column (140px) has room for the longer label text
  (`wt 20%` vs `20%`). Adjust column width or font-size if it
  wraps/truncates. Check at narrow viewport widths too.

## Task 4 (recommended, not required for the visual fix) — Fix duplicated weight table

**Files:** `public/app.js:242-248` (`SIGNAL_WEIGHTS`) and
`src/engine/ats-scorer.ts:44-50` (`WEIGHTS`)

These are hand-duplicated and can silently drift. Two options — pick one:

- **Option A (preferred):** Include `weights` in the score API response
  from `src/scoring/runScore.ts`, and have `app.js` render from
  `response.weights[key]` instead of its own local `SIGNAL_WEIGHTS`
  constant. Remove the duplicate constant from `app.js`.
- **Option B (lighter touch):** Keep both constants but add a
  unit/integration test asserting `SIGNAL_WEIGHTS` in `app.js` matches
  `WEIGHTS` in `ats-scorer.ts` key-for-key, so CI catches drift.

## Acceptance criteria

- Format Quality row (and all other signal rows) visually distinguishes
  "weight" from "score" — no more reading as contradictory numbers.
- Existing `sum-to-1.0` weight guard in `ats-scorer.ts:52-55` still
  passes.
- No change to actual scoring computation — this is UI/labeling only
  (Tasks 1-3); Task 4 is a data-flow refactor, keep it in a separate
  commit if done.
- Manually verify in browser: run a resume through the evaluator,
  confirm all 5 signal rows show clearly distinct weight vs. score
  labels.

## Out of scope

- Do not modify scoring weights or formulas in `ats-scorer.ts`.
- Do not touch `runScore.ts` persistence format unless doing Task 4
  Option A.
