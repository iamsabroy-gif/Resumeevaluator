# Gap-response buttons: update note

Follow-up to `fixadjustbuttons.md`. That file covers the UX rationale in depth.
This one is the short reference for *what changed* and, more importantly, *what
the buttons actually do on the backend* — specifically the difference between
"Yes" and "Some of it", which is not obvious from the UI.

## 1. What changed (UI)

`public/app.js` (card render) and `public/styles.css`.

Old: `Yes, I have this` / `Partial / adjacent` / `No`.

New:

- A gap-type-specific question rendered above the buttons, from the
  `GAP_QUESTIONS` map (`public/app.js`). Different phrasing per `gapType`
  (`skill` / `metric` / `governance` / `phrasing`), falling back to
  "Do you have this experience?" for an unknown type.
- `✓ Yes — I've done this`
- `⚡ Some of it`
- `✕ No — skip this gap`, on its own row below the other two, styled as
  secondary/outline. Reason: it fires an immediate, irreversible skip POST,
  whereas the other two only reveal a textarea.
- `aria-pressed` plus a visible `.is-selected` outline on the clicked button.
- Level-specific textarea label: "What did you do? In your own words." (yes) /
  "Describe the part you have done." (partial).
- All three buttons are `disabled` while `state.busy`.
- Focus moves into the textarea once it appears.

Wire values are unchanged: the buttons still POST `confidenceLevel` of
`"yes"` / `"partial"` / `"no"` (`respondSuggestion` in `public/app.js`,
validated in `src/server/routes.ts`).

## 2. Yes vs. Some of it — the actual behavioral difference

**Short answer: only the opening verb phrase of the generated bullet differs.
The facts come entirely from the user's textarea and are treated identically.**

### Stub provider (default, and what you get with no API key)

`src/ai/provider.ts`, `StubProvider.draftBullet()`:

```ts
const opener = req.confidenceLevel === "partial" ? "Contributed to" : "Owned";
```

That single ternary is the whole difference:

| Button | `confidenceLevel` | Bullet opener |
| --- | --- | --- |
| Yes — I've done this | `"yes"` | `Owned …` |
| Some of it | `"partial"` | `Contributed to …` |

Everything upstream of that line is shared: the same leading-`I …`/weak-opener
stripping, the same acronym-case preservation, the same sentence body built
from the user's own words. Nothing is added, softened, or scoped down for
`partial` beyond the opener.

The "no number in your description" note in `unquantified_gaps` is emitted by
the same `!/\d/.test(input)` check for both levels — it is not confidence-aware.

### Anthropic provider (when `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set)

There is no ternary. The level is passed through to the model as a
`CONFIDENCE_LEVEL:` line (`gatedDraftUserMessage` in `src/ai/prompts.ts`) and
the hedging is instructed in `GATED_DRAFT_SYSTEM`:

> If confidence_level is "partial", hedge appropriately (e.g. "contributed to"
> rather than "owned").

So the *intent* is the same as the stub's ternary — hedge the ownership verb —
but the exact wording is model-chosen rather than guaranteed. Don't write tests
that assert a literal `"Contributed to"` prefix against the live provider.

## 3. "No" is a different path entirely

`"no"` never reaches the opener logic:

- `src/suggestions/stateMachine.ts` transitions the suggestion straight to
  `declined` and returns; `draftForSuggestion` is never called.
- `src/ai/provider.ts` also guards it defensively: `"no"` (or input shorter
  than `MIN_USER_INPUT_WORDS`) returns `status: "insufficient"` with an empty
  `draft_bullet`.
- `routes.ts` skips the non-empty-`userInput` requirement for `"no"`.

Net: no bullet is produced, and the gap is closed as declined.

## 4. Practical read

If someone asks "why would I pick one over the other" — the honest answer is
credibility calibration, not output quality. Both produce a bullet from the
same facts; `partial` just stops the bullet from claiming ownership the user
can't defend in an interview. That is the entire functional difference.
