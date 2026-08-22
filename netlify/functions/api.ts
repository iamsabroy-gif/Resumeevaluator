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

import serverless from "serverless-http";

import { createApp } from "../../src/server/index.js";

// The PDF parser runs in a worker thread loaded from a separate `.mjs` file.
// It is shipped via `included_files` at its repo-relative path under the
// function's task root, so resolve it from there rather than `import.meta.url`
// (undefined once bundled to CommonJS). `pdfWorkerPath()` reads this lazily at
// parse time, so setting it here is in effect long before any request.
const taskRoot = process.env.LAMBDA_TASK_ROOT ?? process.cwd();
process.env.PDF_WORKER_PATH ??= path.join(
  taskRoot,
  "src",
  "ingestion",
  "pdfWorker.mjs"
);

export const handler = serverless(createApp());
