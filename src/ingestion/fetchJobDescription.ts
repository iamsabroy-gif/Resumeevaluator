/**
 * Fetches and extracts job description text from a public URL.
 *
 * This is a single, user-initiated, user-visible fetch of a page the user is
 * already reading. It is NOT a crawler: it does not follow links off the page,
 * it does not cache results, and it does not perform background or scheduled
 * re-fetching. If this module is ever extended to do batch or scheduled
 * fetching, robots.txt compliance becomes required.
 *
 * Limitation: the fetch is server-side with no browser, no cookies, and no
 * access to the user's login session. Only publicly-visible job postings work.
 * Login-walled postings return a login/paywall page, caught by the minimum-
 * length sanity check below.
 */

import { load } from "cheerio";
import { assertFetchableUrl } from "./urlGuard.js";

const USER_AGENT = "ResumeEvaluator/1.0 (+job-description-fetch)";
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_STORED_CHARS = 100_000;        // 100 KB
const MIN_TEXT_CHARS = 200;
const MAX_REDIRECTS = 3;

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
];

class FetchError extends Error {
  readonly status: number;
  readonly isAuthWall: boolean;
  constructor(message: string, status = 400, isAuthWall = false) {
    super(message);
    this.name = "FetchError";
    this.status = status;
    this.isAuthWall = isAuthWall;
  }
}

function mapUpstreamStatus(httpStatus: number, url: string): never {
  if (httpStatus === 404) {
    throw new FetchError(
      `That job posting URL returned 404 — it may have been taken down. Paste the description manually instead.`,
      400
    );
  }
  if (httpStatus === 401 || httpStatus === 403) {
    throw new FetchError(
      `That site blocked the request (login or bot protection). The page may require you to be logged in — paste the description manually instead.`,
      400,
      true
    );
  }
  if (httpStatus >= 500) {
    throw new FetchError(
      `That site is returning an error right now (HTTP ${httpStatus}). Try again later or paste the description manually.`,
      400
    );
  }
  throw new FetchError(
    `Unexpected HTTP ${httpStatus} from ${url}. Paste the description manually instead.`,
    400
  );
}

/**
 * Manually follow redirects (max 3 hops), re-running the SSRF guard on every
 * Location header. Using redirect:"follow" would let a public URL 302 to
 * 169.254.169.254 and bypass the guard entirely.
 */
async function fetchWithGuardedRedirects(
  startUrl: string
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = startUrl;
  let hops = 0;

  while (hops <= MAX_REDIRECTS) {
    await assertFetchableUrl(currentUrl);

    const response = await fetch(currentUrl, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      },
    });

    const isRedirect =
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.has("location");

    if (!isRedirect) {
      return { response, finalUrl: currentUrl };
    }

    if (hops === MAX_REDIRECTS) {
      throw new FetchError(
        `Too many redirects (> ${MAX_REDIRECTS}) when fetching that URL. Paste the description manually instead.`
      );
    }

    const location = response.headers.get("location")!;
    // Resolve relative redirects against the current URL
    currentUrl = new URL(location, currentUrl).toString();
    hops++;
  }

  // Should be unreachable
  throw new FetchError("Redirect limit exceeded.");
}

/**
 * Stream the response body up to MAX_BODY_BYTES, then convert to text.
 * Respects Content-Length as a quick-fail but also counts streamed bytes.
 */
