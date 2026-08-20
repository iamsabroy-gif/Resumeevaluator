/**
 * Engine acceptance tests.
 *
 * NOTE ON PROVENANCE: the kickoff brief refers to an existing
 * `acceptance-tests.ts` carrying spec §12's 11 test vectors, but that file was
 * not part of the delivery — only `ats-scorer.ts` was. These vectors were
 * therefore written against the behaviour the engine's own §-references
 * document (§3 weights, §5 normalisation, §6 format, §7 matching, §9
 * multiplier/knockouts, §10 orchestration, §13 porting notes), rather than
 * copied from the spec. They pin the same properties the brief describes, but
 * if the original file resurfaces it should be treated as authoritative and
 * this one reconciled against it.
 */

import {
  WEIGHTS,
  DENSITY_FULL_MARKS_TOKENS,
  RECENCY_MULTIPLIER,
  cosine,
  detectRecencyMultiplier,
  explain,
  extractAcronyms,
  extractBullets,
  findGaps,
  normalize,
  resolveDomain,
  runScore,
  scoreDensity,
  scoreFormat,
  scoreKeywordMatch,
  scoreSections,
  scoreSkillsAlignment,
  tfIdfVector,
} from "../src/engine/ats-scorer.js";
import type { SkillBank } from "../src/engine/ats-scorer.js";
import {
  assert,
  assertClose,
  assertEqual,
  assertIncludes,
  runSuite,
  test,
} from "./harness.js";

const testBank: SkillBank = {
  domain: "payments",
  display_name: "Payments",
  detect_terms: ["payment", "settlement", "chargeback"],
  skills: ["ach", "sepa", "settlement", "reconciliation", "chargeback", "kyc"],
};

// ---- Vector 1: §3 configuration ---------------------------------------

test("V1: scoring weights sum to exactly 1.0", () => {
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assertClose(sum, 1.0, 1e-9, "weights must sum to 1.0");
});

// ---- Vector 2: §5 normalisation ---------------------------------------

test("V2: normalisation lowercases, drops stopwords and single characters", () => {
  const tokens = normalize("The Quick API and a B2B ledger, in CI/CD pipelines on Node.js");
  assert(!tokens.includes("the"), "stopword 'the' should be dropped");
  assert(!tokens.includes("and"), "stopword 'and' should be dropped");
  assert(!tokens.includes("a"), "single-character token should be dropped");
  assert(tokens.includes("quick"), "content word should survive");
  // Internal ., / and - are kept so "ci/cd" and "node.js" stay single tokens.
  assert(tokens.includes("ci/cd"), `expected "ci/cd" to stay one token, got ${tokens.join(",")}`);
  assert(tokens.includes("node.js"), "dotted tokens survive intact");
});

test("V2b: the tokenizer keeps trailing punctuation on a token", () => {
  // Documented quirk rather than a bug: the token pattern allows . - / to
  // trail, so a sentence-final term keeps its full stop and therefore does
  // not match the same term written bare. It affects both the resume and the
  // JD side equally, so coverage stays symmetric — but anything comparing
  // engine tokens against a raw skill string needs to know about it.
  assertEqual(normalize("We use CI/CD."), ["use", "ci/cd."], "trailing period is retained");
  assertEqual(normalize("We use CI/CD"), ["use", "ci/cd"], "bare term has no trailing period");
});

// ---- Vector 3: §7.2 acronym extraction ---------------------------------

test("V3: acronym extraction keeps domain acronyms and drops common words", () => {
  const found = extractAcronyms("We use ACH and SEPA at PLC with THE ISO20022 spec");
  assert(found.has("ach"), "ACH should be extracted (lowercased)");
  assert(found.has("sepa"), "SEPA should be extracted");
  assert(!found.has("the"), "THE is an acronym stopword");
  assert(!found.has("plc"), "PLC is an acronym stopword");
});

