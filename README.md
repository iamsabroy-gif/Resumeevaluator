# Resume Evaluator

An ATS-style resume scoring and rewriting app: upload a resume, paste a job
description, get a scored breakdown with evidence-graded feedback, and work
through gap-closing suggestions with an AI drafting layer that never invents
a claim the resume or the user didn't already make.

This was originally scoped as a Base44 app (see `docs/KICKOFF_BRIEF.md`).
The scoring engine (`src/engine/ats-scorer.ts`) is a verbatim drop-in — pure
functions, zero Base44-specific imports — and the rest of this repo
implements everything the brief described on top of it as a standalone
Node/Express + vanilla-JS app instead of the Base44 platform.

## Running it

```bash
npm install
npm run dev      # http://localhost:3000, restarts on change
npm start        # same, no watch
```

No API key is required — `AI_PROVIDER` defaults to a deterministic offline
stub that only ever reorders or re-verbs text it was given (see
`src/ai/provider.ts`), so the full flow runs end to end with no credentials.
To use real AI drafting, set `ANTHROPIC_API_KEY` (or run `ant auth login`).

## Deploying to Netlify

The app ships to Netlify as a static frontend (`public/`) plus one serverless
function that runs the whole Express API (`netlify/functions/api.ts` wraps
`createApp()` with `serverless-http`). Because Netlify's function filesystem is
ephemeral and not shared between requests, persistence automatically switches
from the local JSON files to **Netlify Blobs** whenever `NETLIFY` is set (see
`src/store/repositories.ts`). No other code changes between local and deploy.

Configuration lives in `netlify.toml`:

- `/api/*` is redirected to the function (original path preserved), everything
  else falls back to `index.html` for SPA routing.
- The PDF worker (`src/ingestion/pdfWorker.mjs`) and `pdf-parse` are shipped via
  `included_files` since esbuild can't trace a worker spawned by path.

To deploy:

1. Push this branch and connect the repo in the Netlify UI (or run
   `netlify deploy` with the CLI). `netlify.toml` supplies build settings.
2. In **Site settings → Environment variables**, set:
   - `NETLIFY_BLOBS_TOKEN` — a Netlify personal access token, and
     `NETLIFY_BLOBS_SITE_ID` — the site id. **Required.** The app chains
     write-then-read across function invocations (create resume → create JD →
     score), which the eventual-consistency edge context breaks; a token routes
     Blobs through the strongly-consistent API so reads always see prior writes.
   - `ANTHROPIC_API_KEY` — optional; enables real AI drafting (without it the
     deterministic offline stub is used).
   See `.env.example` for the full list.
3. The persistence store itself (Netlify Blobs) is enabled automatically; only
   the token above is needed to make it strongly consistent.

Because the function wraps Express with `serverless-http` (a Lambda-compat
handler), it calls `connectLambda(event)` per request to wire up the Blobs
context, and resolves the PDF worker from `LAMBDA_TASK_ROOT` — see
`netlify/functions/api.ts`.

Locally you can emulate the deployed setup with `netlify dev` and
`USE_NETLIFY_BLOBS=true`.

## Testing

```bash
npm test          # everything: engine acceptance + v5 evidence-weighting + pipeline
npm run typecheck
npm run smoke      # human-readable run against a realistic payments resume + JD
```

Each suite is its own process (`tests/run-all.ts`) so temp data dirs and the
shared assertion registry never leak between them.

## Layout

```
src/engine/ats-scorer.ts     the verified scoring engine, unmodified
src/domain/                  entity types, id/timestamp helpers
src/store/                   persistence: JSON files locally, Netlify Blobs on deploy
netlify/functions/           the Express API wrapped as a Netlify function
src/ingestion/                DOCX/PDF text extraction + bullet parsing
src/scoring/                 skill banks, orchestration, semantic-layer hook
src/suggestions/              gap-suggestion generation + the state machine
src/ai/                       Anthropic provider, offline stub, validation
src/drafts/                   draft assembly + re-scoring
src/server/                   Express API + static hosting
public/                       the SPA (no build step, mirrors Base44's SPA-only hosting)
tests/                        acceptance / evidence-weighting / pipeline suites
```

## Notable implementation decisions

- **PDF parsing runs in a worker thread** (`src/ingestion/pdfWorker.mjs`).
  `pdf-parse` bundles a very old pdf.js whose Node "fake worker" shim holds
  mutable state at module scope — repeated parses of the *same* file in the
  same process intermittently threw different errors. Isolating each parse
  in a fresh worker thread eliminated it; see `tests/pipeline-tests.ts` P4b.
- **Extraction confidence is a first-class signal**, not just success/fail —
  a resume that "parsed" into 12 garbled words is more dangerous than one
  that failed outright, because a score built on it looks legitimate.
- **The anti-fabrication validation layer is code, not prompt** — every
  number in an AI-drafted bullet is checked against the source text before
  it can be applied. See `src/ai/validation.ts`.
- **Declined suggestions never come back.** The gap stays on record; the
  user is never re-asked about something they already said no to.
