/**
 * PDF parsing, isolated in a worker thread.
 *
 * pdf-parse bundles a very old pdf.js (v1.10, ~2017) that runs its "worker"
 * in-process via a fake-worker shim rather than a real one, and that shim
 * turned out to hold mutable state at module scope. In testing, calling
 * pdf-parse repeatedly in the same process on the *same* input buffer
 * intermittently threw "Illegal character" or "bad XRef entry" — different
 * errors, same file, no concurrency involved — which only makes sense as
 * state left over from one call corrupting the tokenizer on the next.
 *
 * Running each parse in its own worker_thread sidesteps this rather than
 * patching it: a worker gets a fresh V8 isolate and its own module registry,
 * so nothing from a previous parse (successful or not) can leak into this
 * one, and the worker is discarded afterward regardless of outcome.
 */
import { parentPort, workerData } from "node:worker_threads";

async function main() {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const parse = mod.default ?? mod;
    const buffer = Buffer.from(workerData.buffer);
    const result = await parse(buffer);
    parentPort.postMessage({ ok: true, text: result.text ?? "" });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String(err?.message ?? err) });
  }
}

main();
