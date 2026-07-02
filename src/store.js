import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Append-only ban log persisted to a JSON file, so history survives restarts.
 * Loaded once on startup; each new record is flushed to disk (write-temp-then-rename).
 * Write failures are logged, never thrown — a ban must never fail because of the disk.
 */
export default class BanStore {
  #file;
  #records = [];
  #ready;

  constructor(dataDir) {
    this.#file = path.join(dataDir, 'bans.json');
    this.#ready = this.#load(dataDir);
  }

  async #load(dataDir) {
    try {
      await mkdir(dataDir, { recursive: true });
      const raw = await readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      this.#records = Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[store] load error: ${err.message}`);
      this.#records = [];
    }
  }

  /** Await initial load (call once at startup). */
  async ready() {
    await this.#ready;
  }

  /** Append a record and flush. Record: { ts, userId, tag, channelIds, sample, action }. */
  async add(record) {
    await this.#ready;
    this.#records.push(record);
    try {
      const tmp = `${this.#file}.tmp`;
      await writeFile(tmp, JSON.stringify(this.#records, null, 2), 'utf8');
      await rename(tmp, this.#file);
    } catch (err) {
      console.error(`[store] could not persist ban log: ${err.message}`);
    }
  }

  /** Most-recent-first list, up to `limit`. */
  list(limit = 20) {
    return this.#records.slice(-limit).reverse();
  }

  count() {
    return this.#records.length;
  }
}
