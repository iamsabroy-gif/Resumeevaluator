/**
 * HTTP API.
 *
 * Every AI call and every scoring call happens here, server-side. The SPA
 * never holds an API key and never runs the engine itself — the browser only
 * renders what these endpoints return.
 */

import { Router } from "express";
import multer from "multer";
import { promises as fs } from "node:fs";
import path from "node:path";

import { newId, nowIso } from "../domain/ids.js";
import type { JobDescription, Resume } from "../domain/types.js";
import {
  bullets as bulletRepo,
  bulletsForResume,
  drafts as draftRepo,
  draftsForResume,
  jobDescriptions,
  resumes,
  scoreResults,
  scoresForResume,
  suggestions as suggestionRepo,
  suggestionsForScore,
} from "../store/repositories.js";
import {
  detectFileType,
  extractResumeTextFromBuffer,
} from "../ingestion/extractResumeText.js";
import { parseBullets, toBulletEntities } from "../ingestion/parseBullets.js";
import { comparabilityIssues, runScore } from "../scoring/runScore.js";
import { SKILL_BANKS } from "../scoring/skillBanks.js";
import { generateGapSuggestions } from "../suggestions/generateGapSuggestions.js";
import {
  acceptSuggestion,
  declineSuggestion,
  draftForSuggestion,
  editDraft,
  respondToSuggestion,
} from "../suggestions/stateMachine.js";
import { buildDraft, rescoreDraft } from "../drafts/buildDraft.js";
import { getAiProvider } from "../ai/provider.js";
import { getSemanticProvider } from "../scoring/semantic.js";
import { EVIDENCE_GRADE } from "../engine/ats-scorer.js";

export const UPLOAD_DIR =
  process.env.RESUME_EVALUATOR_UPLOAD_DIR ?? path.resolve(process.cwd(), "uploads");

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

/** Wraps an async handler so a rejected promise reaches the error middleware. */
function wrap(handler: (req: any, res: any) => Promise<unknown>) {
  return (req: any, res: any, next: any) => {
    handler(req, res).catch(next);
  };
}

class BadRequestError extends Error {
  readonly status = 400;
}

export const router = Router();

// ------------------------------------------------------------------ config

router.get(
  "/config",
  wrap(async (_req, res) => {
    res.json({
      aiProvider: getAiProvider().name,
      semanticProvider: getSemanticProvider().name,
      evidenceGrades: EVIDENCE_GRADE,
      domains: SKILL_BANKS.map((b) => ({
        domain: b.domain,
        display_name: b.display_name,
        skillCount: b.skills.length,
      })),
    });
  })
);

router.get(
  "/skill-banks",
  wrap(async (_req, res) => {
    res.json(SKILL_BANKS);
  })
);

// ----------------------------------------------------------------- resumes

async function createResumeFromBuffer(params: {
  buffer: Buffer;
  fileName: string;
  fileType: "pdf" | "docx" | "txt";
  userId: string;
}): Promise<{ resume: Resume; extraction: Awaited<ReturnType<typeof extractResumeTextFromBuffer>> }> {
  const extraction = await extractResumeTextFromBuffer(params.buffer, params.fileType);

  const id = newId("res");
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const stored = path.join(UPLOAD_DIR, `${id}-${path.basename(params.fileName)}`);
  await fs.writeFile(stored, params.buffer);

  const parsed = parseBullets(extraction.rawText);
  const bulletEntities = toBulletEntities(id, parsed);

  const resume: Resume = {
    id,
    userId: params.userId,
    originalFileUrl: stored,
    fileName: params.fileName,
    fileType: params.fileType,
    rawText: extraction.rawText,
    extractionConfidence: extraction.confidence,
    extractionNotes: extraction.notes,
    bulletIds: bulletEntities.map((b) => b.id),
    createdAt: nowIso(),
  };

  await resumes.insert(resume);
  for (const bullet of bulletEntities) {
    await bulletRepo.insert(bullet);
  }

  return { resume, extraction };
}

router.post(
  "/resumes",
  upload.single("file"),
  wrap(async (req, res) => {
    const userId = req.body?.userId || "local-user";
    let buffer: Buffer;
    let fileName: string;
    let fileType: "pdf" | "docx" | "txt";

    if (req.file) {
      fileName = req.file.originalname;
      const detected = detectFileType(fileName);
      if (!detected) {
        throw new BadRequestError(
          `Unsupported file type "${fileName}". Upload a PDF, DOCX, or plain-text resume.`
        );
      }
      buffer = req.file.buffer;
      fileType = detected;
    } else if (typeof req.body?.rawText === "string" && req.body.rawText.trim()) {
      buffer = Buffer.from(req.body.rawText, "utf8");
      fileName = req.body.fileName || "pasted-resume.txt";
      fileType = "txt";
    } else {
      throw new BadRequestError("Provide either an uploaded file or rawText.");
    }

    const { resume, extraction } = await createResumeFromBuffer({
      buffer,
      fileName,
      fileType,
      userId,
    });
    const bullets = await bulletsForResume(resume.id);

    res.status(201).json({
      resume,
      bullets,
      extraction: {
        confidence: extraction.confidence,
        notes: extraction.notes,
        tokenCount: extraction.tokenCount,
        garbledRatio: extraction.garbledRatio,
      },
    });
  })
);

