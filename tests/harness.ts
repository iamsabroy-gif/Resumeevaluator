/**
 * Minimal test harness — no runner dependency, just assertions and a summary.
 */

export interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

const registry: TestCase[] = [];

export function test(name: string, fn: () => void | Promise<void>): void {
  registry.push({ name, fn });
}

export class AssertionError extends Error {}

/**
 * Deliberately not a TS assertion-predicate function (`asserts condition`):
 * several call sites destructure this from a dynamic `await import(...)`,
 * and TS cannot preserve narrowing through that (TS2775) without an explicit
 * type annotation on every binding. No test here relies on post-assert
 * narrowing, so a plain boolean check keeps the harness usable both ways.
 */
export function assert(condition: unknown, message = "assertion failed"): void {
  if (!condition) throw new AssertionError(message);
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new AssertionError(`${message ?? "values differ"}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

export function assertClose(
  actual: number,
  expected: number,
  tolerance = 1e-9,
  message?: string
): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new AssertionError(
      `${message ?? "numbers differ"}\n  expected: ${expected} (+/- ${tolerance})\n  actual:   ${actual}`
    );
  }
}

export function assertIncludes(haystack: string, needle: string, message?: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${message ?? "substring not found"}\n  looking for: ${needle}\n  in: ${haystack.slice(0, 400)}`
    );
  }
}

export async function assertRejects(
  fn: () => Promise<unknown>,
  message?: string
): Promise<Error> {
  try {
    await fn();
  } catch (err: any) {
    return err;
  }
  throw new AssertionError(message ?? "expected the call to reject, but it resolved");
}

export interface SuiteResult {
  suite: string;
  passed: number;
  failed: number;
}

export async function runSuite(suiteName: string): Promise<SuiteResult> {
  console.log(`\n${suiteName}`);
  console.log("=".repeat(suiteName.length));
  let passed = 0;
  let failed = 0;
  for (const testCase of registry) {
    try {
      await testCase.fn();
      passed += 1;
      console.log(`  PASS  ${testCase.name}`);
    } catch (err: any) {
      failed += 1;
      console.log(`  FAIL  ${testCase.name}`);
      console.log(
        `        ${String(err?.message ?? err).split("\n").join("\n        ")}`
      );
      if (!(err instanceof AssertionError) && err?.stack) {
        console.log(`        ${err.stack.split("\n").slice(1, 4).join("\n        ")}`);
      }
    }
  }
  registry.length = 0;
  console.log(`\n  ${passed} passed, ${failed} failed`);
  return { suite: suiteName, passed, failed };
}

/** Exits non-zero when any suite had a failure. */
export function reportAndExit(results: SuiteResult[]): void {
  const totalPassed = results.reduce((n, r) => n + r.passed, 0);
  const totalFailed = results.reduce((n, r) => n + r.failed, 0);
  console.log(`\n${"=".repeat(48)}`);
  for (const r of results) {
    console.log(`  ${r.failed === 0 ? "OK  " : "FAIL"}  ${r.suite}: ${r.passed}/${r.passed + r.failed}`);
  }
  console.log(`${"=".repeat(48)}`);
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  process.exit(totalFailed === 0 ? 0 : 1);
}
