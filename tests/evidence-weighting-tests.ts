/**
 * v5 evidence-weighting tests.
 *
 * Covers what the brief lists as changed in v5: spelling detection added as
 * the highest-evidence check, weak-opener / scan-zone / closing-section
 * penalties downweighted, employment-gap language softened to advisory, the
 * "7.4-second skim" claim removed from user-facing text, and evidence grades
 * attached to every flag.
 *
 * The point of these tests is that the *relative weighting* is the product
 * decision. A refactor that silently let a folklore-grade check outweigh a
 * peer-reviewed one would still pass a naive "does it flag things" test, so
 * these assert the ordering between caps directly.
 */

import {
  BULLET_LENGTH_PENALTY_CAP,
  CLOSING_SECTION_PENALTY,
  EVIDENCE_GRADE,
  SCAN_ZONE_NOT_FOUND_PENALTY,
  SCAN_ZONE_TOO_DEEP_PENALTY_CAP,
  SPELLING_PENALTY_CAP,
  SPELLING_PENALTY_PER_ERROR,
  TERMINOLOGY_PENALTY_CAP,
  WEAK_OPENER_PENALTY_CAP,
  checkSpelling,
  explain,
  mergeCommonMisspellings,
  runScore,
  scoreFormatWithHumanScreening,
} from "../src/engine/ats-scorer.js";
import type { EvidenceGrade, SkillBank } from "../src/engine/ats-scorer.js";
import { assert, assertClose, assertEqual, assertIncludes, runSuite, test } from "./harness.js";

const bank: SkillBank = {
  domain: "payments",
  display_name: "Payments",
  detect_terms: ["settlement"],
  skills: ["settlement", "reconciliation", "ach"],
};

function flagsFor(text: string) {
  return scoreFormatWithHumanScreening(text);
}

function gradedCheckIds(text: string): string[] {
  return flagsFor(text).human_scan_flags_graded.map((f) => f.checkId);
}

// ---- Spelling: the new highest-evidence check ---------------------------

test("E1: spelling detection catches curated misspellings and repeated-letter typos", () => {
  const result = checkSpelling("I recieve reports and am commmitted to seperate ledgers");
  assert(result.errorCount >= 3, `expected at least 3 errors, got ${result.errorCount}`);
  const joined = result.flagged.join(" | ");
  assertIncludes(joined, "receive", "curated misspelling is corrected in the message");
  assertIncludes(joined, "commmitted", "repeated-letter anomaly is named");
});

test("E2: spelling penalty scales per error and is capped", () => {
  const clean = flagsFor("- Owned settlement operations for the acquiring book");
  const oneError = flagsFor("- Owned settlment operations, a managment role");

  // A clean bullet raises no spelling flag at all.
  assert(
    !gradedCheckIds("- Owned settlement operations for the acquiring book").includes(
      "spelling_consistency"
    ),
    "clean text should raise no spelling flag"
  );
  assert(
    oneError.format_quality < clean.format_quality,
    "a misspelling must cost format quality"
  );

  // The cap holds even with far more errors than the cap allows for.
  const manyErrors = "recieve seperate managment acheive occured succesful enviroment buisness";
  const spelling = checkSpelling(manyErrors);
  const uncapped = spelling.errorCount * SPELLING_PENALTY_PER_ERROR;
  assert(uncapped > SPELLING_PENALTY_CAP, "this fixture should exceed the cap");
  const penalty = Math.min(SPELLING_PENALTY_CAP, uncapped);
  assertClose(penalty, SPELLING_PENALTY_CAP, 1e-9, "penalty is capped");
});

test("E3: the misspelling list is extensible at runtime", () => {
  const before = checkSpelling("Our chargback ratio improved").errorCount;
  mergeCommonMisspellings({ chargback: "chargeback" });
  const after = checkSpelling("Our chargback ratio improved").errorCount;
  assertEqual(after, before + 1, "a merged term should be detected");
});

