/**
 * YouTube study-link search with caching (studylinksplan.md §3 & §4).
 *
 * Primary path:  GET https://www.googleapis.com/youtube/v3/search
 *                part=snippet&type=video&maxResults=3&q=<skill>+tutorial
 * Fallback path: a single StudyLink pointing at the YouTube search-results
 *                page -- used when YOUTUBE_API_KEY is absent OR when the API
 *                call fails (network error, quota exhausted 403, etc.).
 *
 * Results are cached by normalised skill name (14-day TTL) to keep quota
 * consumption low. The cache is checked before every API call and written
 * through after a successful response.
 */

import type { StudyLink } from "../domain/types.js";
import { getCachedStudyLinks, setCachedStudyLinks } from "../store/studyLinkCache.js";

const YT_SEARCH_API = "https://www.googleapis.com/youtube/v3/search";

function buildFallbackLink(skill: string): StudyLink {
  const q = encodeURIComponent(`${skill} tutorial`);
  return {
    title: `Search YouTube for "${skill}" tutorials`,
    url: `https://www.youtube.com/results?search_query=${q}`,
    thumbnailUrl: null,
    channelTitle: "YouTube Search",
  };
}

/**
 * Returns up to 3 YouTube links for the given skill keyword.
 *
 * Checks the in-memory cache first. On a cache miss, calls the API when a key
 * is present, or falls back to a search-URL stub when there is no key or the
 * API call fails. Never throws.
 */
export async function youtubeSearch(skill: string): Promise<StudyLink[]> {
  // Cache hit -- return immediately, no API call.
  const cached = getCachedStudyLinks(skill);
  if (cached) return cached;

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    const fallback = [buildFallbackLink(skill)];
    // Don't cache the fallback -- if the key is later added we should hit the
    // API on the next request.
    return fallback;
  }

  try {
    const params = new URLSearchParams({
      part: "snippet",
      type: "video",
      maxResults: "3",
      q: `${skill} tutorial`,
      key: apiKey,
    });
    const url = `${YT_SEARCH_API}?${params.toString()}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });

    // 403 quotaExceeded and other API-level failures fall back silently.
    if (!res.ok) {
      return [buildFallbackLink(skill)];
    }

    const data: any = await res.json();
    const items: any[] = data?.items ?? [];

    if (!items.length) {
      return [buildFallbackLink(skill)];
    }

    const links: StudyLink[] = items.map((item: any) => ({
      title: item.snippet?.title ?? skill,
      url: `https://www.youtube.com/watch?v=${item.id?.videoId ?? ""}`,
      thumbnailUrl:
        item.snippet?.thumbnails?.medium?.url ??
        item.snippet?.thumbnails?.default?.url ??
        null,
      channelTitle: item.snippet?.channelTitle ?? "",
    }));

    // Write through to cache on a successful API call.
    setCachedStudyLinks(skill, links);
    return links;
  } catch {
    // Network error, timeout, JSON parse failure -- always fall back.
    return [buildFallbackLink(skill)];
  }
}
