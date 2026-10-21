import fs from "node:fs/promises";
import path from "node:path";

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
    const key = createKey(envelope.game_id, envelope.profile_id);
    const copy = deepClone(envelope);
    this._records.set(key, copy);
    return deepClone(copy);
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

export class JsonFileSaveStore {
  constructor(options = {}) {
    const filePath = String(options.filePath || "").trim();
    if (!filePath) {
      throw new Error("JsonFileSaveStore filePath is required");
    }
    this._filePath = filePath;
    this._records = new Map();
    this._loaded = false;
    this._writeQueue = Promise.resolve();
  }

  async get(gameId, profileId) {
    await this._ensureLoaded();
    const key = createKey(gameId, profileId);
    const envelope = this._records.get(key);
    return envelope ? deepClone(envelope) : null;
  }

  async put(envelope) {
    await this._ensureLoaded();
    const key = createKey(envelope.game_id, envelope.profile_id);
    const copy = deepClone(envelope);
    this._records.set(key, copy);
    await this._enqueueWrite();
    return deepClone(copy);
  }

  async listByProfile(profileId) {
    await this._ensureLoaded();
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
    await this._ensureLoaded();
    this._records.delete(createKey(gameId, profileId));
    await this._enqueueWrite();
  }

  async _ensureLoaded() {
    if (this._loaded) {
      return;
    }
    this._loaded = true;
    const parent = path.dirname(this._filePath);
    await fs.mkdir(parent, { recursive: true });
    try {
      const raw = await fs.readFile(this._filePath, "utf8");
      if (!raw.trim()) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      for (const row of parsed) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const gameId = String(row.game_id || "");
        const profileId = String(row.profile_id || "");
        if (!gameId || !profileId) {
          continue;
        }
        this._records.set(createKey(gameId, profileId), row);
      }
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async _enqueueWrite() {
    this._writeQueue = this._writeQueue.then(async () => {
      const values = Array.from(this._records.values());
      const serialized = JSON.stringify(values);
      const tempPath = `${this._filePath}.tmp`;
      await fs.writeFile(tempPath, serialized, "utf8");
      await fs.rename(tempPath, this._filePath);
    });
    await this._writeQueue;
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
