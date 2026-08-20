# Feature: Job description from a URL (additive to manual paste)

## Context

Today the job description is supplied one way only — a textarea on the upload
screen:

- Rendered: `public/app.js:163-168` (`renderUploadScreen`, `<textarea id="jd-text">`)
- Read on submit: `public/app.js:181` (`document.getElementById("jd-text").value.trim()`)
- Posted: `public/app.js:206-211` → `POST /api/job-descriptions` with
  `{ rawText, userId }`
- Server handler: `src/server/routes.ts:196-212` — trims `rawText`, rejects
  empty, derives `title` from the first non-blank line, persists a
  `JobDescription` (`src/domain/types.ts:53-59`) and returns the record.
- The returned `jd.id` is then passed to `POST /api/scores`
  (`public/app.js:213-216` → `src/server/routes.ts:216-227` → `runScore`
  at `src/scoring/runScore.ts:43-53`, which only ever reads `jd.rawText`).

So the whole downstream pipeline (scoring, gap suggestions, drafts) depends
on exactly one thing: a `JobDescription` row with a non-empty `rawText`.
That is the seam this feature plugs into — scraping a URL only needs to
produce a string that then goes down the identical path. **No scoring,
persistence, or type change is required for the happy path.**

Relevant current state of the stack:
- Express 4 app, ESM, `tsx` runtime, Node >= 20 (`package.json`). Body parser
  limit is 2 MB (`src/server/index.ts:13`).
- Error middleware already maps a thrown error with a numeric `.status` to
  that HTTP status and returns `{ error: message }`
  (`src/server/index.ts:31-40`). `BadRequestError` at
  `src/server/routes.ts:65-67` is the existing 400 idiom.
- Frontend `api()` helper already surfaces `data.error` as a thrown JS error
  (`public/app.js:33-44`), and `guarded()` (`:51-60`) renders it into the
  error banner.
- **No HTTP client and no HTML parser exist anywhere in the project.**
  `grep -rn "fetch(" src/` returns nothing; dependencies are
  `@anthropic-ai/sdk`, `express`, `mammoth`, `multer`, `pdf-parse`, `zod`.
  Node 20's global `fetch` is available and is the right choice — no new
  HTTP dep.
- The SPA has no build step and no framework (`public/app.js:1-8`); any new
  UI must be plain DOM + a state field.

## Task 1 — SSRF guard for user-supplied URLs (do this first)

**File:** new — `src/ingestion/urlGuard.ts`

This endpoint fetches an arbitrary URL *from the server*, so it is a
textbook SSRF sink. Write and test this module before writing the fetcher.

Export `assertFetchableUrl(input: string): Promise<URL>` which throws a
`BadRequestError`-shaped error (numeric `.status = 400`) on any violation:

1. Parse with `new URL(input)`; reject unparseable input.
2. Protocol allowlist: `http:` and `https:` only. Explicitly rejects
   `file:`, `ftp:`, `gopher:`, `data:`, `blob:`, `javascript:`.
3. Reject any URL carrying credentials (`url.username || url.password`).
4. Reject hostnames: `localhost`, anything ending in `.localhost`,
   `.local`, `.internal`, and the bare metadata hostname
   `metadata.google.internal`.
5. **Resolve the hostname yourself** with `dns.promises.lookup(host, { all: true })`
   and reject if *any* returned address is non-public. Do not rely on
   string matching of the hostname — `http://x.example.com` can resolve to
   `127.0.0.1`.
6. Private/reserved ranges to block (both IPv4 and IPv6):
   - `0.0.0.0/8`, `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`
     (**includes the cloud metadata endpoint `169.254.169.254`**),
     `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10` (CGNAT),
     `192.0.0.0/24`, `198.18.0.0/15`, `224.0.0.0/4`, `240.0.0.0/4`
   - IPv6: `::`, `::1`, `fc00::/7` (ULA), `fe80::/10` (link-local),
     `ff00::/8` (multicast), and IPv4-mapped `::ffff:a.b.c.d` — unwrap the
     mapped form and re-run the IPv4 check on it.
7. Cap URL length (e.g. 2048 chars) before doing any work.

**Redirects are part of the same attack surface.** Call `fetch` with
`redirect: "manual"` and follow redirects in a loop yourself (max 3 hops),
re-running `assertFetchableUrl` on every `Location` value. `redirect: "follow"`
would let a public URL 302 straight to `169.254.169.254` and bypass the
whole guard.

Note the residual DNS-rebinding gap in a comment: the guard resolves, then
`fetch` resolves again. For a local/self-hosted tool this is an accepted
risk; if this ever runs multi-tenant on shared infra, the fix is an egress
proxy or pinning the resolved IP into the request. Do not silently ignore it.

