import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonFileIapStore } from "../services/iap-service/index.js";

async function withStore(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "iap-file-queue-"));
  const filePath = path.join(dir, "wallet.json");
  const store = new JsonFileIapStore({ filePath });
  try { await run(store, filePath); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
const transact = (store, id, delta) => store.applyTransaction("internal_coin_adjust", id, { profileId: "primary", type: "coin_adjust" }, { coins: { gameId: "game", delta } });
function holdNextWrite(store) {
  const original = store._writeSnapshot.bind(store);
  let started, resume;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  let held = false;
  store._writeSnapshot = async (staged) => {
    if (!held) { held = true; started(); await gate; }
    return original(staged);
  };
  return { entered, resume };
}

describe("file IAP shared mutation queue", () => {
  it("preserves a legacy credit overlapping a staged transactional debit", () => withStore(async (store, filePath) => {
    await transact(store, "fund", 100);
    const gate = holdNextWrite(store);
    const debit = transact(store, "spend", -40);
    await gate.entered;
    const credit = store.addCoins("primary", "game", 10);
    assert.equal((await store.getCoins("primary")).game.balance, 100);
    gate.resume();
    await Promise.all([debit, credit]);
    assert.equal((await store.getCoins("primary")).game.balance, 70);
    assert.equal((await new JsonFileIapStore({ filePath }).getCoins("primary")).game.balance, 70);
  }));

  it("serializes legacy transaction records and subscription updates with wallet commits", () => withStore(async (store, filePath) => {
    await transact(store, "fund", 100);
    const gate = holdNextWrite(store);
    const debit = transact(store, "spend", -40);
    await gate.entered;
    const record = store.recordTransaction("legacy", "record", { profileId: "primary" });
    const subscription = store.upsertSubscription("primary", { active: true, expiresAt: 1_900_000_000 });
    gate.resume();
    await Promise.all([debit, record, subscription]);
    const loaded = new JsonFileIapStore({ filePath });
    assert.equal((await loaded.getCoins("primary")).game.balance, 60);
    assert.equal((await loaded.getSubscription("primary")).active, true);
    assert.equal((await loaded.recordTransaction("legacy", "record", { profileId: "primary" })).isNew, false);
    assert.equal((await transact(loaded, "spend", -40)).isNew, false);
  }));

  it("queues existing merge mutation without re-entry deadlocks or lost debits", () => withStore(async (store, filePath) => {
    await transact(store, "fund", 100);
    await store.addCoins("secondary", "game", 20);
    const gate = holdNextWrite(store);
    const debit = transact(store, "spend", -40);
    await gate.entered;
    const merge = store.mergeProfiles("primary", "secondary");
    gate.resume();
    await Promise.all([debit, merge]);
    const loaded = new JsonFileIapStore({ filePath });
    assert.equal((await loaded.getCoins("primary")).game.balance, 80);
    assert.equal((await loaded.getCoins("secondary")).game.balance, 0);
  }));

  for (const kind of ["record", "credit", "subscription", "merge"]) {
    it(`failed legacy ${kind} persistence leaves state unchanged and queue retryable`, () => withStore(async (store, filePath) => {
      await transact(store, "fund", 100);
      await store.addCoins("secondary", "game", 20);
      const before = await fs.readFile(filePath, "utf8");
      const original = store._writeSnapshot.bind(store);
      store._writeSnapshot = async () => { throw new Error("snapshot failure"); };
      const mutate = () => {
        if (kind === "record") return store.recordTransaction("legacy", "record", { profileId: "primary" });
        if (kind === "credit") return store.addCoins("primary", "game", 10);
        if (kind === "subscription") return store.upsertSubscription("primary", { active: true });
        return store.mergeProfiles("primary", "secondary");
      };
      await assert.rejects(mutate(), /snapshot failure/);
      assert.equal(await fs.readFile(filePath, "utf8"), before);
      assert.equal((await store.getCoins("primary")).game.balance, 100);
      assert.equal((await store.getCoins("secondary")).game.balance, 20);
      assert.equal((await store.getSubscription("primary")).active, false);
      store._writeSnapshot = original;
      const result = await mutate();
      if (kind === "record") assert.equal(result.isNew, true);
      if (kind === "credit") assert.equal((await store.getCoins("primary")).game.balance, 110);
      if (kind === "subscription") assert.equal((await store.getSubscription("primary")).active, true);
      if (kind === "merge") assert.equal((await store.getCoins("primary")).game.balance, 120);
      assert.equal((await transact(store, "next", -1)).isNew, true);
    }));
  }
});
