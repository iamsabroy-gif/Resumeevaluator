/**
 * File-backed collection store.
 *
 * Stands in for Base44's entity persistence. Each collection is one JSON file
 * under DATA_DIR. Writes are serialised through a per-collection promise chain
 * and go via a temp file + rename so a crash mid-write cannot leave a
 * half-written collection behind.
 *
 * The async signatures match what a real document DB would give you, so
 * swapping this for Base44 entities, Mongo, or Supabase is a change to
 * repositories.ts only.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

export const DATA_DIR =
  process.env.RESUME_EVALUATOR_DATA_DIR ?? path.resolve(process.cwd(), ".data");

export interface Entity {
  id: string;
}

export class JsonCollection<T extends Entity> {
  private readonly file: string;
  private cache: T[] | null = null;
  /** Serialises writes; every save appends to this chain. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(public readonly name: string) {
    this.file = path.join(DATA_DIR, `${name}.json`);
  }

  private async load(): Promise<T[]> {
    if (this.cache) return this.cache;
    try {
      const text = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(text);
      this.cache = Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch (err: any) {
      if (err?.code !== "ENOENT") {
        throw new Error(`Failed to read collection ${this.name}: ${err.message}`);
      }
      this.cache = [];
    }
    return this.cache;
  }

  private queueSave(): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.cache ?? [], null, 2), "utf8");
      await fs.rename(tmp, this.file);
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
    await this.queueSave();
    return row;
  }

  async update(id: string, patch: Partial<T>): Promise<T> {
    const rows = await this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) throw new NotFoundError(this.name, id);
    const next = { ...rows[idx], ...patch, id } as T;
    rows[idx] = next;
    await this.queueSave();
    return next;
  }

  async remove(id: string): Promise<void> {
    const rows = await this.load();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return;
    rows.splice(idx, 1);
    await this.queueSave();
  }

  /** Drops every row. Used by the test harness between runs. */
  async clear(): Promise<void> {
    this.cache = [];
    await this.queueSave();
  }
}

export class NotFoundError extends Error {
  readonly status = 404;
  constructor(collection: string, id: string) {
    super(`${collection} ${id} not found`);
    this.name = "NotFoundError";
  }
}
