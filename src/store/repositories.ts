/**
 * The single place that knows how entities are persisted. Everything above
 * this line talks to these repositories, never to the JSON store directly.
 */

import { JsonCollection, type Entity } from "./jsonStore.js";
import { BlobCollection } from "./blobStore.js";
import type {
  Bullet,
  JobDescription,
  Resume,
  ResumeDraft,
  ResumeSuggestion,
  ScoreResultRecord,
  SkillBankRecord,
} from "../domain/types.js";

/**
 * Structural type shared by both store implementations. Everything above this
 * layer depends only on this interface, so the backing store can be chosen at
 * runtime with no other change.
 */
export type Collection<T extends Entity> = JsonCollection<T> | BlobCollection<T>;

/**
 * On Netlify the local filesystem is ephemeral, so persistence must go through
 * Netlify Blobs. Detect the deployed runtime from several signals: `NETLIFY` is
 * set at build time and often at runtime; the Blobs context and the AWS Lambda
 * function name are present in the function runtime that actually serves
 * requests. `USE_NETLIFY_BLOBS` forces it locally (e.g. with `netlify dev`).
 */
const useBlobs =
  process.env.USE_NETLIFY_BLOBS === "true" ||
  Boolean(process.env.NETLIFY) ||
  Boolean(process.env.NETLIFY_BLOBS_CONTEXT) ||
  Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

function createCollection<T extends Entity>(name: string): Collection<T> {
  return useBlobs ? new BlobCollection<T>(name) : new JsonCollection<T>(name);
}

export const resumes = createCollection<Resume>("resumes");
export const bullets = createCollection<Bullet>("bullets");
export const jobDescriptions = createCollection<JobDescription>("job_descriptions");
export const skillBanks = createCollection<SkillBankRecord>("skill_banks");
export const scoreResults = createCollection<ScoreResultRecord>("score_results");
export const suggestions = createCollection<ResumeSuggestion>("resume_suggestions");
export const drafts = createCollection<ResumeDraft>("resume_drafts");

export const collections = {
  resumes,
  bullets,
  jobDescriptions,
  skillBanks,
  scoreResults,
  suggestions,
  drafts,
};

export async function bulletsForResume(resumeId: string): Promise<Bullet[]> {
  const rows = await bullets.filter((b) => b.resumeId === resumeId);
  return rows.sort((a, b) => a.order - b.order);
}

export async function suggestionsForScore(scoreResultId: string): Promise<ResumeSuggestion[]> {
  const rows = await suggestions.filter((s) => s.scoreResultId === scoreResultId);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function draftsForResume(resumeId: string): Promise<ResumeDraft[]> {
  const rows = await drafts.filter((d) => d.resumeId === resumeId);
  return rows.sort((a, b) => a.version - b.version);
}

export async function scoresForResume(resumeId: string): Promise<ScoreResultRecord[]> {
  const rows = await scoreResults.filter((s) => s.resumeId === resumeId);
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function clearAll(): Promise<void> {
  await Promise.all(Object.values(collections).map((c) => c.clear()));
}