async function readBodyCapped(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_BYTES) {
    throw new FetchError(
      `The page is too large (Content-Length > 2 MB). Paste the description manually instead.`
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new FetchError("Could not read the response body.");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      reader.cancel();
      throw new FetchError(
        `The page exceeded the 2 MB size limit mid-stream. Paste the description manually instead.`
      );
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

interface JsonLdJobPosting {
  "@type": string;
  title?: string;
  name?: string;
  description?: string;
}

/**
 * Extract job description text from parsed HTML.
 * Priority: JSON-LD JobPosting → main/article/[role=main] → body.
 */
function extractText($: ReturnType<typeof load>): { text: string; title: string } {
  // Remove noisy elements before any extraction
  $("script[type!='application/ld+json'], style, nav, footer, header, aside, noscript, svg, form, iframe").remove();

  let title = "";

  // 1. JSON-LD JobPosting
  const ldScripts = $("script[type='application/ld+json']");
  for (let i = 0; i < ldScripts.length; i++) {
    try {
      const raw = $(ldScripts[i]).html() ?? "";
      const parsed = JSON.parse(raw);
      const candidates: JsonLdJobPosting[] = Array.isArray(parsed)
        ? parsed
        : parsed["@graph"]
        ? parsed["@graph"]
        : [parsed];

      for (const node of candidates) {
        if (node["@type"] === "JobPosting" && node.description) {
          // Strip HTML inside the description with cheerio
          const inner = load(node.description);
          const text = inner.text().trim();
          if (text.length >= MIN_TEXT_CHARS) {
            title = String(node.title ?? node.name ?? "").slice(0, 140);
            return { text: normalise(text), title };
          }
        }
      }
    } catch {
      // malformed JSON-LD — fall through
    }
  }

  // 2. Semantic containers
  for (const selector of ["main", "article", "[role='main']"]) {
    const el = $(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length >= MIN_TEXT_CHARS) {
        return { text: normalise(text), title };
      }
    }
  }

  // 3. Largest text block heuristic among div/section
  let bestText = "";
  $("div, section").each((_, node) => {
    const candidate = $(node).text().trim();
    if (candidate.length > bestText.length) bestText = candidate;
  });
  if (bestText.length >= MIN_TEXT_CHARS) {
    return { text: normalise(bestText), title };
  }

  // 4. Body fallback
  const bodyText = $("body").text().trim();
  return { text: normalise(bodyText), title };
}

function normalise(raw: string): string {
  return raw
    .replace(/[ \t]+/g, " ")           // collapse horizontal whitespace
    .replace(/\n{3,}/g, "\n\n")        // max 2 consecutive newlines
    .trim()
    .slice(0, MAX_STORED_CHARS);
}

export interface FetchedJd {
  text: string;
  title: string;
  finalUrl: string;
}

/**
 * Fetch a URL and extract job description text from it.
 * Throws a FetchError (status=400) on any problem; the error's `isAuthWall`
 * flag is set when the failure is specifically a login/paywall block.
 */
export async function fetchJobDescription(rawUrl: string): Promise<FetchedJd> {
  let response: Response;
  let finalUrl: string;

  try {
    ({ response, finalUrl } = await fetchWithGuardedRedirects(rawUrl));
  } catch (err: any) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new FetchError(
        "The request timed out after 10 seconds. The site may be slow — paste the description manually instead."
      );
    }
    throw err;
  }

  if (!response.ok) {
    mapUpstreamStatus(response.status, finalUrl);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const allowed = ALLOWED_CONTENT_TYPES.some((t) => contentType.includes(t));
  if (!allowed) {
    throw new FetchError(
      `That URL returned content of type "${contentType.split(";")[0].trim()}" — only HTML and plain-text pages are supported. Paste the description manually instead.`
    );
  }

  const html = await readBodyCapped(response);

  let text: string;
  let title: string;

  if (contentType.includes("text/plain")) {
    text = normalise(html);
    title = "";
  } else {
    const $ = load(html);
    // Page-level title as fallback
    const pageTitle = $("title").first().text().trim();
    const extracted = extractText($);
    text = extracted.text;
    title = extracted.title || pageTitle.slice(0, 140);
  }

  if (text.length < MIN_TEXT_CHARS) {
    throw new FetchError(
      `The page didn't contain enough readable text (got ${text.length} characters). ` +
        `It may require you to be logged in, or it may be a JavaScript-rendered page. ` +
        `Paste the description manually instead.`,
      400,
      true
    );
  }

  return { text, title, finalUrl };
}