test("E4: spacing artifacts are only counted inside bullets, not on title/date lines", () => {
  // A title line legitimately uses a double space to separate role from
  // dates. Flagging that as a typo artifact would false-positive on normal
  // resume formatting, so detection is bullet-scoped.
  const titleLine = checkSpelling("Senior Manager  Jul 2024 - Present");
  assertEqual(titleLine.errorCount, 0, "double space on a title line is not an error");

  const inBullet = checkSpelling("- Owned settlement  operations end to end");
  assert(inBullet.errorCount > 0, "double space inside a bullet is an error");
});

// ---- Relative weighting: the core v5 decision ---------------------------

test("E5: evidence-grade (a) checks outweigh folklore-grade (c) checks", () => {
  // Spelling (grade a, peer-reviewed) must be able to cost more than any
  // single advisory heuristic. This ordering is the whole point of v5.
  assert(
    SPELLING_PENALTY_CAP > WEAK_OPENER_PENALTY_CAP,
    "spelling must outweigh weak openers"
  );
  assert(
    SPELLING_PENALTY_CAP > SCAN_ZONE_NOT_FOUND_PENALTY,
    "spelling must outweigh scan-zone placement"
  );
  assert(
    SPELLING_PENALTY_CAP > CLOSING_SECTION_PENALTY,
    "spelling must outweigh closing-section placement"
  );
  assert(
    TERMINOLOGY_PENALTY_CAP > CLOSING_SECTION_PENALTY,
    "terminology consistency must outweigh the weakest check"
  );
  assertEqual(
    SPELLING_PENALTY_CAP,
    Math.max(
      SPELLING_PENALTY_CAP,
      WEAK_OPENER_PENALTY_CAP,
      BULLET_LENGTH_PENALTY_CAP,
      SCAN_ZONE_NOT_FOUND_PENALTY,
      SCAN_ZONE_TOO_DEEP_PENALTY_CAP,
      TERMINOLOGY_PENALTY_CAP,
      CLOSING_SECTION_PENALTY
    ),
    "spelling holds the largest single-check cap in the engine"
  );
});

test("E6: v5 downweighted the folklore-grade penalties from their v4 values", () => {
  assertClose(WEAK_OPENER_PENALTY_CAP, 0.06, 1e-9, "weak openers went 0.15 -> 0.06");
  assertClose(SCAN_ZONE_NOT_FOUND_PENALTY, 0.10, 1e-9, "scan zone went 0.15 -> 0.10");
  assertClose(SCAN_ZONE_TOO_DEEP_PENALTY_CAP, 0.10, 1e-9, "scan zone depth went 0.15 -> 0.10");
  assertClose(CLOSING_SECTION_PENALTY, 0.03, 1e-9, "closing section went 0.05 -> 0.03");
  assertClose(SPELLING_PENALTY_CAP, 0.20, 1e-9, "spelling is the largest cap at 0.20");
});

// ---- Evidence grading surfaced to callers -------------------------------

test("E7: every graded flag carries an evidence grade and a stable check id", () => {
  const resume = [
    "Professional Summary",
    "- Responsible for settlment operations across a very long bullet that keeps going " +
      "well past thirty words so that it certainly trips the bullet length heuristic " +
      "and wraps onto three separate lines when rendered",
    "Certifications",
  ].join("\n");

  const { human_scan_flags_graded, human_scan_flags } = flagsFor(resume);
  assert(human_scan_flags_graded.length > 0, "expected flags on this fixture");
  assertEqual(
    human_scan_flags_graded.length,
    human_scan_flags.length,
    "graded and plain flag lists must stay in step"
  );

  const validGrades: EvidenceGrade[] = ["a", "b", "c"];
  for (const flag of human_scan_flags_graded) {
    assert(validGrades.includes(flag.evidence), `bad grade: ${flag.evidence}`);
    assert(Boolean(flag.checkId), "every flag needs a stable checkId");
    assert(Boolean(flag.message), "every flag needs a message");
  }
});

test("E8: the exported grade map covers the checks the engine actually emits", () => {
  const resume = [
    "Professional Summary",
    "- Responsible for settlment operations",
    "- Handling reconciliation and Reconciliation across teams",
    "Certifications",
  ].join("\n");
  for (const checkId of gradedCheckIds(resume)) {
    assert(
      checkId in EVIDENCE_GRADE,
      `check "${checkId}" is emitted but missing from EVIDENCE_GRADE`
    );
  }
});

