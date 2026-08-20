/**
 * Runs every test file in this directory as its own process, so each suite's
 * module-level state (temp data dirs, the shared assertion registry) never
 * leaks into another suite. Exits non-zero if any suite fails.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const SUITES = ["acceptance-tests.ts", "evidence-weighting-tests.ts", "pipeline-tests.ts"];

let anyFailed = false;
for (const suite of SUITES) {
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(here, suite)], {
    stdio: "inherit",
  });
  if (result.status !== 0) anyFailed = true;
}

process.exit(anyFailed ? 1 : 0);
