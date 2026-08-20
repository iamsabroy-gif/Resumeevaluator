/**
 * The single place that knows how entities are persisted. Everything above
 * this line talks to these repositories, never to the JSON store directly.
 */

import { JsonCollection } from "./jsonStore.js";
import type {
  Bullet,
  JobDescription,
  Resume,
  ResumeDraft,
  ResumeSuggestion,
  ScoreResultRecord,
  SkillBankRecord,
} from "../domain/types.js";

export const resumes = new JsonCollection<Resume>("resumes");
export const bullets = new JsonCollection<Bullet>("bullets");
export const jobDescriptions = new JsonCollection<JobDescription>("job_descriptions");
export const skillBanks = new JsonCollection<SkillBankRecord>("skill_banks");
export const scoreResults = new JsonCollection<ScoreResultRecord>("score_results");
export const suggestions = new JsonCollection<ResumeSuggestion>("resume_suggestions");
export const drafts = new JsonCollection<ResumeDraft>("resume_drafts");

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