// ---- Vector 4: §7.1.1 TF-IDF and cosine --------------------------------

test("V4: cosine is 1 for identical vectors and 0 when there is no overlap", () => {
  const a = normalize("settlement reconciliation chargeback");
  const b = normalize("settlement reconciliation chargeback");
  const c = normalize("nursing triage patient");
  assertClose(cosine(tfIdfVector(a, b), tfIdfVector(b, a)), 1.0, 1e-9, "identical docs");
  assertClose(cosine(tfIdfVector(a, c), tfIdfVector(c, a)), 0.0, 1e-9, "disjoint docs");
  // An empty vector must yield 0 rather than NaN.
  assertClose(cosine(new Map(), tfIdfVector(a, b)), 0.0, 1e-9, "empty vector");
});

// ---- Vector 5: §6 format quality ---------------------------------------

test("V5: format penalties apply per defect and the score floors at zero", () => {
  assertClose(scoreFormat("Clean single column resume text"), 1.0, 1e-9, "clean text");
  assertClose(scoreFormat("Name\tRole\tDates"), 0.6, 1e-9, "tab characters cost 0.4");
  assertClose(scoreFormat("Led ▪ delivery"), 0.8, 1e-9, "graphic bullet costs 0.2");
  assertClose(scoreFormat("Page 1 of 2"), 0.85, 1e-9, "header/footer noise costs 0.15");
  // Table detection needs either three pipes on one line...
  assertClose(scoreFormat("Role | Company | Dates | Location"), 0.6, 1e-9, "wide pipe row");
  // ...or pipes repeated across two or more lines.
  assertClose(scoreFormat("Role | Acme\nRole | Beta"), 0.6, 1e-9, "multi-row pipe table");
  // A single line with two pipes is prose, not a table, and is not penalised.
  assertClose(scoreFormat("Role | Company"), 1.0, 1e-9, "one narrow pipe line is not a table");
  // Every defect at once still cannot go below zero.
  assert(scoreFormat("A\t▪ Page 1 | b | c | d") >= 0, "format quality must not go negative");
});

// ---- Vector 6: §6 section structure ------------------------------------

test("V6: section structure scores found-headers over five, capped at 1.0", () => {
  const two = scoreSections("Summary\n...\nSkills\n...");
  assertClose(two.score, 2 / 5, 1e-9, "two headers out of five");
  const many = scoreSections(
    "Professional Summary\nWork Experience\nEducation\nSkills\nCertifications\n"
  );
  assertClose(many.score, 1.0, 1e-9, "more than five headers still caps at 1.0");
});

// ---- Vector 7: §6 content density --------------------------------------

test("V7: content density is tokens over the full-marks threshold, capped at 1.0", () => {
  const half = new Array(DENSITY_FULL_MARKS_TOKENS / 2).fill("settlement");
  assertClose(scoreDensity(half), 0.5, 1e-9, "half the threshold scores 0.5");
  const over = new Array(DENSITY_FULL_MARKS_TOKENS * 3).fill("settlement");
  assertClose(scoreDensity(over), 1.0, 1e-9, "past the threshold caps at 1.0");
});

// ---- Vector 8: §7.2 skills alignment never divides by zero -------------

test("V8: skills alignment falls back to the whole bank when the JD matches none", () => {
  // A JD with no bank skill and no acronym in it would otherwise give an
  // empty target set and a 0/0 division.
  const result = scoreSkillsAlignment(
    "Experienced in settlement and reconciliation",
    "We are hiring a gardener to tend the flower beds",
    testBank
  );
  assert(Number.isFinite(result.skills_alignment), "alignment must be a finite number");
  assert(result.skills_alignment >= 0 && result.skills_alignment <= 1, "alignment in [0,1]");
  assert(result.matched.length + result.missing.length > 0, "target set must not be empty");
});

