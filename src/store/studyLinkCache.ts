/**
 * Study link cache (studylinksplan.md §4).
 *
 * Keyed by normalised skill string (lowercased, trimmed) so "Kafka" and
 * "kafka" share the same entry. TTL is 14 days — stale enough to save quota,
 * fresh enough that YouTube content turnover is reflected reasonably.
 *
 * The store is in-memory for the lifetime of the process. On restart the
 * cache is empty and entries are re-fetched on demand, which is fine for a
 * single-process dev/staging server. Promoting this to a file-backed store
 * (same pattern as JsonCollection) is a straightforward extension if the
 * instance is long-lived and quota pressure becomes real.
 */

import type { StudyLink } from "../domain/types.js";

const TTL_MS = 14 * 24 * 60 * 60 * 1_000; // 14 days

interface CacheEntry {
  links: StudyLink[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function normalise(skill: string): string {
  return skill.toLowerCase().trim();
}

export function getCachedStudyLinks(skill: string): StudyLink[] | null {
  const key = normalise(skill);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.links;
}

export function setCachedStudyLinks(skill: string, links: StudyLink[]): void {
  const key = normalise(skill);
  cache.set(key, { links, expiresAt: Date.now() + TTL_MS });
}

/** Exposed for tests only — wipes the entire cache. */
export function clearStudyLinkCache(): void {
  cache.clear();
}
