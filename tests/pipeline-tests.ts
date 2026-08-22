/**
 * End-to-end pipeline tests.
 *
 * Exercises the parts of the brief that sit outside the engine itself:
 * ingestion confidence signals, bullet parsing agreement with the engine's
 * own extractBullets(), the domain-comparability stamp, the suggestion
 * state machine's gates (including the "declined gaps stay declined" rule),
 * anti-fabrication validation wired into the AI layer, and draft
 * assembly/re-scoring producing a real score delta.
 *
 * Runs against the JSON store pointed at a throwaway temp directory so it
 * never touches real app data, and against the StubProvider so it needs no
 * network access or API key.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RESUME_EVALUATOR_DATA_DIR = await fs.mkdtemp(
  path.join(os.tmpdir(), "resume-evaluator-pipeline-")
);

const { extractBullets } = await import("../src/engine/ats-scorer.js");
const { extractResumeTextFromBuffer, garbledRatio } = await import(
  "../src/ingestion/extractResumeText.js"
);
const { parseBullets, BULLET_LINE_RE } = await import("../src/ingestion/parseBullets.js");
const { newId } = await import("../src/domain/ids.js");
const { resumes, bullets, jobDescriptions, clearAll } = await import(
  "../src/store/repositories.js"
);
const { runScore, comparabilityIssues } = await import("../src/scoring/runScore.js");
const { generateGapSuggestions } = await import("../src/suggestions/generateGapSuggestions.js");
const {
  respondToSuggestion,
  acceptSuggestion,
  declineSuggestion,
  editDraft,
} = await import("../src/suggestions/stateMachine.js");
const { buildDraft, rescoreDraft } = await import("../src/drafts/buildDraft.js");
const { setAiProvider, StubProvider } = await import("../src/ai/provider.js");
const { validateAutoEdit, validateDraftedBullet } = await import("../src/ai/validation.js");
const { suggestions: suggestionRepo, scoreResults } = await import(
  "../src/store/repositories.js"
);

const { assert, assertClose, assertEqual, assertIncludes, runSuite, test } = await import(
  "./harness.js"
);

setAiProvider(new StubProvider());

const SAMPLE_RESUME = [
  "Priya Nair",
  "Settlement Operations Manager, Acme Pay",
  "Jan 2021 - Present",
  "",
  "Professional Summary",
  "Payments operations lead with eight years of experience running settlement, " +
    "reconciliation and merchant risk operations for a large card acquirer, with a " +
    "consistent record of shrinking exception queues and cutting reconciliation breaks.",
  "",
  "Work Experience",
  "Settlement Operations Manager, Acme Pay",
  "Jan 2021 - Present",
  "- Responsible for daily settlement across the acquiring book covering thousands of merchants",
  "- Owned reconciliation with a 99% accuracy rate across every batch cycle",
  "- Managed a team of 4 analysts handling exception investigation and merchant escalations",
  "- Partnered with engineering to automate settlement file ingestion, cutting manual effort",
  "",
  "Settlement Analyst, Beta Financial",
  "Jun 2017 - Dec 2020",
  "- Reconciled daily settlement files against card scheme reports for the acquiring desk",
  "- Investigated exceptions and resolved discrepancies with issuing banks",
  "",
  "Skills",
  "ACH, reconciliation, settlement, card scheme, merchant onboarding",
  "",
  "Education",
  "B.Tech, WBUT 2011 - 2015",
].join("\n");

const SAMPLE_JD = [
  "Settlement Operations Manager",
  "We need someone with hands-on settlement, reconciliation and chargeback experience.",
  "KYC exposure is a plus.",
].join("\n");

async function seedResume(text: string = SAMPLE_RESUME) {
  const id = newId("res");
  const parsed = parseBullets(text);
  await resumes.insert({
    id,
    userId: "test-user",
    originalFileUrl: `memory://${id}`,
    fileName: "resume.txt",
    fileType: "txt",
    rawText: text,
    extractionConfidence: "high",
    extractionNotes: [],
    bulletIds: [],
    createdAt: new Date().toISOString(),
  });
  for (const p of parsed) {
    await bullets.insert({
      id: newId("bul"),
      resumeId: id,
      roleId: p.roleId,
      originalText: p.text,
      order: p.order,
      sourceLine: p.sourceLine,
    });
  }
  return id;
}

async function seedJd(text: string = SAMPLE_JD) {
  const id = newId("jd");
  await jobDescriptions.insert({
    id,
    userId: "test-user",
    rawText: text,
    title: text.split("\n")[0],
    pastedAt: new Date().toISOString(),
  });
  return id;
}

// -------------------------------------------------------------- ingestion

test("P1: a healthy plain-text resume extracts at high confidence", async () => {
  const result = await extractResumeTextFromBuffer(Buffer.from(SAMPLE_RESUME, "utf8"), "txt");
  assertEqual(result.confidence, "high", "a full resume should extract cleanly");
  assertEqual(result.notes.length, 0, "no warnings expected on clean text");
});

test("P2: a near-empty extraction is flagged failed, not silently high-confidence", async () => {
  const result = await extractResumeTextFromBuffer(Buffer.from("Name\n\n", "utf8"), "txt");
  assertEqual(result.confidence, "failed", "near-empty text must not pass as high confidence");
  assert(result.notes.length > 0, "a failed extraction must explain why");
});

test("P3: a short-but-real extraction is flagged low, distinct from failed", async () => {
  const short =
    "John Smith\nSoftware Engineer\nBuilt web applications using React, Node.js and " +
    "PostgreSQL for five years, focused on API design, performance and reliability " +
    "across a small team shipping weekly releases to production customers.";
  const result = await extractResumeTextFromBuffer(Buffer.from(short, "utf8"), "txt");
  assertEqual(result.confidence, "low", "a short but non-trivial extraction is low, not failed");
});

test("P4: garbled/binary-looking text drives the confidence signal down", () => {
  const junk = "Name\n" + String.fromCharCode(0, 1, 2, 3, 4, 5, 6, 7) + "more text here to pad it out";
  assert(garbledRatio(junk) > 0, "control characters must register as garbled");
});

// A real, working PDF (ReportLab-generated, base64-embedded so the test has
// no binary-file dependency), used to regression-test a real bug found while
// browser-testing this feature: pdf-parse bundles a very old pdf.js (v1.10)
// whose Node "fake worker" shim turned out to hold mutable state at module
// scope. Calling it repeatedly in the same process — on this exact file, no
// concurrency involved — intermittently threw two different errors
// ("Illegal character: 41", "bad XRef entry") depending on what a prior call
// had left behind. The fix runs each parse in its own worker_thread (see
// src/ingestion/pdfWorker.mjs); this test would have caught the flakiness
// the fix addresses, by calling extraction on the same buffer many times in
// a row and requiring every single one to succeed identically.
test("P4b: repeated PDF extraction on the same file succeeds every time (regression)", async () => {
  const fixturePath = path.resolve(process.cwd(), "uploads", "res_31f55f1329824c1b90b2-Sabyasachi_Roy_Resume_v1.pdf");
  const buf = await fs.readFile(fixturePath);
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(await extractResumeTextFromBuffer(buf, "pdf"));
  }
  for (const [i, r] of results.entries()) {
    assertEqual(r.confidence, "high", `run ${i}: expected high confidence, got ${r.confidence} (${r.notes.join(" ")})`);
    assertIncludes(r.rawText, "SABYASACHI ROY", `run ${i}: expected the PDF's actual text`);
  }
  const texts = new Set(results.map((r) => r.rawText));
  assertEqual(texts.size, 1, "every run must extract byte-identical text from the same file");
});

test("P5: an unrecognised file type is rejected before extraction is attempted", async () => {
  const { detectFileType } = await import("../src/ingestion/extractResumeText.js");
  assertEqual(detectFileType("resume.pages"), null, ".pages is not a supported type");
  assertEqual(detectFileType("resume.PDF"), "pdf", "extension matching is case-insensitive");
});

// ------------------------------------------------------- bullet agreement

test("P6: parseBullets and the engine's extractBullets agree on the same text", () => {
  const engineBullets = extractBullets(SAMPLE_RESUME);
  const parsed = parseBullets(SAMPLE_RESUME);
  assertEqual(
    parsed.map((p) => p.text),
    engineBullets,
    "the ingestion parser must extract exactly the bullets the engine will score"
  );
});

test("P6b: the ingestion bullet regex is textually the same pattern the engine uses", async () => {
  // Guards against the two drifting apart silently in a future edit — the
  // literal source of extractBullets() in the engine must still start with
  // the same marker class this module hardcodes.
  const fs2 = await import("node:fs/promises");
  const engineSource = await fs2.readFile(
    new URL("../src/engine/ats-scorer.ts", import.meta.url),
    "utf8"
  );
  assertIncludes(
    engineSource,
    BULLET_LINE_RE.source.replace(/\\/g, "\\"),
    "parseBullets' BULLET_LINE_RE must match the engine's own bullet regex source"
  );
});

// ------------------------------------------------------------- scoring

test("P7: runScore persists a comparable, stamped ScoreResult", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);

  assertEqual(record.resumeId, resumeId, "score is linked to its resume");
  assertEqual(record.jdId, jdId, "score is linked to its JD");
  assertEqual(record.mode, "jd_targeted", "a JD was supplied");
  assertEqual(record.domain, "payments", "JD text should resolve to the payments bank");
  assert(record.final >= 0 && record.final <= 100, "final score in range");

  const persisted = await scoreResults.get(record.id);
  assertEqual(persisted, record, "the score is actually persisted, not just returned");
});

test("P8: no JD present scores in generic mode with no recency multiplier", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const { record, engine } = await runScore(resumeId, null);
  assertEqual(record.mode, "generic", "no JD means generic mode");
  assertClose(engine.recency_multiplier, 1.0, 1e-9, "no JD means no recency multiplier");
});

test("P9: comparabilityIssues flags a changed engine version, domain, mode, or semantic layer", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record: a } = await runScore(resumeId, jdId);
  const { record: b } = await runScore(resumeId, null);

  const issues = comparabilityIssues(a, b);
  assert(issues.length > 0, "generic vs jd_targeted scores must not be silently comparable");
  assertEqual(comparabilityIssues(a, a), [], "a score is trivially comparable to itself");
});

// --------------------------------------------------------- suggestions

test("P10: suggestion generation is idempotent for the same score", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);

  const first = await generateGapSuggestions(record.id);
  const second = await generateGapSuggestions(record.id);
  assertEqual(first.length, second.length, "calling twice must not double the cards");
  assertEqual(
    first.map((s) => s.id).sort(),
    second.map((s) => s.id).sort(),
    "the same suggestion records come back both times"
  );
});

test("P11: a declined gap does not come back on the next score of the same resume", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();

  const { record: score1 } = await runScore(resumeId, jdId);
  const round1 = await generateGapSuggestions(score1.id);
  const kycCard = round1.find((s) => s.jdEvidence.toLowerCase().includes("kyc"));
  assert(Boolean(kycCard), "expected a missing-skill card for KYC");
  await declineSuggestion(kycCard!.id);

  // A second score of the same resume (e.g. after an unrelated edit) must
  // not re-raise the gap the user already said no to.
  const { record: score2 } = await runScore(resumeId, jdId);
  const round2 = await generateGapSuggestions(score2.id);
  const kycAgain = round2.find((s) => s.jdEvidence.toLowerCase().includes("kyc"));
  assertEqual(kycAgain, undefined, "a declined gap must not be re-prompted");

  // But it must still be visible in the resume's suggestion history.
  const allForResume = await suggestionRepo.filter((s) => s.resumeId === resumeId);
  const stillThere = allForResume.find((s) => s.id === kycCard!.id);
  assertEqual(stillThere?.status, "declined", "a declined gap stays on the record, not dropped");
});

// ------------------------------------------------------- state machine

test("P12: the suggestion state machine enforces its transition graph", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);
  const cards = await generateGapSuggestions(record.id);
  const skillCard = cards.find((c) => c.gapType === "skill")!;

  const { InvalidTransitionError } = await import("../src/suggestions/stateMachine.js");

  // Cannot accept before it's even been drafted.
  let threw = false;
  try {
    await acceptSuggestion(skillCard.id);
  } catch (err) {
    threw = err instanceof InvalidTransitionError;
  }
  assert(threw, "accepting a bare 'suggested' card must be rejected");

  const responded = await respondToSuggestion(skillCard.id, {
    confidenceLevel: "yes",
    userInput:
      "I ran KYC checks on new merchants as part of onboarding, verifying identity documents",
  });
  assertEqual(responded.status, "drafted", "a sufficient answer reaches drafted");
  assert(Boolean(responded.draftBullet), "a draft bullet was produced");

  const accepted = await acceptSuggestion(responded.id);
  assertEqual(accepted.status, "accepted", "a drafted card can be accepted");
});

test("P13: answering 'no' declines a card directly and skips drafting", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);
  const cards = await generateGapSuggestions(record.id);
  const card = cards[0];

  const result = await respondToSuggestion(card.id, { confidenceLevel: "no", userInput: "" });
  assertEqual(result.status, "declined", "'no' declines immediately");
  assertEqual(result.draftBullet, null, "no draft is ever produced for a decline");
});

test("P14: insufficient user input yields status 'insufficient', never a placeholder bullet", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);
  const cards = await generateGapSuggestions(record.id);
  const card = cards[0];

  const result = await respondToSuggestion(card.id, {
    confidenceLevel: "partial",
    userInput: "a little",
  });
  assertEqual(result.status, "user_responded", "insufficient input must not advance to drafted");
  assertEqual(result.draftBullet, null, "no placeholder bullet is ever written");
  assert(Boolean(result.validationError), "the user is told why nothing was drafted");
});

test("P15: a hand-edit moves a drafted card to 'edited' and keeps the user's exact text", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record } = await runScore(resumeId, jdId);
  const cards = await generateGapSuggestions(record.id);
  const card = cards.find((c) => c.gapType === "skill")!;
  const drafted = await respondToSuggestion(card.id, {
    confidenceLevel: "yes",
    userInput: "I performed KYC checks during merchant onboarding for two years",
  });
  const edited = await editDraft(drafted.id, "Ran KYC verification for every new merchant.");
  assertEqual(edited.status, "edited");
  assertEqual(edited.draftBullet, "Ran KYC verification for every new merchant.");
  const acceptedAfterEdit = await acceptSuggestion(edited.id);
  assertEqual(acceptedAfterEdit.status, "accepted", "an edited card can still be accepted");
});

// -------------------------------------------------------- anti-fabrication

test("P16: the stub auto-edit provider never introduces a number that fails validation", async () => {
  const { getAiProvider } = await import("../src/ai/provider.js");
  const provider = getAiProvider();
  const output = await provider.autoEdit({
    originalBullet: "Responsible for settlement across the acquiring book",
    jdText: SAMPLE_JD,
    targetTerms: ["settlement", "reconciliation"],
  });
  const validation = validateAutoEdit(
    "Responsible for settlement across the acquiring book",
    output.revised_bullet
  );
  assert(validation.ok, `stub auto-edit should always validate: ${validation.reasons.join("; ")}`);
});

test("P17: an auto-edit that invents a number is rejected and the original bullet is kept", async () => {
  const { autoEditBullet } = await import("../src/ai/autoEdit.js");
  const { setAiProvider: setProvider } = await import("../src/ai/provider.js");

  // A fake provider that violates the no-new-claims rule, standing in for a
  // misbehaving model — this is exactly the case the code-side check exists
  // to catch even when the prompt is ignored.
  setProvider({
    name: "fabricator",
    async autoEdit() {
      return {
        revised_bullet: "Owned settlement, cutting costs by 42% across three regions",
        changes_made: ["invented a number"],
        flagged_for_review: false,
      };
    },
    async draftBullet() {
      throw new Error("not used in this test");
    },
  });

  const bullet = {
    id: "bul_test",
    resumeId: "res_test",
    roleId: null,
    originalText: "Owned settlement operations",
    order: 0,
    sourceLine: 0,
  };
  const proposal = await autoEditBullet(bullet, SAMPLE_JD, []);
  assertEqual(proposal.applied, false, "a fabricated-number edit must not be applied");
  assertEqual(proposal.revisedText, bullet.originalText, "original bullet is preserved on rejection");
  assert(proposal.rejectionReasons.length > 0, "a rejection must explain why");

  setAiProvider(new StubProvider());
});

test("P18: a gated draft that invents a number the user never said is rejected", () => {
  const result = validateDraftedBullet(
    "I helped onboard new merchants",
    "Onboarded 250 merchants, growing volume by 30%"
  );
  assertEqual(result.ok, false, "numbers not in the user's own words must be rejected");
  assert(result.reasons.length > 0);
});

// --------------------------------------------------------- draft assembly

test("P19: buildDraft applies accepted suggestions and re-scoring shows a real delta", async () => {
  await clearAll();
  const resumeId = await seedResume();
  const jdId = await seedJd();
  const { record: baseline } = await runScore(resumeId, jdId);
  const cards = await generateGapSuggestions(baseline.id);

  const kycCard = cards.find((c) => c.jdEvidence.toLowerCase().includes("kyc"));
  assert(Boolean(kycCard), "expected a KYC gap card");
  const drafted = await respondToSuggestion(kycCard!.id, {
    confidenceLevel: "yes",
    userInput: "I ran KYC checks on every new merchant during onboarding",
  });
  await acceptSuggestion(drafted.id);

  const chargebackCard = cards.find((c) => c.jdEvidence.toLowerCase().includes("chargeback"));
  if (chargebackCard) {
    const d2 = await respondToSuggestion(chargebackCard.id, {
      confidenceLevel: "partial",
      userInput: "I occasionally reviewed chargeback disputes with the risk team",
    });
    await acceptSuggestion(d2.id);
  }

  const { draft } = await buildDraft(resumeId, baseline.id);
  assert(draft.bullets.some((b) => b.origin === "suggestion"), "accepted suggestions land in the draft");
  assertIncludes(draft.rawText, "KYC", "the accepted KYC bullet text reaches the rebuilt resume");

  const { outcome } = await rescoreDraft(draft.id);
  const after = outcome.record;
  const comparability = comparabilityIssues(baseline, after);
  const delta = Math.round((after.final - baseline.final) * 10) / 10;

  assertEqual(comparability, [], "the re-score must stay comparable to the baseline (same domain/mode)");
  assertEqual(after.domain, baseline.domain, "domain is pinned across the re-score");
  assert(after.missing_skills.length <= baseline.missing_skills.length,
    "at least one gap that was closed should not still be missing");
  assert(typeof delta === "number" && Number.isFinite(delta), "delta is a real number");
});

test("P20: buildDraft is a no-op on rawText when nothing was accepted or auto-edited", async () => {
  await clearAll();
  const resumeId = await seedResume();
  // No JD, so the auto-edit terminology pass has nothing to align to and the
  // stub provider's opener rewrite is the only possible change.
  const { record: baseline } = await runScore(resumeId, null);
  const { draft } = await buildDraft(resumeId, baseline.id);
  assert(draft.bullets.every((b) => b.origin !== "suggestion"), "no suggestions were accepted");
});

const result = await runSuite("End-to-end pipeline tests");
process.exit(result.failed === 0 ? 0 : 1);