test("V8b: skills alignment matches bank skills and JD acronyms present in the resume", () => {
  const result = scoreSkillsAlignment(
    "Owned ACH settlement and daily reconciliation",
    "Looking for ACH settlement experience and KYC exposure",
    testBank
  );
  assert(result.matched.includes("settlement"), "settlement is in both JD and resume");
  assert(result.matched.includes("ach"), "ACH acronym should match");
  assert(result.missing.includes("kyc"), "KYC is in the JD but not the resume");
});

// ---- Vector 9: §9 recency multiplier -----------------------------------

test("V9: recency multiplier applies only when the JD title echoes near the top", () => {
  const resume = [
    "Priya Nair",
    "Senior Settlement Operations Manager, Acme Pay",
    "Jan 2021 - Present",
    "- Owned daily settlement",
  ].join("\n");
  const jd = "Settlement Operations Manager\nWe need someone to run settlement.";
  assertClose(
    detectRecencyMultiplier(resume, jd, testBank.skills),
    RECENCY_MULTIPLIER,
    1e-9,
    "title words near the top earn the multiplier"
  );

  const buried = ["Priya Nair", ...new Array(20).fill("filler line"), "Settlement Operations Manager"].join("\n");
  assertClose(
    detectRecencyMultiplier(buried, jd, testBank.skills),
    1.0,
    1e-9,
    "title below the top lines earns nothing"
  );

  assertClose(
    detectRecencyMultiplier(resume, "", testBank.skills),
    1.0,
    1e-9,
    "no JD means no multiplier"
  );
});

// ---- Vector 10: §9 employment-gap knockouts ----------------------------

test("V10: gap detection skips education, spans adjacent lines, and ignores 'present'", () => {
  const withGap = [
    "Acme Pay 2015 - 2017",
    "Beta Corp 2020 - 2022",
  ].join("\n");
  const flags = findGaps(withGap);
  assertEqual(flags.length, 1, "a three-year gap should raise exactly one flag");
  assertIncludes(flags[0], "2017", "flag names the gap start");

  // Education dates on the line before the range must not create a gap.
  const education = [
    "B.Tech Computer Science",
    "WBUT 2011 - 2015",
    "Acme Pay 2020 - 2022",
  ].join("\n");
  assertEqual(findGaps(education).length, 0, "education ranges are excluded from gap detection");

  // A range ending in "present" is open, so nothing after it is a gap.
  const present = ["Acme Pay 2015 - Present", "Beta Corp 2020 - 2022"].join("\n");
  assertEqual(findGaps(present).length, 0, "an open-ended range cannot start a gap");
});

test("V10b: en-dash date ranges parse the same as hyphen ranges (§13 porting note)", () => {
  const enDash = ["Acme Pay 2015 – 2017", "Beta Corp 2020 – 2022"].join("\n");
  assertEqual(findGaps(enDash).length, 1, "en dash must be accepted as a range separator");
});

// ---- Vector 11: §10 orchestration --------------------------------------

test("V11: the final score is the weighted blend times the multiplier, capped and rounded", () => {
  const resume = [
    "Priya Nair",
    "Settlement Operations Manager, Acme Pay",
    "Jan 2021 - Present",
    "",
    "Professional Summary",
    "Payments operations lead.",
    "",
    "Work Experience",
    "- Owned ACH settlement and reconciliation for a merchant portfolio",
    "- Reduced chargeback ratio by 18% across the acquiring book",
    "",
    "Skills",
    "ACH, SEPA, settlement, reconciliation, chargeback",
    "",
    "Education",
    "B.Tech, WBUT 2011 - 2015",
  ].join("\n");
  const jd = "Settlement Operations Manager\nACH settlement, reconciliation and chargeback work.";

  const result = runScore(resume, jd, testBank);

  const base =
    WEIGHTS.keyword_match * result.keyword_match +
    WEIGHTS.skills_alignment * result.skills_alignment +
    WEIGHTS.format_quality * result.format_quality +
    WEIGHTS.section_structure * result.section_structure +
    WEIGHTS.content_density * result.content_density;
  const expected = Math.round(Math.min(1.0, base * result.recency_multiplier) * 1000) / 10;

  assertClose(result.final, expected, 1e-9, "final must equal the documented formula");
  assert(result.final >= 0 && result.final <= 100, "final score is a 0-100 value");
  assertEqual(result.semantic, null, "no semantic provider means semantic is null");
});

