import { isDeepStrictEqual } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { validateCompareAndSwap, migrateSaveEnvelope } from "./saveConcurrency.js";
import { validateSaveEnvelope } from "./saveEnvelope.js";

export class InMemorySaveStore {
  constructor() {
    this._records = new Map();
  }

  async get(gameId, profileId) {
    const key = createKey(gameId, profileId);
    const envelope = this._records.get(key);
    return envelope ? deepClone(envelope) : null;
  }

  async put(envelope) {
    validateSaveEnvelope(envelope);
    const key = createKey(envelope.game_id, envelope.profile_id);
    const copy = deepClone(envelope);
    this._records.set(key, copy);
    return deepClone(copy);
  }

  async compareAndSwap(envelope, expectedRevision, expectedEnvelope) {
    validateCompareAndSwap(envelope, expectedRevision);
    const key = createKey(envelope.game_id, envelope.profile_id);
    const current = this._records.get(key);
    if ((current?.revision ?? null) !== expectedRevision) return { applied: false };
    if (expectedEnvelope !== undefined && !isDeepStrictEqual(current ?? null, expectedEnvelope)) return { applied: false };
    const copy = deepClone(envelope);
    const result = { applied: true, envelope: deepClone(copy) };
    this._records.set(key, copy);
    return result;
  }

  async migrateProfileGame(gameId, primaryId, secondaryId, nowSeconds) {
    if (primaryId === secondaryId) return { migrated: false };
    const primaryKey = createKey(gameId, primaryId), secondaryKey = createKey(gameId, secondaryId);
    const merged = migrateSaveEnvelope(this._records.get(primaryKey), this._records.get(secondaryKey), gameId, primaryId, secondaryId, nowSeconds);
    if (!merged) return { migrated: false };
    const copy = deepClone(merged);
    this._records.set(primaryKey, copy);
    this._records.delete(secondaryKey);
    return { migrated: true };
  }

  async listByProfile(profileId) {
    const profile = String(profileId || "").trim();
    const out = [];
    for (const row of this._records.values()) {
      if (String(row.profile_id || "") === profile) {
        out.push(deepClone(row));
      }
    }
    return out;
  }

  async deleteByGameAndProfile(gameId, profileId) {
    this._records.delete(createKey(gameId, profileId));
  }
}

export class JsonFileSaveStore extends InMemorySaveStore {
  constructor(options = {}) {
    super();
    const filePath = String(options.filePath || "").trim();
    if (!filePath) throw new Error("JsonFileSaveStore filePath is required");
    this._filePath = filePath;
    this._writeQueue = Promise.resolve();
  }
  async get(gameId, profileId) { await this._ensureLoaded(); return super.get(gameId, profileId); }
  async listByProfile(profileId) { await this._ensureLoaded(); return super.listByProfile(profileId); }
  async put(envelope) { return this._mutate((stage) => stage.put(envelope)); }
  async deleteByGameAndProfile(gameId, profileId) { return this._mutate((stage) => stage.deleteByGameAndProfile(gameId, profileId)); }
  async compareAndSwap(envelope, expectedRevision, expectedEnvelope) {
    return this._mutate((stage) => stage.compareAndSwap(envelope, expectedRevision, expectedEnvelope), (result) => result.applied);
  }
  async migrateProfileGame(gameId, primaryId, secondaryId, nowSeconds) {
    return this._mutate((stage) => stage.migrateProfileGame(gameId, primaryId, secondaryId, nowSeconds), (result) => result.migrated);
  }
  async _mutate(mutation, shouldWrite = () => true) {
    const operation = this._writeQueue.then(async () => {
      await this._ensureLoaded();
      const stage = new InMemorySaveStore();
      stage._records = new Map(this._records);
      const result = await mutation(stage);
      if (shouldWrite(result)) {
        await this._writeSnapshot(stage._records);
        this._records = stage._records;
      }
      return result;
    });
    this._writeQueue = operation.catch(() => {});
    return operation;
  }
  async _ensureLoaded() {
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        await fs.mkdir(path.dirname(this._filePath), { recursive: true });
        try {
          const raw = await fs.readFile(this._filePath, "utf8");
          if (!raw.trim()) return;
          const rows = JSON.parse(raw);
          if (!Array.isArray(rows)) throw new Error("invalid save store file");
          const records = new Map();
          for (const row of rows) {
            validateSaveEnvelope(row);
            records.set(createKey(row.game_id, row.profile_id), row);
          }
          this._records = records;
        } catch (error) { if (error?.code !== "ENOENT") throw error; }
      })().catch((error) => { this._loadPromise = null; throw error; });
    }
    await this._loadPromise;
  }
  async _writeSnapshot(records) {
    const tempPath = `${this._filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(Array.from(records.values())), "utf8");
    await fs.rename(tempPath, this._filePath);
  }
}

function createKey(gameId, profileId) {
  const g = String(gameId || "").trim();
  const p = String(profileId || "").trim();
  if (!g || !p) {
    throw new Error("gameId and profileId are required");
  }
  return `${g}:${p}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