## Task 2 — Fetch + extract the job description text

**File:** new — `src/ingestion/fetchJobDescription.ts`

Export `fetchJobDescription(rawUrl: string): Promise<{ text: string; title: string; finalUrl: string }>`.

Fetch behaviour:
- `assertFetchableUrl` on the input and on every redirect hop (Task 1).
- **Timeout:** `AbortSignal.timeout(10_000)`. A hung request must not hold a
  server connection open indefinitely.
- **Content-type allowlist:** accept only `text/html`, `application/xhtml+xml`,
  and `text/plain`. Anything else (PDF, JSON, image, octet-stream) → 415-style
  error telling the user to paste the JD manually.
- **Response size cap:** 2 MB. Check `Content-Length` when present, but also
  stream the body and abort once the accumulated byte count exceeds the cap —
  a hostile server can omit or lie about `Content-Length`.
- Send a descriptive `User-Agent` (e.g.
  `ResumeEvaluator/1.0 (+job-description-fetch)`) and `Accept: text/html`.
  Do not spoof a browser UA — see the ToS note below.
- Map upstream status to a clear message: 404 → "That job posting URL
  returned 404 — it may have been taken down."; 401/403 → "That site
  blocked the request (login or bot protection)."; 5xx → "That site is
  returning an error right now."

Extraction:
- **Library choice: `cheerio`.** It is the only new runtime dependency this
  feature needs. Rationale: jQuery-like API, no JSDOM/browser dependency,
  ~500 KB installed, well-maintained, and the idiomatic choice for
  Node-side HTML scraping.
  - *Considered and rejected:* `@mozilla/readability` — better boilerplate
    stripping, but requires `jsdom` (heavy, ~10 MB, historically CVE-prone).
    Revisit only if cheerio-based extraction proves too noisy in practice.
  - *Considered and rejected:* a regex/`String.replace` HTML stripper — no
    new dep, but it cannot drop `<nav>`/`<footer>`/`<script>` content, so the
    JD text ends up polluted with site chrome, which directly degrades
    `keyword_match` in `src/engine/ats-scorer.ts`. Not acceptable — the
    extracted text feeds the score.
- Extraction order, first non-empty wins:
  1. **JSON-LD `JobPosting`**: `script[type="application/ld+json"]` parsed,
     walked for `@type === "JobPosting"`, use `.description` (strip its inner
     HTML with cheerio too) and `.title`. Most major job boards emit this and
     it is by far the cleanest source.
  2. Semantic containers: `main`, `article`, `[role="main"]`, then a
     largest-text-block heuristic over `div`/`section`.
  3. Fall back to `body`.
- Before extracting, always `$("script, style, nav, footer, header, aside, noscript, svg, form, iframe").remove()`.
- Normalise whitespace: collapse runs of spaces, collapse 3+ newlines to 2,
  trim. Preserve line breaks — `src/server/routes.ts:201` derives the JD
  `title` from the first non-blank line, and `parseBullets`-style logic
  downstream is line-oriented.
- **Minimum-length sanity check:** if the extracted text is under ~200
  characters, treat it as a failed scrape (JS-rendered SPA job board, or a
  consent/paywall interstitial) and throw a message that tells the user to
  paste manually. Silently scoring against 40 characters of cookie banner
  would produce a wrong score with no visible cause — worse than an error.
- Cap the stored text (e.g. 100 KB) so a pathological page cannot bloat the
  JSON store at `src/store/jsonStore.ts`.

**robots.txt / ToS:** this is a single, user-initiated, user-visible fetch of
a page the user is already reading — not a crawler. Do not build a crawler,
do not follow links off the page, and do not add background re-fetching.
Add a one-line comment at the top of the module stating that; if the feature
later grows batch/scheduled fetching, robots.txt compliance becomes required.

**Public-postings-only limitation:** the fetch is server-side (Node's
`fetch`), with no browser, no cookies, and no access to the user's login
session on any site — including a page they are actively logged into in
their own browser. It only ever sees what an anonymous, logged-out visitor
sees. Concretely:
- Public job postings (LinkedIn public job pages, Indeed, Greenhouse,
  Lever, etc.) work, since these are typically served without auth.
- Login-walled postings (content visible only inside the user's session —
  e.g. a connections-only LinkedIn post, an internal ATS portal) will
  return a login/paywall page instead of the JD. This is caught by the
  under-200-char sanity check in Task 2 and surfaces as a scrape failure,
  not a silent bad score.
