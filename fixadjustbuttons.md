# Fix: unclear gap-response buttons

## Problem

On the gap-review screen, each suggestion card showed three response buttons
with no explicit question above them:

```
[ Yes, I have this ]  [ Partial / adjacent ]  [ No ]
```

Reported as confusing. Root causes (per tech-advisor review):

1. **No question asked.** The card shows a gap-type chip and JD evidence text,
   then buttons — the user has to infer what "yes" answers.
2. **One label set stretched across four gap types** (`skill`, `metric`,
   `governance`, `phrasing`) that don't share a single natural yes/no question.
3. **"Partial / adjacent" is jargon** — recruiter vocabulary, not something a
   user can self-classify against.
4. **"No" is a silent commit.** Unlike "Yes"/"Partial" (which just reveal a
   textarea), clicking "No" immediately and irreversibly posts a skip
   (`respondSuggestion(s.id, "no", "")`), but it's styled as the outline/
   secondary button next to two solid ones — reads as "cancel," not "answer."

## Fix

- Added a gap-type-specific question above the buttons (`GAP_QUESTIONS` map:
  skill/metric/governance/phrasing each get their own phrasing).
- Reworded buttons: `Yes — I've done this`, `Some of it`, `No — skip this gap`
  (states the consequence directly instead of a bare "No").
- Visually separated "No" onto its own row below the yes/partial pair so its
  different (destructive/commit) behavior reads spatially, not just by color.
- Added `aria-pressed` + a visible `.is-selected` state on the button that
  was clicked, so the card doesn't lose context once the textarea appears.
- Added `role="group"` / `aria-labelledby` linking the button group to the
  question text.
- Textarea label now varies by level ("What did you do? In your own words."
  vs "Describe the part you have done.") instead of a generic "Describe it."
- Disabled all three buttons while `state.busy`, matching the existing
  "Build draft" button's busy handling, to stop double-submits.

`data-level` values (`yes`/`partial`/`no`) are unchanged — they're the API
contract sent to `/suggestions/:id/respond` and typed in
`src/domain/types.ts`. This is a display-only change.

Files touched: `public/app.js`, `public/styles.css`.
