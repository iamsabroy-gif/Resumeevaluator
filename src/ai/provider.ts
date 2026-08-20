/**
 * AI drafting providers.
 *
 * Two implementations behind one interface:
 *
 *  - `AnthropicProvider` — real drafting via the Messages API. The API key is
 *    read server-side from the environment and never reaches the browser,
 *    which is why all drafting goes through the backend rather than the SPA.
 *  - `StubProvider` — deterministic, offline, no key required. It is the
 *    default so the app and its tests run end to end with no credentials, and
 *    it is deliberately conservative: it only ever reorders or re-verbs text
 *    it was given, so it cannot fabricate even before validation runs.
 *
 * Structured output is enforced through the API's schema support rather than
 * by parsing free text, so a malformed response is an API-level error instead
 * of a silent mis-parse further down.
 */

import { z } from "zod";
import {
  AUTO_EDIT_SYSTEM,
  GATED_DRAFT_SYSTEM,
  autoEditUserMessage,
  gatedDraftUserMessage,
} from "./prompts.js";

export const AutoEditOutputSchema = z.object({
  revised_bullet: z.string(),
  changes_made: z.array(z.string()),
  flagged_for_review: z.boolean(),
});
export type AutoEditOutput = z.infer<typeof AutoEditOutputSchema>;

export const DraftOutputSchema = z.object({
  status: z.enum(["drafted", "insufficient"]),
  draft_bullet: z.string(),
  unquantified_gaps: z.array(z.string()),
});
export type DraftOutput = z.infer<typeof DraftOutputSchema>;

export interface AutoEditRequest {
  originalBullet: string;
  jdText: string;
  targetTerms: string[];
}

export interface DraftRequest {
  gapDescription: string;
  confidenceLevel: "yes" | "partial" | "no";
  userInput: string;
}

export interface AiProvider {
  readonly name: string;
  autoEdit(req: AutoEditRequest): Promise<AutoEditOutput>;
  draftBullet(req: DraftRequest): Promise<DraftOutput>;
}

// --------------------------------------------------------------- Anthropic

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-opus-5";

export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private clientPromise: Promise<any> | null = null;

  constructor(private readonly model: string = DEFAULT_MODEL) {}

  private async client(): Promise<any> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const mod = await import("@anthropic-ai/sdk");
        const Anthropic = (mod as any).default ?? mod;
        return new Anthropic();
      })();
    }
    return this.clientPromise;
  }

  private async parse<T>(params: {
    system: string;
    user: string;
    schema: z.ZodType<T>;
  }): Promise<T> {
    const client = await this.client();
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
    const response = await client.messages.parse({
      model: this.model,
      max_tokens: 4000,
      system: params.system,
      messages: [{ role: "user", content: params.user }],
      output_config: { format: zodOutputFormat(params.schema as any) },
    });

    // A safety decline stops the turn with no usable content; surface it
    // rather than letting `parsed_output` come back null and read as a
    // schema failure.
    if (response.stop_reason === "refusal") {
      throw new Error(
        `Model declined to draft this content (${response.stop_details?.category ?? "unspecified"})`
      );
    }
    if (!response.parsed_output) {
      throw new Error("Model response did not match the expected output schema");
    }
    return response.parsed_output as T;
  }

  async autoEdit(req: AutoEditRequest): Promise<AutoEditOutput> {
    return this.parse({
      system: AUTO_EDIT_SYSTEM,
      user: autoEditUserMessage(req),
      schema: AutoEditOutputSchema,
    });
  }

  async draftBullet(req: DraftRequest): Promise<DraftOutput> {
    return this.parse({
      system: GATED_DRAFT_SYSTEM,
      user: gatedDraftUserMessage(req),
      schema: DraftOutputSchema,
    });
  }
}

// -------------------------------------------------------------------- stub

/** Filler openers the engine penalises, mapped to a stronger equivalent. */
const OPENER_REPLACEMENTS: Record<string, string> = {
  "responsible for": "Owned",
  responsible: "Owned",
  handling: "Managed",
  handled: "Managed",
  leading: "Led",
  ensuring: "Maintained",
  ensured: "Maintained",
  "worked on": "Delivered",
  "helped with": "Supported",
  "involved in": "Delivered",
};

/** Minimum words of user input before a gated draft is attempted. */
export const MIN_USER_INPUT_WORDS = 6;

export class StubProvider implements AiProvider {
  readonly name = "stub";

