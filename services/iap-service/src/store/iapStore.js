import fs from "node:fs/promises";
import path from "node:path";
import { validateTransactionEffect } from "./transactionEffect.js";

export class InMemoryIapStore {
  constructor(seed = {}) {
    this._coinBalances = new Map();
    this._subscriptions = new Map();
    this._transactions = new Map();
    hydrateSeed(this, seed);
  }

  // No awaits between validation and publication: each call commits in one JS turn.
  async applyTransaction(provider, externalTransactionId, record, effect = {}) {
    validateTransactionEffect(record, effect);
    const key = txKey(provider, externalTransactionId);
    if (this._transactions.has(key)) {
      return { isNew: false, record: deepClone(this._transactions.get(key)) };
    }
    const copy = deepClone(record);
    const result = { isNew: true, record: deepClone(copy) };
    const subscription = effect.subscription ? deepClone(effect.subscription) : null;
    let coinKey;
    let balance;
    if (effect.coins) {
      coinKey = balanceKey(record.profileId, effect.coins.gameId);
      const current = this._coinBalances.get(coinKey)?.balance || 0;
      balance = current + effect.coins.delta;
      if (balance < 0) throw new Error("insufficient coins");
      if (!Number.isSafeInteger(balance) || balance > 2147483647) {
        throw new Error("coin balance exceeds supported range");
      }
    }
    // All potentially throwing input processing finishes before modifying state.
    if (effect.coins) this._coinBalances.set(coinKey, { balance });
    if (subscription) this._subscriptions.set(normalize(record.profileId), subscription);
    this._transactions.set(key, copy);
    return result;
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
    this._writeQueue = Promise.resolve();
  }

  async applyTransaction(provider, externalTransactionId, record, effect = {}) {
    return this._mutate(
      (staged) => staged.applyTransaction(provider, externalTransactionId, record, effect),
      (result) => result.isNew
    );
  }

  async recordTransaction(provider, externalTransactionId, record) {
    return this._mutate(
      (staged) => staged.recordTransaction(provider, externalTransactionId, record),
      (result) => result.isNew
    );
  }

  async addCoins(profileId, gameId, delta) {
    return this._mutate((staged) => staged.addCoins(profileId, gameId, delta));
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
    return this._mutate((staged) => staged.upsertSubscription(profileId, subscription));
  }

  async mergeProfiles(primaryProfileId, secondaryProfileId) {
    // Run the existing merge on the isolated in-memory stage. Its internal
    // addCoins/upsertSubscription calls must not re-enter this file queue.
    return this._mutate(
      (staged) => staged.mergeProfiles(primaryProfileId, secondaryProfileId),
      (result) => result.merged
    );
  }

  async _mutate(mutation, shouldWrite = () => true) {
    const operation = this._writeQueue.then(async () => {
      await this._ensureLoaded();
      const staged = new InMemoryIapStore();
      staged._coinBalances = new Map(this._coinBalances);
      staged._subscriptions = new Map(this._subscriptions);
      staged._transactions = new Map(this._transactions);
      const result = await mutation(staged);
      if (shouldWrite(result)) {
        await this._writeSnapshot(staged);
        this._coinBalances = staged._coinBalances;
        this._subscriptions = staged._subscriptions;
        this._transactions = staged._transactions;
      }
      return result;
    });
    // All mutation paths stage before writing; a failure leaves committed state
    // intact and cannot poison subsequent operations or consume success keys.
    this._writeQueue = operation.catch(() => {});
    return operation;
  }

  async _ensureLoaded() {
    if (!this._loadPromise) {
      this._loadPromise = (async () => {
        await fs.mkdir(path.dirname(this._filePath), { recursive: true });
        try {
          const raw = await fs.readFile(this._filePath, "utf8");
          if (raw.trim()) hydrateSeed(this, JSON.parse(raw));
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      })().catch((error) => {
        this._loadPromise = null;
        throw error;
      });
    }
    await this._loadPromise;
  }

  async _writeSnapshot(store) {
    const serialized = JSON.stringify({
      coin_balances: Array.from(store._coinBalances.entries()).map(([key, value]) => ({ key, value })),
      subscriptions: Array.from(store._subscriptions.entries()).map(([key, value]) => ({ key, value })),
      transactions: Array.from(store._transactions.entries()).map(([key, value]) => ({ key, value }))
    });
    const tmp = `${this._filePath}.tmp`;
    await fs.writeFile(tmp, serialized, "utf8");
    await fs.rename(tmp, this._filePath);
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
