import fs from "node:fs/promises";
import path from "node:path";

export class InMemoryIapStore {
  constructor(seed = {}) {
    this._coinBalances = new Map();
    this._subscriptions = new Map();
    this._transactions = new Map();
    hydrateSeed(this, seed);
  }

  async recordTransaction(provider, externalTransactionId, record) {
    const key = txKey(provider, externalTransactionId);
    if (this._transactions.has(key)) {
      return { isNew: false, record: deepClone(this._transactions.get(key)) };
    }
    const copy = deepClone(record || {});
    this._transactions.set(key, copy);
    return { isNew: true, record: deepClone(copy) };
  }

  async getCoins(profileId) {
    const prefix = `${normalize(profileId)}:`;
    const out = {};
    for (const [key, value] of this._coinBalances.entries()) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const gameId = key.slice(prefix.length);
      out[gameId] = { balance: Math.max(0, toInt(value.balance, 0)) };
    }
    return out;
  }

  async addCoins(profileId, gameId, delta) {
    const key = balanceKey(profileId, gameId);
    const prev = this._coinBalances.get(key) || { balance: 0 };
    const next = {
      balance: Math.max(0, toInt(prev.balance, 0) + toInt(delta, 0))
    };
    this._coinBalances.set(key, next);
    return deepClone(next);
  }

  async getSubscription(profileId) {
    const value = this._subscriptions.get(normalize(profileId));
    if (!value) {
      return {
        active: false,
        status: "none"
      };
    }
    return deepClone(value);
  }

  async upsertSubscription(profileId, subscription) {
    this._subscriptions.set(normalize(profileId), deepClone(subscription || {}));
    return this.getSubscription(profileId);
  }

  async mergeProfiles(primaryProfileId, secondaryProfileId) {
    const primary = normalize(primaryProfileId);
    const secondary = normalize(secondaryProfileId);
    if (!primary || !secondary || primary === secondary) {
      return { merged: false };
    }

    const secondaryCoins = await this.getCoins(secondary);
    for (const [gameId, entry] of Object.entries(secondaryCoins)) {
      await this.addCoins(primary, gameId, toInt(entry.balance, 0));
      this._coinBalances.set(balanceKey(secondary, gameId), { balance: 0 });
    }

    const primarySub = await this.getSubscription(primary);
    const secondarySub = await this.getSubscription(secondary);
    const mergedSub = chooseSubscription(primarySub, secondarySub);
    await this.upsertSubscription(primary, mergedSub);
    await this.upsertSubscription(secondary, {
      active: false,
      status: "merged",
      merged_into_profile_id: primary
    });
    return { merged: true };
  }
}

export class JsonFileIapStore extends InMemoryIapStore {
  constructor(options = {}) {
    super();
    const filePath = String(options.filePath || "").trim();
    if (!filePath) {
      throw new Error("JsonFileIapStore filePath is required");
    }
    this._filePath = filePath;
    this._loaded = false;
    this._writeQueue = Promise.resolve();
  }

  async recordTransaction(provider, externalTransactionId, record) {
    await this._ensureLoaded();
    const result = await super.recordTransaction(
      provider,
      externalTransactionId,
      record
    );
    if (result.isNew) {
      await this._enqueueWrite();
    }
    return result;
  }

  async addCoins(profileId, gameId, delta) {
    await this._ensureLoaded();
    const result = await super.addCoins(profileId, gameId, delta);
    await this._enqueueWrite();
    return result;
  }

  async getCoins(profileId) {
    await this._ensureLoaded();
    return super.getCoins(profileId);
  }

  async getSubscription(profileId) {
    await this._ensureLoaded();
    return super.getSubscription(profileId);
  }

  async upsertSubscription(profileId, subscription) {
    await this._ensureLoaded();
    const result = await super.upsertSubscription(profileId, subscription);
    await this._enqueueWrite();
    return result;
  }

  async mergeProfiles(primaryProfileId, secondaryProfileId) {
    await this._ensureLoaded();
    const result = await super.mergeProfiles(primaryProfileId, secondaryProfileId);
    if (result.merged) {
      await this._enqueueWrite();
    }
    return result;
  }

  async _ensureLoaded() {
    if (this._loaded) {
      return;
    }
    this._loaded = true;
    await fs.mkdir(path.dirname(this._filePath), { recursive: true });
    try {
      const raw = await fs.readFile(this._filePath, "utf8");
      if (!raw.trim()) {
        return;
      }
      const parsed = JSON.parse(raw);
      hydrateSeed(this, parsed);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return;
      }
      throw error;
    }
  }

  async _enqueueWrite() {
    this._writeQueue = this._writeQueue.then(async () => {
      const serialized = JSON.stringify({
        coin_balances: Array.from(this._coinBalances.entries()).map(([k, v]) => ({
          key: k,
          value: v
        })),
        subscriptions: Array.from(this._subscriptions.entries()).map(([k, v]) => ({
          key: k,
          value: v
        })),
        transactions: Array.from(this._transactions.entries()).map(([k, v]) => ({
          key: k,
          value: v
        }))
      });
      const tmp = `${this._filePath}.tmp`;
      await fs.writeFile(tmp, serialized, "utf8");
      await fs.rename(tmp, this._filePath);
    });
    await this._writeQueue;
  }
}

function hydrateSeed(store, seed) {
  const balances = Array.isArray(seed?.coin_balances) ? seed.coin_balances : [];
  for (const row of balances) {
    const key = normalize(row?.key);
    if (!key) {
      continue;
    }
    store._coinBalances.set(key, { balance: toInt(row?.value?.balance, 0) });
  }

  const subscriptions = Array.isArray(seed?.subscriptions) ? seed.subscriptions : [];
  for (const row of subscriptions) {
    const key = normalize(row?.key);
    if (!key) {
      continue;
    }
    store._subscriptions.set(key, deepClone(row.value || {}));
  }

  const transactions = Array.isArray(seed?.transactions) ? seed.transactions : [];
  for (const row of transactions) {
    const key = normalize(row?.key);
    if (!key) {
      continue;
    }
    store._transactions.set(key, deepClone(row.value || {}));
  }
}

function chooseSubscription(primarySub, secondarySub) {
  const primaryExp = toInt(primarySub?.expiresAt, 0);
  const secondaryExp = toInt(secondarySub?.expiresAt, 0);
  if (primarySub?.active && !secondarySub?.active) {
    return primarySub;
  }
  if (secondarySub?.active && !primarySub?.active) {
    return secondarySub;
  }
  return secondaryExp > primaryExp ? secondarySub : primarySub;
}

function txKey(provider, externalTransactionId) {
  return `${normalize(provider)}:${normalize(externalTransactionId)}`;
}

function balanceKey(profileId, gameId) {
  return `${normalize(profileId)}:${normalize(gameId)}`;
}

function normalize(value) {
  return String(value || "").trim().toLowerCase();
}

function toInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.floor(parsed);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