- This is a deliberate scope boundary, not a bug to fix later — see
  "No auth/cookie support" in Out of scope.

## Task 4b — Surface the public-postings-only limitation in the UI

**File:** `public/app.js`
**Location:** the `url` mode panel added in Task 4 (`#jd-url` input area).

- Render a persistent `.hint`-styled line under the URL input, always
  visible in `url` mode (not just on error), e.g.: "Works with publicly
  viewable job postings. Pages that require you to be logged in (e.g.
  gated LinkedIn posts, internal portals) can't be fetched — paste the
  description instead."
- When a scrape fails specifically due to the under-200-char sanity check
  or a 401/403 upstream status (Task 2's status-mapping), make the inline
  error from Task 5 explicitly say the page may be login-restricted,
  rather than a generic "fetch failed" message — reuse the wording above
  so the user gets the same explanation whether they read it upfront or
  after a failed attempt.

## Task 3 — Endpoint

**File:** `src/server/routes.ts`
**Location:** the "job descriptions" section, ~line 194-212.

Extend the existing handler rather than adding a parallel one, so both input
paths converge on one persistence code path:

- `POST /api/job-descriptions` now accepts **either** `{ rawText }` (today's
  contract, unchanged) **or** `{ sourceUrl }`.
- If `sourceUrl` is present and `rawText` is not: call
  `fetchJobDescription(sourceUrl)`, then continue into the exact same
  `JobDescription` construction at `:202-208`.
- If both are present, prefer `rawText` (the user's explicit paste wins).
- Prefer the scraped page/JSON-LD title for `jd.title` when available,
  otherwise keep the existing first-non-blank-line derivation at `:201`.
- **Response shape is unchanged** — the same `JobDescription` JSON, 201.
  This is the load-bearing constraint: `public/app.js:206-216` only needs
  `jd.id`, so nothing downstream changes.
- Validate with `zod` (already a dependency) rather than hand-rolled
  `String(...)` coercion, since this body now has two shapes.

**File:** `src/domain/types.ts:53-59`

Add two optional fields to `JobDescription` so a scraped JD is auditable:

```ts
sourceUrl?: string;   // present only when fetched from a URL
sourceType?: "paste" | "url";
```

Both optional → existing rows in `.data/job_descriptions.json` stay valid,
no migration needed.

**Rate limiting:** add a small in-memory per-IP limiter (e.g. 10 fetches /
minute) around this route only. Without it, this endpoint is a free
open-proxy / amplification primitive pointed at third parties. No new
dependency needed for a Map-based limiter at this scale; graduate to
`express-rate-limit` only if other endpoints need it too.

## Task 4 — Frontend: Paste / From URL toggle

**File:** `public/app.js`
**Location:** `renderUploadScreen`, the JD panel at `:163-168`, plus the
submit handler at `:175-183` and `submitResume` at `:187-231`.

State (`public/app.js:12-29`) — add:
```js
jdMode: "paste",     // "paste" | "url"
jdUrl: "",           // preserved across re-renders
jdText: "",          // preserved across re-renders
jdFetching: false,
jdFetchError: null,
```
These must live in `state`, not only in the DOM: `render()` blows away and
rebuilds `app.innerHTML` (`:91-92`), so any value held only in an input is
lost on every re-render. This is the same hazard already called out in the
comment at `:176-178`.

Markup — replace the single-textarea JD panel with:
- A two-button tab row (`<button data-jd-mode="paste">Paste JD</button>` /
  `<button data-jd-mode="url">JD from URL</button>`) using the existing
  `.row` class; mark the active one with a class mirroring
  `.steps span.active` in `public/styles.css:46`.
- `paste` mode: the existing `<textarea id="jd-text">`, unchanged, value
  seeded from `state.jdText`.
- `url` mode: `<input type="url" id="jd-url" placeholder="https://...">` plus
  a `#fetch-jd-btn` ("Fetch job description"), and a preview `<textarea>`
  showing the fetched text **that the user can edit before scoring**. The
  preview is not decoration — scraped text is imperfect, and letting the user
  trim it is what keeps a bad scrape from silently producing a bad score.

Wiring:
- Tab clicks: read the current input value into state *before* calling
  `setState`, exactly as the existing submit handler does at `:179-181`.
- `#fetch-jd-btn` → `guarded(...)` around a call to
  `POST /api/job-descriptions` with `{ sourceUrl, userId }`. On success store
  the returned `jd` in `state.jd` **and** its `rawText` into `state.jdText`
  so the preview textarea is populated.
- Loading state: disable the fetch button and show "Fetching…" while
  `state.jdFetching` — same pattern as `#submit-btn` at `:170`.

## Task 5 — Error handling and fallback to manual paste

**File:** `public/app.js` (fetch handler from Task 4)

A failed scrape must never block scoring — the JD is optional in the first
place (`src/server/routes.ts:216-227` accepts `jdId: null`).

- On fetch failure, do **not** route the message into the global
  `state.error` banner (`:139-143`) — that reads as "the app broke". Set
  `state.jdFetchError` and render it inline inside the JD panel using the
  existing `.hint` / `.error-banner` styling.
- The inline error must include an explicit escape hatch: an action link
  "Paste the job description manually instead" that flips `jdMode` back to
  `"paste"` and focuses the textarea.
- The "Score my resume" button stays enabled throughout — a user with a
  failed scrape can still score with no JD (generic mode) or paste.

**File:** `public/app.js:187-231` (`submitResume`)

Rework the JD branch at `:205-211`:
- If `state.jd` already exists (created by the URL fetch) **and** the preview
  text was not edited since, reuse `state.jd.id` — do not re-POST and create
  a duplicate `JobDescription` row.
- If the preview text *was* edited, POST the edited `rawText` as a new JD
  (paste path) so the score matches what the user actually sees.
- Otherwise fall through to the existing paste behaviour, unchanged.

Also reset the new fields in the "Start over" handler at
`public/app.js:611-624`.

## Task 6 — Styles

**File:** `public/styles.css`

- Add a `.tabs` / `.tab.active` rule for the JD mode toggle, reusing the
  existing accent treatment from `.steps span.active` (`:46`) for visual
  consistency. No new colour tokens.
- Style the inline JD error distinctly from `.error-banner` (`:108`) — it is
  a recoverable, scoped warning, closer to `.gap-note` (`:210`).

## Task 7 — Tests

**File:** new — `tests/url-guard-tests.ts`, registered in the `SUITES` array
at `tests/run-all.ts:13`. Use the existing harness (`tests/harness.ts`).

Must cover, at minimum:
- `http://169.254.169.254/latest/meta-data/` → rejected
- `http://localhost:3000`, `http://127.0.0.1`, `http://[::1]` → rejected
- `http://10.0.0.1`, `http://192.168.1.1`, `http://172.16.0.1` → rejected
- `http://[::ffff:127.0.0.1]` (IPv4-mapped IPv6) → rejected
- `file:///etc/passwd`, `gopher://x` → rejected
- `http://user:pass@example.com` → rejected
- A public https URL → accepted
- A redirect chain whose second hop is `127.0.0.1` → rejected

Plus extraction unit tests against **fixture HTML strings** (no network calls
in the test suite): a JSON-LD `JobPosting` page, a plain `<main>` page, a
nav/footer-heavy page (assert the chrome text is gone), and a
under-200-char page (assert it throws).

## Acceptance criteria

- Both JD input modes work; the paste path behaves **byte-identically** to
  today (same request body, same response, same score).
- Pasting a real public job-posting URL produces JD text that visibly
  contains the role's requirements and does not contain nav/footer/cookie
  text.
- All SSRF cases in Task 7 are rejected with a 400 and a clear message, and
  the guard is applied on every redirect hop, not just the initial URL.
- A fetch against a slow endpoint aborts at 10s rather than hanging.
- A non-HTML URL (e.g. a PDF posting) fails with a message naming the reason
  and offering manual paste.
- A failed scrape leaves the app fully usable: the user can switch to paste,
  or score with no JD, without reloading.
- The "URL" mode always shows the public-postings-only hint, and a scrape
  failure caused by a login wall (401/403, or under-200-char extraction)
  explicitly tells the user the page may require login, not a generic error.
- `npm run typecheck` and `npm test` pass.
- `.data/job_descriptions.json` rows written before this change still load
  (new fields are optional).

## Out of scope

- Do not change scoring: no edits to `src/engine/ats-scorer.ts`,
  `src/scoring/runScore.ts`, or the weights. Scraped JD text enters the
  pipeline through the same `JobDescription.rawText` field as pasted text.
- No headless-browser / Playwright rendering for JS-only job boards.
  `playwright` is present as a devDependency but pulling it into the request
  path adds ~300 MB and seconds of latency per fetch. If SPA job boards turn
  out to be the dominant failure mode, that is a separate, deliberate
  decision — not part of this change.
- No caching or deduplication of fetched URLs.
- No crawling, no link-following, no scheduled re-fetch.
- No auth/cookie support for gated or paywalled postings — those fall back
  to manual paste by design.
- No change to the resume upload path (`src/server/routes.ts:135-181`).