test("V11b: scoring is deterministic — the same inputs give byte-identical output", () => {
  const resume = "Settlement Manager\n- Owned ACH settlement\nSkills\nACH, SEPA";
  const jd = "Settlement Manager\nACH and SEPA settlement.";
  const first = runScore(resume, jd, testBank);
  const second = runScore(resume, jd, testBank);
  assertEqual(first, second, "the engine must be deterministic");
});

test("V11c: a supplied semantic similarity is blended in and reported", () => {
  const resume = "Settlement Manager\n- Owned ACH settlement";
  const jd = "Settlement Manager\nACH settlement.";
  const without = runScore(resume, jd, testBank);
  const with09 = runScore(resume, jd, testBank, { semanticSimilarity: 0.9 });
  assertEqual(with09.semantic, 0.9, "semantic score is reported back");
  assert(
    with09.keyword_match !== without.keyword_match,
    "a semantic score must change the keyword match"
  );
});

// ---- Supporting behaviour -----------------------------------------------

test("S1: domain resolution prefers the JD, honours a forced domain, falls back to generic", () => {
  const banks: SkillBank[] = [
    testBank,
    { domain: "healthcare", display_name: "Health", detect_terms: ["clinical", "patient"], skills: ["ehr"] },
    { domain: "generic", display_name: "Generic", detect_terms: [], skills: ["excel"] },
  ];
  assertEqual(
    resolveDomain("irrelevant resume", "settlement and chargeback work", banks),
    "payments",
    "JD detect terms win"
  );
  assertEqual(
    resolveDomain("clinical patient care", "", banks),
    "healthcare",
    "with no JD the resume is probed"
  );
  assertEqual(
    resolveDomain("clinical patient care", "settlement work", banks, "healthcare"),
    "healthcare",
    "a forced domain overrides detection"
  );
  assertEqual(
    resolveDomain("nothing recognisable here", "", banks),
    "generic",
    "generic is the fallback and never auto-wins"
  );
});

test("S2: bullet extraction recognises the documented bullet markers", () => {
  const bullets = extractBullets(
    ["- dash bullet", "• glyph bullet", "* star bullet", "· middot bullet", "not a bullet"].join("\n")
  );
  assertEqual(bullets.length, 4, "four marker styles should be recognised");
  assert(!bullets.includes("not a bullet"), "plain lines are not bullets");
});

test("S3: with no JD the keyword target falls back to the skill bank", () => {
  const { keyword_match, semantic } = scoreKeywordMatch(
    "Owned settlement and reconciliation",
    "",
    testBank.skills
  );
  assert(keyword_match > 0, "bank fallback should still produce a match");
  assertEqual(semantic, null, "no JD means no semantic blending");
});

test("S4: explain() renders the score, the breakdown and the graded flags", () => {
  const result = runScore(
    "Settlement Manager\n- responsible for settlement\nSkills\nACH",
    "Settlement Manager\nACH settlement.",
    testBank
  );
  const text = explain(result);
  assertIncludes(text, "FINAL SCORE:", "explain includes the headline score");
  assertIncludes(text, "Contribution breakdown", "explain includes the breakdown");
  assertIncludes(text, "Keyword match", "explain names each signal");
});

// Each suite runs as its own process (see run-all.ts) so the shared test
// registry can never leak between suites.
const result = await runSuite("Engine acceptance tests (spec-derived vectors)");
process.exit(result.failed === 0 ? 0 : 1);