router.get(
  "/resumes/:id",
  wrap(async (req, res) => {
    const resume = await resumes.get(req.params.id);
    const bullets = await bulletsForResume(resume.id);
    const history = await scoresForResume(resume.id);
    const resumeDrafts = await draftsForResume(resume.id);
    res.json({ resume, bullets, history, drafts: resumeDrafts });
  })
);

// -------------------------------------------------------- job descriptions

router.post(
  "/job-descriptions",
  wrap(async (req, res) => {
    const rawText = String(req.body?.rawText ?? "").trim();
    if (!rawText) throw new BadRequestError("A job description cannot be empty.");
    const firstLine = rawText.split("\n").find((l: string) => l.trim())?.trim() ?? "";
    const jd: JobDescription = {
      id: newId("jd"),
      userId: req.body?.userId || "local-user",
      rawText,
      title: firstLine.slice(0, 140),
      pastedAt: nowIso(),
    };
    await jobDescriptions.insert(jd);
    res.status(201).json(jd);
  })
);

// ------------------------------------------------------------------ scores

router.post(
  "/scores",
  wrap(async (req, res) => {
    const { resumeId, jdId, forcedDomain } = req.body ?? {};
    if (!resumeId) throw new BadRequestError("resumeId is required.");
    const outcome = await runScore(resumeId, jdId ?? null, { forcedDomain });
    res.status(201).json({
      score: outcome.record,
      explanation: outcome.explanation,
    });
  })
);

router.get(
  "/scores/:id",
  wrap(async (req, res) => {
    const score = await scoreResults.get(req.params.id);
    const cards = await suggestionsForScore(score.id);
    res.json({ score, suggestions: cards });
  })
);

// ------------------------------------------------------------- suggestions

router.post(
  "/scores/:id/suggestions",
  wrap(async (req, res) => {
    const created = await generateGapSuggestions(req.params.id);
    const all = await suggestionsForScore(req.params.id);
    res.status(201).json({ created: created.length, suggestions: all });
  })
);

router.get(
  "/scores/:id/suggestions",
  wrap(async (req, res) => {
    res.json(await suggestionsForScore(req.params.id));
  })
);

router.post(
  "/suggestions/:id/respond",
  wrap(async (req, res) => {
    const { confidenceLevel, userInput } = req.body ?? {};
    if (!["yes", "partial", "no"].includes(confidenceLevel)) {
      throw new BadRequestError('confidenceLevel must be "yes", "partial", or "no".');
    }
    if (confidenceLevel !== "no" && !String(userInput ?? "").trim()) {
      throw new BadRequestError(
        "Describe the experience in your own words — a bullet is only ever drafted from what you write here."
      );
    }
    const updated = await respondToSuggestion(req.params.id, {
      confidenceLevel,
      userInput: String(userInput ?? ""),
    });
    res.json(updated);
  })
);

router.post(
  "/suggestions/:id/retry-draft",
  wrap(async (req, res) => {
    const { userInput } = req.body ?? {};
    if (typeof userInput === "string" && userInput.trim()) {
      await suggestionRepo.update(req.params.id, { userInput: userInput.trim() });
    }
    res.json(await draftForSuggestion(req.params.id));
  })
);

router.post(
  "/suggestions/:id/edit",
  wrap(async (req, res) => {
    const text = String(req.body?.text ?? "");
    res.json(await editDraft(req.params.id, text));
  })
);

router.post(
  "/suggestions/:id/accept",
  wrap(async (req, res) => {
    res.json(await acceptSuggestion(req.params.id));
  })
);

router.post(
  "/suggestions/:id/decline",
  wrap(async (req, res) => {
    res.json(await declineSuggestion(req.params.id));
  })
);

// ------------------------------------------------------------------ drafts

router.post(
  "/drafts",
  wrap(async (req, res) => {
    const { resumeId, scoreResultId } = req.body ?? {};
    if (!resumeId || !scoreResultId) {
      throw new BadRequestError("resumeId and scoreResultId are both required.");
    }
    const result = await buildDraft(resumeId, scoreResultId);
    res.status(201).json(result);
  })
);

router.post(
  "/drafts/:id/rescore",
  wrap(async (req, res) => {
    const { draft, outcome } = await rescoreDraft(req.params.id, req.body?.jdId);
    const sourceScore = await scoreResults.get(draft.sourceScoreResultId);
    res.json({
      draft,
      before: sourceScore,
      after: outcome.record,
      delta: Math.round((outcome.record.final - sourceScore.final) * 10) / 10,
      comparability: comparabilityIssues(sourceScore, outcome.record),
      explanation: outcome.explanation,
    });
  })
);

router.get(
  "/drafts/:id",
  wrap(async (req, res) => {
    res.json(await draftRepo.get(req.params.id));
  })
);
