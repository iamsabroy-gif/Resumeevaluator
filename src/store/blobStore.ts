/**
 * Netlify Blobs-backed collection store.
 *
 * Drop-in replacement for {@link JsonCollection} used when the app runs on
 * Netlify, where the local filesystem is ephemeral and not shared between
 * function invocations. Each collection is a single JSON blob keyed by the
 * collection name, mirroring the one-file-per-collection layout of the local
 * store so `repositories.ts` can swap between them without any other change.
 *
 * Unlike the local store, this one deliberately does NOT cache across calls:
 * a warm function container is reused between invocations, so an in-memory
 * cache would go stale the moment another container writes. Every read fetches
 * the blob fresh with strong consistency; writes are read-modify-write and
 * serialised through a per-collection promise chain.
 */

import { getStore, type Store } from "@netlify/blobs";

import type { Entity } from "./jsonStore.js";
import { NotFoundError } from "./jsonStore.js";

const STORE_NAME = process.env.NETLIFY_BLOBS_STORE ?? "resume-evaluator";

// When a Netlify API token (and site id) are provided, talk to the Netlify
// Blobs API directly, which is strongly consistent — a read always reflects the
// latest write. This is required because the app chains writes and reads across
// separate function invocations (create resume → create JD → score) with no
// human delay, and the edge context in the Lambda-compat runtime only offers
// eventual consistency. Falls back to the auto-configured store otherwise.
const BLOBS_TOKEN = process.env.NETLIFY_BLOBS_TOKEN;
const BLOBS_SITE_ID = process.env.NETLIFY_BLOBS_SITE_ID ?? process.env.SITE_ID;

function openStore(): Store {
  if (BLOBS_TOKEN && BLOBS_SITE_ID) {
    return getStore({ name: STORE_NAME, siteID: BLOBS_SITE_ID, token: BLOBS_TOKEN });
  }
  return getStore({ name: STORE_NAME });
}

export class BlobCollection<T extends Entity> {
  private storeInstance: Store | null = null;
  /** Serialises writes; every save appends to this chain. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(public readonly name: string) {}

  private store(): Store {
    if (!this.storeInstance) {
      this.storeInstance = openStore();
    }
    return this.storeInstance;
  }

  private async load(): Promise<T[]> {
    const parsed = await this.store().get(this.name, { type: "json" });
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }

  private queueSave(rows: T[]): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await this.store().setJSON(this.name, rows);
    });
    return this.writeChain;
  }

  async all(): Promise<T[]> {
    return [...(await this.load())];
  }

  async find(id: string): Promise<T | null> {
    const rows = await this.load();
    return rows.find((r) => r.id === id) ?? null;
  }

  /** Throws rather than returning null — for callers where absence is a bug. */
  async get(id: string): Promise<T> {
    const row = await this.find(id);
    if (!row) throw new NotFoundError(this.name, id);
    return row;
  }

  async filter(predicate: (row: T) => boolean): Promise<T[]> {
    return (await this.load()).filter(predicate);
  }

  async insert(row: T): Promise<T> {
    const rows = await this.load();
    if (rows.some((r) => r.id === row.id)) {
      throw new Error(`Duplicate id ${row.id} in collection ${this.name}`);
    }
    rows.push(row);
    await this.queueSave(rows);
    return row;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const rows = await this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new NotFoundError(this.name, id);
    const next = { ...rows[idx], ...patch, id } as T;
    rows[idx] = next;
    await this.queueSave(rows);
    return next;
  }

  async remove(id: string): Promise<void> {
    const rows = await this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows.splice(idx, 1);
    await this.queueSave(rows);
  }

  /** Drops every row. Used by the test harness between runs. */
  async clear(): Promise<void> {
    await this.queueSave([]);
  }
}
