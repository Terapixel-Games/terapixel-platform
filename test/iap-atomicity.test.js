import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createIapService, InMemoryIapStore, JsonFileIapStore } from "../services/iap-service/index.js";

const providerRegistry = {
  async verifyPurchase({ provider, catalogEntry, payload }) {
    return { provider, externalTransactionId: payload.transaction_id, type: "consumable", gameId: catalogEntry.gameId, coinsDelta: catalogEntry.coins };
  }
};
const purchase = (service, id = "purchase") => service.verifyPurchase({ profileId: "player", provider: "google", productId: "coins_500_lumarush", exportTarget: "android", payload: { transaction_id: id } });
const adjust = (service, delta, key) => service.adjustCoins({ profileId: "player", gameId: "lumarush", delta, idempotencyKey: key });

for (const kind of ["memory", "file"]) {
  describe(`atomic ${kind} IAP operations`, () => {
    async function withStore(run) {
      const dir = kind === "file" ? await fs.mkdtemp(path.join(os.tmpdir(), "iap-atomic-")) : null;
      const filePath = dir ? path.join(dir, "wallet.json") : null;
      const store = dir ? new JsonFileIapStore({ filePath }) : new InMemoryIapStore();
      try { await run(store, createIapService({ store, providerRegistry }), filePath); }
      finally { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
    }

    it("concurrent duplicate purchases grant exactly once", () => withStore(async (store, service, filePath) => {
      // Legacy two-step operations must never be called by the service.
      store.recordTransaction = store.addCoins = () => { throw new Error("non-atomic path"); };
      const results = await Promise.all(Array.from({ length: 20 }, () => purchase(service)));
      assert.equal(results.filter((row) => !row.deduplicated).length, 1);
      assert.equal((await store.getCoins("player")).lumarush.balance, 500);
      if (filePath) assert.equal((await new JsonFileIapStore({ filePath }).getCoins("player")).lumarush.balance, 500);
    }));

    it("rejects overspend without consuming its success key; funded retry works", () => withStore(async (store, service) => {
      await assert.rejects(adjust(service, -60, "spend"), /insufficient coins/);
      await adjust(service, 100, "fund");
      assert.equal((await adjust(service, -60, "spend")).deduplicated, false);
      assert.equal((await adjust(service, -60, "spend")).deduplicated, true);
      assert.equal((await store.getCoins("player")).lumarush.balance, 40);
    }));

    it("serializes distinct and duplicate concurrent spends without overspending", () => withStore(async (store, service) => {
      await adjust(service, 100, "fund");
      const duplicate = await Promise.all(Array.from({ length: 12 }, () => adjust(service, -10, "same-spend")));
      assert.equal(duplicate.filter((row) => !row.deduplicated).length, 1);
      const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => adjust(service, -10, `spend-${i}`)));
      assert.equal(results.filter((row) => row.status === "fulfilled").length, 9);
      assert.equal(results.filter((row) => row.status === "rejected" && /insufficient coins/.test(row.reason.message)).length, 11);
      assert.equal((await store.getCoins("player")).lumarush.balance, 0);
    }));

    it("input/grant validation failure does not consume transaction keys", () => withStore(async (store) => {
      const record = { profileId: "player", type: "consumable" };
      await assert.rejects(store.applyTransaction("google", "invalid-grant", record, { coins: { gameId: "lumarush", delta: Infinity } }), /coin delta/);
      assert.equal((await store.applyTransaction("google", "invalid-grant", record, { coins: { gameId: "lumarush", delta: 50 } })).isNew, true);
      assert.equal((await store.getCoins("player")).lumarush.balance, 50);
    }));

    it("balance overflow rolls back the grant and leaves its key retryable", () => withStore(async (store, service) => {
      await adjust(service, 2147483647, "maximum");
      await assert.rejects(adjust(service, 1, "overflow"), /balance exceeds/);
      await adjust(service, -1, "make-room");
      assert.equal((await adjust(service, 1, "overflow")).deduplicated, false);
      assert.equal((await store.getCoins("player")).lumarush.balance, 2147483647);
    }));

    it("response-read failure after commit can be retried without a second grant", () => withStore(async (store, service) => {
      const read = store.getCoins.bind(store);
      let fail = true;
      store.getCoins = async (...args) => {
        if (fail) { fail = false; throw new Error("response read failed"); }
        return read(...args);
      };
      await assert.rejects(purchase(service), /response read failed/);
      assert.equal((await purchase(service)).deduplicated, true);
      assert.equal((await store.getCoins("player")).lumarush.balance, 500);
    }));
  });
}

describe("file IAP persistence faults", () => {
  it("does not publish an uncommitted debit while persistence is pending", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iap-file-pending-"));
    const store = new JsonFileIapStore({ filePath: path.join(dir, "wallet.json") });
    const service = createIapService({ store, providerRegistry });
    let allowWrite;
    const gate = new Promise((resolve) => { allowWrite = resolve; });
    let writeStarted;
    const started = new Promise((resolve) => { writeStarted = resolve; });
    try {
      await adjust(service, 100, "fund");
      const snapshot = store._writeSnapshot.bind(store);
      store._writeSnapshot = async (staged) => {
        writeStarted();
        await gate;
        return snapshot(staged);
      };
      const first = adjust(service, -40, "spend");
      await started;
      assert.equal((await store.getCoins("player")).lumarush.balance, 100);
      const duplicate = adjust(service, -40, "spend");
      allowWrite();
      assert.equal((await first).deduplicated, false);
      assert.equal((await duplicate).deduplicated, true);
      assert.equal((await store.getCoins("player")).lumarush.balance, 60);
    } finally {
      allowWrite();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  it("failed snapshot leaves disk, in-memory balance and success key unchanged; retry recovers", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iap-file-fault-"));
    const filePath = path.join(dir, "wallet.json");
    const store = new JsonFileIapStore({ filePath });
    const service = createIapService({ store, providerRegistry });
    try {
      await adjust(service, 100, "fund");
      const snapshot = store._writeSnapshot.bind(store);
      store._writeSnapshot = async () => { throw new Error("disk write failed"); };
      await assert.rejects(adjust(service, -40, "spend"), /disk write failed/);
      assert.equal((await store.getCoins("player")).lumarush.balance, 100);
      assert.equal((await new JsonFileIapStore({ filePath }).getCoins("player")).lumarush.balance, 100);
      store._writeSnapshot = snapshot;
      assert.equal((await adjust(service, -40, "spend")).deduplicated, false);
      assert.equal((await adjust(service, -40, "spend")).deduplicated, true);
      assert.equal((await new JsonFileIapStore({ filePath }).getCoins("player")).lumarush.balance, 60);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
