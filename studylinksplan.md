# Implementation plan: study links for missing-skill gaps

Scope: for gap cards where `gapType === "skill"` only (metric/governance/
phrasing gaps aren't things you "study"). Link source: YouTube Data API v3,
with a no-key/no-quota fallback to a plain YouTube search URL.

## 1. Data model (`src/domain/types.ts`)

`ResumeSuggestion` currently only stores `jdEvidence` as a full sentence
(e.g. `The job description asks for "Kafka", which doesn't appear anywhere
in your resume.`) — the bare skill keyword isn't preserved separately, so it
can't be used as a search query as-is.

Add two fields, populated only for `gapType === "skill"`:

```ts
missingSkill: string | null;      // raw keyword, e.g. "Kafka" — carried through from rankMissingSkills
studyLinks: StudyLink[] | null;   // populated lazily, null until fetched
```

```ts
export interface StudyLink {
  title: string;
  url: string;
  thumbnailUrl: string | null;
  channelTitle: string;
}
```

## 2. Populate `missingSkill` at generation time

`src/suggestions/generateGapSuggestions.ts` (~line 124-135) already has
`skill` in scope when building the skill card — pass it through as
`missingSkill: skill` in `makeSuggestion`. No behavior change to existing
gap types.

## 3. YouTube search module (`src/learning/youtubeSearch.ts`, new)

- Wraps `GET https://www.googleapis.com/youtube/v3/search`
  (`part=snippet&type=video&maxResults=3&q=<skill> tutorial`).
- Reads `YOUTUBE_API_KEY` from env, same pattern as `ANTHROPIC_API_KEY` in
  `src/ai/provider.ts`.
- If no key set: return a single fallback `StudyLink` pointing at
  `https://www.youtube.com/results?search_query=<encoded skill>+tutorial`
  instead of calling the API — feature degrades to "search shortcut," never
  breaks.
- If the API call fails or quota is exhausted (403 / `quotaExceeded`): catch
  and fall back the same way, don't surface an error to the user.

## 4. Caching layer (quota control)

YouTube Data API v3's free quota is 10,000 units/day and `search.list` costs
100 units — roughly 100 searches/day shared across all users. A skill like
"Kafka" repeats across many resumes/JDs, so:

- Add a small store, e.g. `src/store/studyLinkCache.ts`, keyed by normalized
  skill string (`kafka`, not `"Kafka "`), TTL ~14 days, same in-memory/
  file-backed pattern as the existing stores in `src/store/`.
- `youtubeSearch.ts` checks the cache before calling the API and writes
  through after a successful call.

## 5. Fetch strategy: lazy, not eager

Don't fetch links when suggestions are generated
(`generateGapSuggestions.ts`) — that would burn quota for every skill gap on
every score, including ones the user never looks at. Instead:

- New endpoint `POST /api/suggestions/:id/study-links` in
  `src/server/routes.ts`, mirroring the existing suggestion-response routes.
  Validates `suggestion.gapType === "skill"`, calls
  `youtubeSearch(suggestion.missingSkill)`, persists result onto
  `suggestion.studyLinks`, returns it.
- Frontend calls this only when the user expands/clicks a "Find resources"
  affordance on a skill card — not on page load.

## 6. Frontend (`public/app.js`, `public/styles.css`)

- In `renderSuggestionCard`, for cards where `s.gapType === "skill"`, add a
  small "Find study resources" button/link under the gap-type chip (skill
  gaps only).
- On click: `guarded()`-wrapped call to the new endpoint, then render up to
  3 results as compact link cards (title + channel, opens with
  `target="_blank" rel="noopener"`).
- Cache the fetched result in `state.cardUi[s.id].studyLinks` so re-render
  doesn't refetch.

## 7. Config exposure

Extend the existing `/api/config` endpoint (already used for
`evidenceGrades`) with `studyLinksEnabled: Boolean(process.env.YOUTUBE_API_KEY)`
so the frontend can decide whether to show the button at all vs. relying on
the fallback-search-URL path silently.

## 8. Tests

- `tests/` — mock `fetch` for `youtubeSearch.ts`: success case, no-key
  fallback, quota-exceeded fallback, cache-hit (no second fetch call).
- Route test for `/api/suggestions/:id/study-links`: 400 if gap isn't
  `skill` type, 200 with links otherwise.

## 9. Security / cost notes

- API key stays server-side only (env var), never sent to the client.
- No user-controlled free text reaches the query — only `missingSkill`,
  which comes from `rankMissingSkills` (engine-derived), not raw user input,
  so no injection concern.
- Document `YOUTUBE_API_KEY` in whatever `.env.example`/README section
  already documents `ANTHROPIC_API_KEY`.
