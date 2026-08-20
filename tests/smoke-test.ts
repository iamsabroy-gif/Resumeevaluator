/**
 * Real-world sanity check (kickoff brief: "realistic payments resume + JD").
 *
 * Not an assertion suite — a human-readable run of the full pipeline against
 * a plausible payments resume and JD, printing the graded explain() output
 * plus the gap suggestions it generates, so a person can eyeball whether the
 * numbers and language look sane before trusting the engine on real input.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.RESUME_EVALUATOR_DATA_DIR = await fs.mkdtemp(
  path.join(os.tmpdir(), "resume-evaluator-smoke-")
);

const { explain } = await import("../src/engine/ats-scorer.js");
const { newId } = await import("../src/domain/ids.js");
const { resumes, bullets, jobDescriptions } = await import("../src/store/repositories.js");
const { runScore } = await import("../src/scoring/runScore.js");
const { generateGapSuggestions } = await import("../src/suggestions/generateGapSuggestions.js");
const { parseBullets } = await import("../src/ingestion/parseBullets.js");

const RESUME = `Priya Nair
priya.nair@example.com | +91 98765 43210 | Mumbai, India

Professional Summary
Payments operations leader with 8 years running settlement, reconciliation and
merchant risk for a card acquirer. Track record of shrinking exception queues
and cutting reconciliation breaks through process automation.

Work Experience

Senior Settlement Operations Manager, Acme Pay
Mar 2021 - Present
- Responsible for daily settlement across a book of 3,000+ merchants
- Reduced chargeback ratio by 18% over two quarters by tightening dispute SLAs
- Managed a team of 5 analysts covering exception investigation
- Partnered with engineering on an ACH ingestion pipeline that cut manual
  reconciliation time by 30%

Settlement Analyst, Beta Financial Services
Jun 2016 - Feb 2021
- Reconciled daily settlement files against card scheme reports
- Investigated exceptions and resolved discrepancies with issuing banks
- Handling monthly regulatory reporting for the acquiring desk

Skills
ACH, SEPA, settlement, reconciliation, chargeback, card scheme, PCI DSS

Education
B.Tech, Computer Science, WBUT, 2012 - 2016
`;

const JD = `Senior Settlement Operations Manager

We're looking for a Senior Settlement Operations Manager to own daily
settlement, reconciliation and chargeback operations for our acquiring
business. You'll work closely with Risk and Compliance on KYC and AML
controls, and partner with Engineering on payment orchestration and
tokenization initiatives.

Requirements:
- Deep hands-on experience with ACH, SEPA and card scheme settlement
- Strong reconciliation and chargeback dispute background
- Exposure to KYC, AML and PCI DSS compliance
- Comfortable partnering with engineering on payment orchestration
`;

async function main() {
  const resumeId = newId("res");
  const parsed = parseBullets(RESUME);
  await resumes.insert({
    id: resumeId,
    userId: "smoke-test",
    originalFileUrl: `memory://${resumeId}`,
    fileName: "priya-nair-resume.txt",
    fileType: "txt",
    rawText: RESUME,
    extractionConfidence: "high",
    extractionNotes: [],
    bulletIds: [],
    createdAt: new Date().toISOString(),
  });
  for (const p of parsed) {
    await bullets.insert({
      id: newId("bul"),
      resumeId,
      roleId: p.roleId,
      originalText: p.text,
      order: p.order,
      sourceLine: p.sourceLine,
    });
  }

  const jdId = newId("jd");
  await jobDescriptions.insert({
    id: jdId,
    userId: "smoke-test",
    rawText: JD,
    title: JD.split("\n")[0],
    pastedAt: new Date().toISOString(),
  });

  const { engine, record } = await runScore(resumeId, jdId);

  console.log("=".repeat(72));
  console.log("SMOKE TEST — realistic payments resume vs. matching JD");
  console.log("=".repeat(72));
  console.log(explain(engine));
  console.log(`\nengineVersion=${record.engineVersion} domain=${record.domain} mode=${record.mode}`);

  const cards = await generateGapSuggestions(record.id);
  console.log(`\n${"-".repeat(72)}`);
  console.log(`GAP SUGGESTION CARDS (${cards.length})`);
  console.log("-".repeat(72));
  for (const card of cards) {
    console.log(`\n[${card.gapType}]${card.evidence ? ` (evidence ${card.evidence})` : ""}`);
    console.log(`  ${card.jdEvidence}`);
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    record.final >= 50
      ? "Sanity check: a well-matched resume scores in a reasonable range."
      : "WARNING: a well-matched resume scored low — investigate before trusting the engine."
  );
}

await main();
