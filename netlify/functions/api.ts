/**
 * Netlify Function entry point.
 *
 * Wraps the existing Express app with `serverless-http` so the whole `/api`
 * surface runs unchanged behind Netlify's function runtime. The `netlify.toml`
 * redirect sends every `/api/*` request here while preserving the original
 * path, so Express's `app.use("/api", router)` matches exactly as it does
 * locally. Static assets and the SPA fallback are served by Netlify's CDN, not
 * by this function.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import serverless from "serverless-http";

// The PDF parser runs in a worker thread loaded from a separate `.mjs` file.
// After bundling, that file is shipped via `included_files` at its repo path
// relative to the function root, so point the extractor at it explicitly.
// Must be set before the app (and its worker) resolve the path.
process.env.PDF_WORKER_PATH ??= path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "src",
  "ingestion",
  "pdfWorker.mjs"
);

const { createApp } = await import("../../src/server/index.js");

const handler = serverless(createApp());

export { handler };