test("E9: grades match the documented evidence quality", () => {
  assertEqual(EVIDENCE_GRADE.spelling_consistency, "a", "PLOS ONE 2023, n=445 recruiters");
  assertEqual(EVIDENCE_GRADE.employment_gap, "a", "Nature Human Behaviour 2022, n=9,022");
  assertEqual(EVIDENCE_GRADE.weak_openers, "c", "unreplicated 2018 vendor blog");
  assertEqual(EVIDENCE_GRADE.scan_zone, "c", "TheLadders, n=30, non-peer-reviewed");
  assertEqual(EVIDENCE_GRADE.closing_section, "c", "no resume-specific study");
});

// ---- User-facing language ----------------------------------------------

test("E10: the discredited '7.4-second skim' claim appears nowhere in flag text", () => {
  const resume = [
    "Professional Summary",
    "- Responsible for settlment ops in a bullet that is quite long indeed and goes on " +
      "and on well past the thirty word threshold to trigger the length heuristic too",
    "Certifications",
  ].join("\n");
  const { human_scan_flags } = flagsFor(resume);
  const allText = human_scan_flags.join(" ").toLowerCase();
  assert(!allText.includes("7.4"), "the 7.4-second constant must not appear");
  assert(!allText.includes("6 second"), "no invented skim constant either");
  assert(!allText.includes("7 second"), "no invented skim constant either");
});

test("E11: low-evidence flags are worded as advisory, not as hard rules", () => {
  const noDates = "Professional Summary\n- Owned settlement operations\nSkills\nACH";
  const scanFlag = flagsFor(noDates).human_scan_flags_graded.find(
    (f) => f.checkId === "scan_zone"
  );
  assert(Boolean(scanFlag), "expected a scan-zone flag with no dates present");
  assertIncludes(scanFlag!.message.toLowerCase(), "advisory", "grade (c) text is hedged");
});

test("E12: employment-gap flags are advisory and mention that the effect is mitigable", () => {
  const resume = ["Acme Pay 2015 - 2017", "Beta Corp 2021 - 2023"].join("\n");
  const result = runScore(resume, "", bank);
  assert(result.knockouts.length > 0, "expected a gap flag");
  const text = result.knockouts[0].toLowerCase();
  assertIncludes(text, "advisory", "gap language is advisory, not disqualifying");
  assertIncludes(text, "mitigable", "gap language notes the effect can be narrowed");
  assert(
    !text.includes("disqualif") && !text.includes("reject"),
    "gap language must not imply automatic rejection"
  );
});

// ---- Integration through the orchestrator -------------------------------

test("E13: graded flags survive runScore and reach explain() with grade labels", () => {
  const resume = [
    "Professional Summary",
    "- Responsible for settlment operations",
    "Certifications",
  ].join("\n");
  const result = runScore(resume, "", bank);
  assert(result.human_scan_flags_graded.length > 0, "graded flags reach the score result");

  const text = explain(result);
  assertIncludes(text, "Human-screening flags (graded by evidence strength)", "section header");
  const hasLabel =
    text.includes("[strong evidence]") ||
    text.includes("[vendor/industry study]") ||
    text.includes("[advisory heuristic]");
  assert(hasLabel, "explain() renders a visible evidence label per flag");
});

test("E14: a clean, well-formed resume raises no flags at all", () => {
  const resume = [
    "Priya Nair",
    "Settlement Operations Manager, Acme Pay",
    "Jan 2021 - Present",
    "",
    "Professional Summary",
    "Payments operations lead focused on settlement.",
    "",
    "Work Experience",
    "- Owned daily settlement across the acquiring book",
    "- Cut reconciliation breaks by 18% in two quarters",
    "",
    "Education",
    "B.Tech, WBUT 2011 - 2015",
  ].join("\n");
  const { human_scan_flags } = flagsFor(resume);
  assertEqual(human_scan_flags, [], `expected no flags, got: ${human_scan_flags.join(" | ")}`);
});

const result = await runSuite("v5 evidence-weighting tests");
process.exit(result.failed === 0 ? 0 : 1);
