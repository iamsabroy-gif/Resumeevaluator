# Implementation plan: better YouTube study links for missing skills

Follow-up to [`studylinksplan.md`](./studylinksplan.md), which shipped the
end-to-end feature (`src/learning/youtubeSearch.ts`, `src/store/studyLinkCache.ts`,
`POST /suggestions/:id/study-links`, the frontend "Find study resources" card).
The plumbing works; the *results* don't hold up. This plan fixes result
quality without touching the data model, route, or frontend contract.

## 1. Why current links are "not proper"

Two independent problems, diagnosed by reading `src/learning/youtubeSearch.ts`:

**(a) No API key configured → every link is the same generic stub.**
`youtubeSearch()` only calls the real API when `YOUTUBE_API_KEY` is set
(`src/learning/youtubeSearch.ts:42-48`). Without it, every skill — "Kafka",
"React", "SQL" — gets exactly one result: a bare
`youtube.com/results?search_query=<skill>+tutorial` link. That's not a study
resource, it's a redirect to Google's own search box. This is very likely
the dominant cause of "not proper", since `YOUTUBE_API_KEY` is blank in
`.env.example` and nothing forces it to be set.

**(b) Even with a key, the query is too naive to rank well.**
The only query built is `"<skill> tutorial"` (line 55), passed straight to
`search.list` with default `order=relevance` and no other constraints. Known
failure modes:
- **Ambiguous short skills** ("Go", "R", "C", "Next") collide with unrelated
  common-word results — "go tutorial" surfaces travel/gaming videos.
- **No quality signal.** `search.list` returns titles/snippets only, not view
  count, duration, or channel authority — so a 40-second low-effort clip
  ranks the same as a well-produced 20-minute course.
- **No duration/type filtering** — YouTube Shorts and clip compilations can
  come back for `type=video` and are useless as "study" material.
- **No language pin** — `relevanceLanguage` isn't set, so results can skew
  non-English depending on YouTube's default signals for the query.
- **No de-duplication against near-identical results** from the same
  churned-out course-mill channel.

## 2. Fix (a): curated fallback map for the no-key / common-skill path

Most JD-derived skill gaps cluster around a few hundred recurring keywords
(languages, frameworks, cloud platforms, tools). Rather than leaving the
no-key path as a single search-redirect, ship a small curated table of
hand-picked, known-good videos for the ~150 most common skills seen in
practice (Python, SQL, React, AWS, Kafka, Docker, Kubernetes, Git, Java,
TypeScript, Terraform, CI/CD, GraphQL, Redis, etc.).

- New file `src/learning/curatedStudyLinks.ts`: a `Record<string, StudyLink[]>`
  keyed by normalized skill name, 1-3 entries each, populated with real
  `videoId`s from well-known, high-view-count channels (freeCodeCamp,
  official docs channels, Fireship, etc.) chosen manually and reviewed once.
- `youtubeSearch()` checks this table first, *before* the cache and *before*
  deciding whether an API key exists:
  1. Curated hit → return immediately (no network call, no quota spent, and
     it works identically whether or not `YOUTUBE_API_KEY` is set).
  2. Curated miss + API key present → live search (see §3 below).
  3. Curated miss + no API key → existing single-link search-redirect
     fallback (unchanged, still needed as the last resort).
- This directly fixes the majority case (common skills) even for
  installations that never configure a YouTube API key, which given
  `.env.example` ships it blank, is probably most of them.
- Curation is a manual, reviewed list, not scraped — avoids the "not proper"
  complaint recurring for the highest-traffic skills specifically.

## 3. Fix (b): better live search when the API key *is* set

For the long tail not in the curated table, improve `youtubeSearch()`'s call
to `search.list` and add a second call to `videos.list` for ranking:

- **Query construction**: quote multi-word skills and drop the bare
  `tutorial` suffix in favor of a small per-skill-shape heuristic —
  `"<skill>" crash course` for single ambiguous tokens (length ≤ 3 or in a
  small stoplist of common-word collisions like "Go", "R"), `<skill> tutorial
  for beginners` otherwise. Keeps the change small and testable as a pure
  function (`buildSearchQuery(skill): string`) instead of a model call.
- **Widen the candidate pool**: request `maxResults=10` instead of 3 from
  `search.list`, then re-rank locally instead of trusting API order alone.
- **Add quality signals via `videos.list`**: one follow-up call with
  `part=statistics,contentDetails` for the 10 candidate video IDs, batched
  into a single request (YouTube allows comma-separated IDs, so this is
  still 1 extra API call, not 10).
- **Filter and rank** the 10 candidates locally:
  - Drop videos under 3 minutes (`contentDetails.duration` parsed from ISO
    8601 — filters out Shorts and low-effort clips).
  - Drop videos with view count under a small floor (e.g. 1,000) to avoid
    zero-signal uploads.
  - Sort remaining candidates by view count descending, take top 3.
- **Set `relevanceLanguage=en`** and `safeSearch=strict` on the initial
  `search.list` call.
- Quota cost: `search.list` (100 units) + `videos.list` (1 unit) = 101 units
  per uncached lookup, versus 100 today — negligible increase, and the
  curated-table fix in §2 means most lookups never reach this path at all.

## 4. Cache key stays the same

`src/store/studyLinkCache.ts` already keys by normalized skill string with a
14-day TTL — no change needed. Curated-table hits are cheap enough that they
don't need caching, but writing them through the existing cache too is
harmless and keeps `getCachedStudyLinks`/`setCachedStudyLinks` as the single
read path callers rely on.

## 5. Files touched

| File | Change |
| --- | --- |
| `src/learning/curatedStudyLinks.ts` (new) | Manually curated `skill → StudyLink[]` table |
| `src/learning/youtubeSearch.ts` | Check curated table first; extract `buildSearchQuery()`; add `videos.list` ranking pass; add `relevanceLanguage`/`safeSearch` params |
| `tests/study-links-tests.ts` | Add cases: curated hit skips fetch entirely; query-builder heuristic; duration/view-count filtering drops a short/low-view candidate; ranking picks highest view count from a mocked 10-item response |

No changes needed to `src/domain/types.ts`, `src/server/routes.ts`,
`public/app.js`, `public/styles.css`, or `.env.example`/README — the
contract (`StudyLink[]`, the route shape, the frontend card) is unchanged;
only what populates it gets better.

## 6. Rollout order

1. Curated table + lookup-order change (§2) — biggest quality win, zero API
   dependency, ships first.
2. Query-builder extraction + tests (§3, query part only).
3. `videos.list` ranking pass (§3, filtering part) — gated behind
   `YOUTUBE_API_KEY` being set, so it's additive and low-risk.
4. Run `tests/study-links-tests.ts` (extended) and `tests/run-all.ts` before
   merging.