  async autoEdit(req: AutoEditRequest): Promise<AutoEditOutput> {
    let revised = req.originalBullet.trim();
    const changes: string[] = [];

    // Replace a weak opener with a strong action verb. Only the opener is
    // touched — nothing else in the sentence is rewritten, so no claim can
    // change.
    const lower = revised.toLowerCase();
    for (const [weak, strong] of Object.entries(OPENER_REPLACEMENTS)) {
      if (lower.startsWith(weak)) {
        const rest = revised.slice(weak.length).replace(/^\s*(for|to|with|in)\b\s*/i, " ");
        revised = `${strong}${rest.startsWith(" ") ? "" : " "}${rest}`.replace(/\s+/g, " ").trim();
        changes.push(`Replaced weak opener "${weak}" with "${strong}"`);
        break;
      }
    }

    // Adopt the JD's exact wording where the bullet already says the same
    // thing in a different case. This is a casing swap only: a term is only
    // substituted when it is already present.
    for (const term of req.targetTerms.slice(0, 12)) {
      if (!term.trim()) continue;
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`, "i");
      const match = revised.match(re);
      if (match && match[0] !== term) {
        revised = revised.replace(re, term);
        changes.push(`Aligned "${match[0]}" to the job description's wording "${term}"`);
      }
    }

    return {
      revised_bullet: revised,
      changes_made: changes,
      // Nothing to review when the stub made no change at all.
      flagged_for_review: false,
    };
  }

  async draftBullet(req: DraftRequest): Promise<DraftOutput> {
    const input = req.userInput.trim();
    const words = input.split(/\s+/).filter(Boolean);

    if (req.confidenceLevel === "no" || words.length < MIN_USER_INPUT_WORDS) {
      return {
        status: "insufficient",
        draft_bullet: "",
        unquantified_gaps: [
          "Not enough detail to draft a bullet without inventing specifics. " +
            "Describe what you did, what you worked with, and roughly at what scale.",
        ],
      };
    }

    // Build strictly from the user's own sentence: strip a leading "I ..."
    // plus whatever verb follows it, and prepend an opener matched to their
    // stated confidence. Stripping only auxiliaries ("I was/have/had") and
    // not the main verb would leave the user's own verb in place, producing
    // a doubled-up opener like "Owned ran KYC checks" — so a short list of
    // common first-person past-tense verbs is stripped too. No detail beyond
    // that reshuffle is added.
    const LEADING_VERBS =
      "was|have|had|ran|did|led|owned|managed|handled|worked|helped|drove|built|" +
      "oversaw|performed|delivered|supported|assisted|contributed|coordinated";
    let body = input.replace(new RegExp(`^i\\s+(?:${LEADING_VERBS})?\\s*`, "i"), "").trim();
    // "ran KYC checks" -> "KYC checks" already handled above; but a plain
    // "I helped with X" needs the trailing "with" dropped too so the opener
    // reads naturally ("Contributed to X", not "Contributed to with X"). The
    // same goes for a leading weak phrase like "responsible for" left behind
    // by "I was responsible for X" — strip it the same way the auto-edit
    // pass strips it from an existing bullet, so the new opener doesn't
    // stack on top of the user's own weak opener.
    body = body.replace(/^(?:to|with|in)\s+/i, "");
    for (const weak of Object.keys(OPENER_REPLACEMENTS)) {
      const re = new RegExp(`^${weak}\\b\\s*(?:for|to|with|in)?\\s*`, "i");
      if (re.test(body)) {
        body = body.replace(re, "");
        break;
      }
    }
    // Preserve the case of an acronym-like first word (KYC, ACH, PCI DSS)
    // rather than lowercasing it into "kYC".
    const firstWord = body.match(/^[A-Za-z]+/)?.[0] ?? "";
    const looksLikeAcronym = firstWord.length >= 2 && firstWord === firstWord.toUpperCase();
    if (!looksLikeAcronym) {
      body = body.charAt(0).toLowerCase() + body.slice(1);
    }
    const opener = req.confidenceLevel === "partial" ? "Contributed to" : "Owned";
    let draft = `${opener} ${body}`;
    if (!/[.!]$/.test(draft)) draft += ".";

    const gaps: string[] = [];
    if (!/\d/.test(input)) {
      gaps.push(
        "No number in your description, so the bullet has no scale attached. " +
          "Add one yourself if you can — volume, headcount, percentage, or timeframe."
      );
    }

    return { status: "drafted", draft_bullet: draft, unquantified_gaps: gaps };
  }
}

// ------------------------------------------------------------- selection

let active: AiProvider | null = null;

/**
 * Defaults to the stub unless an Anthropic credential is present, so a fresh
 * checkout runs end to end with no configuration and never makes a surprise
 * paid API call. Set AI_PROVIDER=stub to force offline mode even with a key.
 */
export function getAiProvider(): AiProvider {
  if (active) return active;
  const requested = (process.env.AI_PROVIDER ?? "").toLowerCase();
  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  if (requested === "anthropic" || (requested !== "stub" && hasKey)) {
    active = new AnthropicProvider();
  } else {
    active = new StubProvider();
  }
  return active;
}

export function setAiProvider(provider: AiProvider): void {
  active = provider;
}
