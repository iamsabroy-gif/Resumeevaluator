/**
 * Tests for YouTube study-link generation, caching, fallback paths, and API routes.
 *
 * (studylinksplan.md §8)
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";

process.env.RESUME_EVALUATOR_DATA_DIR = await fs.mkdtemp(
  path.join(os.tmpdir(), "resume-evaluator-studylinks-")
);

const { test, assert, assertEqual, assertIncludes, runSuite, reportAndExit } = await import(
  "./harness.js"
);
const { youtubeSearch } = await import("../src/learning/youtubeSearch.js");
const { clearStudyLinkCache } = await import("../src/store/studyLinkCache.js");
const { suggestions: suggestionRepo, clearAll } = await import("../src/store/repositories.js");
const { router } = await import("../src/server/routes.js");
const { newId, nowIso } = await import("../src/domain/ids.js");

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.YOUTUBE_API_KEY;

// -------------------------------------------------------- YouTube Search Tests

test("no-key fallback: returns YouTube search URL when YOUTUBE_API_KEY is not set", async () => {
  delete process.env.YOUTUBE_API_KEY;
  clearStudyLinkCache();

  const links = await youtubeSearch("Kafka");
  assertEqual(links.length, 1);
  assertIncludes(links[0].url, "youtube.com/results?search_query=Kafka");
  assertIncludes(links[0].title, "Kafka");
  assertEqual(links[0].channelTitle, "YouTube Search");
});

test("API key success: parses video list from YouTube API response", async () => {
  process.env.YOUTUBE_API_KEY = "test-api-key";
  clearStudyLinkCache();

  globalThis.fetch = (async (url: string) => {
    assertIncludes(url, "googleapis.com/youtube/v3/search");
    assertIncludes(url, "key=test-api-key");
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: { videoId: "vid123" },
            snippet: {
              title: "Apache Kafka in 6 Minutes",
              channelTitle: "ByteByteGo",
              thumbnails: {
                medium: { url: "https://i.ytimg.com/vi/vid123/mqdefault.jpg" },
              },
            },
          },
          {
            id: { videoId: "vid456" },
            snippet: {
              title: "Kafka Full Course",
              channelTitle: "TechWorld with Nana",
              thumbnails: {
                default: { url: "https://i.ytimg.com/vi/vid456/default.jpg" },
              },
            },
          },
        ],
      }),
    } as any;
  }) as any;

  try {
    const links = await youtubeSearch("Kafka");
    assertEqual(links.length, 2);
    assertEqual(links[0].title, "Apache Kafka in 6 Minutes");
    assertEqual(links[0].url, "https://www.youtube.com/watch?v=vid123");
    assertEqual(links[0].channelTitle, "ByteByteGo");
    assertEqual(links[0].thumbnailUrl, "https://i.ytimg.com/vi/vid123/mqdefault.jpg");

    assertEqual(links[1].title, "Kafka Full Course");
    assertEqual(links[1].url, "https://www.youtube.com/watch?v=vid456");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("quota exceeded: falls back gracefully on 403 response", async () => {
  process.env.YOUTUBE_API_KEY = "test-api-key";
  clearStudyLinkCache();

  globalThis.fetch = (async () => {
    return {
      ok: false,
      status: 403,
      json: async () => ({ error: { message: "quotaExceeded" } }),
    } as any;
  }) as any;

  try {
    const links = await youtubeSearch("Kubernetes");
    assertEqual(links.length, 1);
    assertIncludes(links[0].url, "youtube.com/results?search_query=Kubernetes");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("network error: falls back gracefully when fetch throws", async () => {
  process.env.YOUTUBE_API_KEY = "test-api-key";
  clearStudyLinkCache();

  globalThis.fetch = (async () => {
    throw new Error("Network timeout");
  }) as any;

  try {
    const links = await youtubeSearch("GraphQL");
    assertEqual(links.length, 1);
    assertIncludes(links[0].url, "youtube.com/results?search_query=GraphQL");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cache hit: subsequent requests with same skill do not call fetch", async () => {
  process.env.YOUTUBE_API_KEY = "test-api-key";
  clearStudyLinkCache();

  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        items: [
          {
            id: { videoId: "cachedVid" },
            snippet: {
              title: "Docker Tutorial",
              channelTitle: "FreeCodeCamp",
            },
          },
        ],
      }),
    } as any;
  }) as any;

  try {
    const first = await youtubeSearch("Docker");
    assertEqual(fetchCalls, 1);
    assertEqual(first[0].title, "Docker Tutorial");

    // Case-insensitive query should hit cache
    const second = await youtubeSearch("docker");
    assertEqual(fetchCalls, 1); // no extra fetch call
    assertEqual(second[0].title, "Docker Tutorial");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ------------------------------------------------------------- Route Endpoint Tests

test("route POST /suggestions/:id/study-links: returns 400 for non-skill gap", async () => {
  await clearAll();

  const metricSug = await suggestionRepo.insert({
    id: newId("sug"),
    scoreResultId: "score-1",
    resumeId: "res-1",
    gapType: "metric",
    jdEvidence: "Unquantified bullet",
    checkId: null,
    evidence: null,
    targetBulletId: "b-1",
    status: "suggested",
    confidenceLevel: null,
    userInput: null,
    draftBullet: null,
    unquantifiedGaps: [],
    validationError: null,
    missingSkill: null,
    studyLinks: null,
    createdAt: nowIso(),
    respondedAt: null,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);

  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/suggestions/${metricSug.id}/study-links`, {
      method: "POST",
    });
    assertEqual(res.status, 400);
  } finally {
    server.close();
  }
});

test("route POST /suggestions/:id/study-links: returns 200 and persists studyLinks for skill gap", async () => {
  delete process.env.YOUTUBE_API_KEY;
  clearStudyLinkCache();

  const skillSug = await suggestionRepo.insert({
    id: newId("sug"),
    scoreResultId: "score-1",
    resumeId: "res-1",
    gapType: "skill",
    jdEvidence: 'The job description asks for "Redis"',
    checkId: "keyword_coverage",
    evidence: "b",
    targetBulletId: null,
    status: "suggested",
    confidenceLevel: null,
    userInput: null,
    draftBullet: null,
    unquantifiedGaps: [],
    validationError: null,
    missingSkill: "Redis",
    studyLinks: null,
    createdAt: nowIso(),
    respondedAt: null,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);

  const server = app.listen(0);
  const port = (server.address() as any).port;

  try {
    const res = await fetch(`http://localhost:${port}/api/suggestions/${skillSug.id}/study-links`, {
      method: "POST",
    });
    assertEqual(res.status, 200);
    const body: any = await res.json();
    assert(Array.isArray(body.studyLinks), "studyLinks should be an array");
    assertEqual(body.studyLinks.length, 1);
    assertIncludes(body.studyLinks[0].url, "youtube.com/results?search_query=Redis");

    // Verify stored in DB
    const stored = await suggestionRepo.get(skillSug.id);
    assert(stored.studyLinks !== null, "studyLinks should be persisted");
    assertEqual(stored.studyLinks?.length, 1);
  } finally {
    server.close();
    if (originalApiKey !== undefined) process.env.YOUTUBE_API_KEY = originalApiKey;
    else delete process.env.YOUTUBE_API_KEY;
  }
});

// --------------------------------------------------------------------- Run

const results = [await runSuite("Study Links & YouTube Search")];
reportAndExit(results);
