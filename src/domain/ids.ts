import { randomUUID } from "node:crypto";

/**
 * Prefixed ids. The prefix makes it obvious which collection an id belongs to
 * when it turns up in a log line or an API payload.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
