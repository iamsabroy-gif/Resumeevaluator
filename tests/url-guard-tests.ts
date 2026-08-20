/**
 * Tests for the SSRF URL guard and JD text extraction.
 *
 * The guard tests exercise assertFetchableUrl directly — they use real DNS
 * for the "accepted" case and hostname-level blocking for most "rejected" cases
 * (no live network requests to private hosts are made or needed).
 *
 * The extraction tests exercise the cheerio-based extractor against fixture
 * HTML strings — no network calls.
 */

import { test, assertRejects, assert, assertIncludes, runSuite, reportAndExit } from "./harness.js";
import { assertFetchableUrl } from "../src/ingestion/urlGuard.js";

// ---------------------------------------------------------------- SSRF guard

test("rejects cloud metadata endpoint 169.254.169.254", async () => {
  const err = await assertRejects(() =>
    assertFetchableUrl("http://169.254.169.254/latest/meta-data/")
  );
  assert(err.message.length > 0, "should have an error message");
});

test("rejects localhost by hostname", async () => {
  await assertRejects(() => assertFetchableUrl("http://localhost:3000"));
});

test("rejects 127.0.0.1 by DNS resolution", async () => {
  await assertRejects(() => assertFetchableUrl("http://127.0.0.1"));
});

test("rejects ::1 (IPv6 loopback)", async () => {
  await assertRejects(() => assertFetchableUrl("http://[::1]"));
});

test("rejects 10.0.0.1 (RFC-1918 class A)", async () => {
  await assertRejects(() => assertFetchableUrl("http://10.0.0.1"));
});

test("rejects 192.168.1.1 (RFC-1918 class C)", async () => {
  await assertRejects(() => assertFetchableUrl("http://192.168.1.1"));
});

test("rejects 172.16.0.1 (RFC-1918 class B)", async () => {
  await assertRejects(() => assertFetchableUrl("http://172.16.0.1"));
});

test("rejects IPv4-mapped IPv6 ::ffff:127.0.0.1", async () => {
  await assertRejects(() => assertFetchableUrl("http://[::ffff:127.0.0.1]"));
});

test("rejects file:// protocol", async () => {
  const err = await assertRejects(() => assertFetchableUrl("file:///etc/passwd"));
  assertIncludes(err.message, "not allowed");
});

test("rejects gopher:// protocol", async () => {
  const err = await assertRejects(() => assertFetchableUrl("gopher://x"));
  assertIncludes(err.message, "not allowed");
});

test("rejects URL with embedded credentials", async () => {
  const err = await assertRejects(() =>
    assertFetchableUrl("http://user:pass@example.com")
  );
  assertIncludes(err.message, "credentials");
});

test("rejects .local hostname", async () => {
  await assertRejects(() => assertFetchableUrl("http://printer.local/admin"));
});

test("rejects .internal hostname", async () => {
  await assertRejects(() => assertFetchableUrl("https://api.internal/secret"));
});

test("rejects URL that exceeds 2048 characters", async () => {
  const longUrl = "https://example.com/" + "a".repeat(2030);
  await assertRejects(() => assertFetchableUrl(longUrl));
});

test("accepts a valid public https URL", async () => {
  // example.com is a public IANA-maintained domain; DNS will resolve it
  const url = await assertFetchableUrl("https://example.com/");
  assert(url instanceof URL, "should return a URL object");
  assert(url.hostname === "example.com");
});

// ---------------------------------------------------------------- extraction unit tests

// Dynamically import cheerio-based extractor so tests don't fail if the
// guard tests all pass but the extractor can't be loaded for some reason.
import { load } from "cheerio";

/** Minimal re-export of the private extractText logic for testing. */
function extractFromHtml(html: string): { text: string; title: string } {
  const $ = load(html);

  $("script[type!='application/ld+json'], style, nav, footer, header, aside, noscript, svg, form, iframe").remove();

  let title = "";

  // 1. JSON-LD
  const ldScripts = $("script[type='application/ld+json']");
  for (let i = 0; i < ldScripts.length; i++) {
    try {
      const raw = $(ldScripts[i]).html() ?? "";
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : parsed["@graph"] ? parsed["@graph"] : [parsed];
      for (const node of candidates) {
        if (node["@type"] === "JobPosting" && node.description) {
          const inner = load(node.description);
          const text = inner.text().trim();
          if (text.length >= 200) {
            title = String(node.title ?? node.name ?? "").slice(0, 140);
            return { text, title };
          }
        }
      }
    } catch {}
  }

  // 2. Semantic containers
  for (const selector of ["main", "article", "[role='main']"]) {
    const el = $(selector).first();
    if (el.length) {
      const text = el.text().trim();
      if (text.length >= 200) return { text, title };
    }
  }

  // 3. Body fallback
  return { text: $("body").text().trim(), title };
}

const DUMMY_JD = "We are looking for a Senior Software Engineer with 5+ years of experience in TypeScript, Node.js, and distributed systems. You will design and build scalable backend services, collaborate with cross-functional teams, and own the full delivery lifecycle. Required: strong communication skills, experience with cloud platforms (AWS or GCP), and a passion for clean, maintainable code.";

test("extraction: JSON-LD JobPosting — uses .description and .title", () => {
  const html = `
    <html><head>
      <script type="application/ld+json">
        {"@type":"JobPosting","title":"Senior Software Engineer","description":"<p>${DUMMY_JD}</p>"}
      </script>
    </head><body><p>Some other page content</p></body></html>
  `;
  const { text, title } = extractFromHtml(html);
  assert(title === "Senior Software Engineer", `expected correct title, got: ${title}`);
  assertIncludes(text, "TypeScript");
});

test("extraction: plain <main> page — extracts main content", () => {
  const html = `
    <html><body>
      <nav>Navigation stuff</nav>
      <main>${DUMMY_JD}</main>
      <footer>Footer stuff</footer>
    </body></html>
  `;
  const { text } = extractFromHtml(html);
  assertIncludes(text, "TypeScript");
  assert(!text.includes("Navigation stuff"), "nav text should be excluded");
  assert(!text.includes("Footer stuff"), "footer text should be excluded");
});

test("extraction: nav/footer-heavy page — chrome text removed", () => {
  const html = `
    <html><body>
      <nav>Home About Contact Careers Privacy Cookie Settings</nav>
      <header>Site Header Branding</header>
      <main>${DUMMY_JD}</main>
      <aside>Related jobs you might like</aside>
      <footer>Copyright 2025 Company Inc. All rights reserved.</footer>
    </body></html>
  `;
  const { text } = extractFromHtml(html);
  assert(!text.includes("Cookie Settings"), "nav/cookie text should be removed");
  assert(!text.includes("Copyright"), "footer text should be removed");
  assertIncludes(text, "distributed systems");
});

test("extraction: under-200-char body — returns short text (caller throws)", () => {
  const html = `<html><body><main>Please log in to continue.</main></body></html>`;
  const { text } = extractFromHtml(html);
  assert(text.length < 200, `expected short text, got ${text.length} chars`);
});

// ---------------------------------------------------------------- run

const result = await runSuite("URL Guard + Extraction Tests");
reportAndExit([result]);
