import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSaveService, createDefaultSaveEnvelope, InMemorySaveStore, JsonFileSaveStore, SaveConflictError } from "../services/save-service/index.js";
const now = 1_800_000_000;
const envelope = (payload = {}, profileId = "player", revision = 1) => createDefaultSaveEnvelope({ gameId: "game", profileId, revision, updatedAt: now, payload });
const sync = (service, clientEnvelope) => service.syncSave({ gameId: "game", profileId: "player", clientEnvelope, nowSeconds: now + 10 });
function raceFirstReads(store) {
  const get = store.get.bind(store);
  let reads = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  store.get = async (...args) => {
    const snapshot = await get(...args);
    if (reads++ < 2) { if (reads === 2) release(); await gate; }
    return snapshot;
  };
}
for (const kind of ["memory", "file"]) {
  describe(`${kind} revision-safe sync`, () => {
    async function withStore(run) {
      const dir = kind === "file" ? await fs.mkdtemp(path.join(os.tmpdir(), "save-cas-")) : null;
      const filePath = dir ? path.join(dir, "saves.json") : null;
      const store = dir ? new JsonFileSaveStore({ filePath }) : new InMemorySaveStore();
      try { await run(store, createSaveService({ saveStore: store }), filePath); }
      finally { if (dir) await fs.rm(dir, { recursive: true, force: true }); }
    }
    for (const initial of [false, true]) {
      it(`preserves both devices' progress with ${initial ? "existing" : "missing"} row and stale-read retry`, () => withStore(async (store, service, filePath) => {
        if (initial) await store.put(envelope({ server_flag: true }));
        raceFirstReads(store);
        let attempts = 0;
        const cas = store.compareAndSwap.bind(store);
        store.compareAndSwap = (...args) => { attempts++; return cas(...args); };
        await Promise.all([sync(service, envelope({ high_score: 300, device_a: true })), sync(service, envelope({ games_played: 8, device_b: true }))]);
        const result = await store.get("game", "player");
        assert.equal(result.payload.high_score, 300);
        assert.equal(result.payload.games_played, 8);
        assert.equal(result.payload.device_a, true);
        assert.equal(result.payload.device_b, true);
        if (initial) assert.equal(result.payload.server_flag, true);
        assert.ok(attempts >= 3);
        assert.equal(result.revision, initial ? 3 : 2);
        if (filePath) assert.deepEqual(await new JsonFileSaveStore({ filePath }).get("game", "player"), result);
      }));
    }
    it("rejects a stale snapshot after deletion and recreation with the same revision", () => withStore(async (store, service) => {
      await store.put(envelope({ old: true }));
      const cas = store.compareAndSwap.bind(store);
      let intercepted = false;
      store.compareAndSwap = async (...args) => {
        if (!intercepted) {
          intercepted = true;
          await store.deleteByGameAndProfile("game", "player");
          await store.put(envelope({ recreated: true, high_score: 900 }));
        }
        return cas(...args);
      };
      await sync(service, envelope({ games_played: 5 }));
      const saved = await store.get("game", "player");
      assert.equal(saved.payload.recreated, true);
      assert.equal(saved.payload.high_score, 900);
      assert.equal(saved.payload.games_played, 5);
    }));
    it("racing default creation cannot overwrite a client first write", () => withStore(async (store, service) => {
      raceFirstReads(store);
      await Promise.all([sync(service), sync(service, envelope({ high_score: 55 }))]);
      assert.equal((await store.get("game", "player")).payload.high_score, 55);
    }));
    it("bounds contention retries and returns the latest committed envelope", () => withStore(async (store) => {
      await store.put(envelope({ high_score: 75 }));
      let attempts = 0;
      store.compareAndSwap = async () => { attempts++; return { applied: false }; };
      const service = createSaveService({ saveStore: store, maxWriteAttempts: 3 });
      await assert.rejects(sync(service, envelope({ games_played: 4 })), (error) => error instanceof SaveConflictError && error.envelope.payload.high_score === 75 && error.retryable);
      assert.equal(attempts, 3);
      assert.equal((await store.get("game", "player")).payload.games_played, 0);
    }));
    it("does not consume a revision on write failure and a later retry succeeds", () => withStore(async (store, service) => {
      const cas = store.compareAndSwap.bind(store);
      store.compareAndSwap = async () => { throw new Error("storage failure"); };
      await assert.rejects(sync(service, envelope({ high_score: 25 })), /storage failure/);
      assert.equal(await store.get("game", "player"), null);
      store.compareAndSwap = cas;
      assert.equal((await sync(service, envelope({ high_score: 25 }))).envelope.revision, 1);
    }));
    it("migrates a game's source/destination atomically with concurrent primary sync", () => withStore(async (store, service) => {
      await store.put(envelope({ games_played: 9, secondary_flag: true }, "secondary"));
      await store.put(envelope({ high_score: 50 }));
      await Promise.all([service.mergeProfiles({ primaryProfileId: "player", secondaryProfileId: "secondary", nowSeconds: now + 10 }), sync(service, envelope({ high_score: 500, primary_flag: true }))]);
      const result = await store.get("game", "player");
      assert.equal(result.payload.high_score, 500);
      assert.equal(result.payload.games_played, 9);
      assert.equal(result.payload.secondary_flag, true);
      assert.equal(result.payload.primary_flag, true);
      assert.equal(await store.get("game", "secondary"), null);
      assert.deepEqual((await service.mergeProfiles({ primaryProfileId: "player", secondaryProfileId: "secondary" })).affected_games, []);
    }));
  });
}

describe("save validation and persistence boundaries", () => {
  it("rejects malformed revisions/schema versions before writing", async () => {
    const store = new InMemorySaveStore();
    const service = createSaveService({ saveStore: store });
    for (const field of ["revision", "schema_version"]) {
      for (const value of ["1", 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null]) {
        await assert.rejects(sync(service, { ...envelope(), [field]: value }), /positive safe integer/);
      }
    }
    assert.equal(await store.get("game", "player"), null);
    await assert.rejects(sync(service, { ...envelope(), payload: [] }), /payload must be an object/);
    await assert.rejects(store.compareAndSwap(envelope(), undefined), /expected revision/);
    await assert.rejects(store.compareAndSwap(envelope(), 1), /must advance/);
  });
  it("file persistence failure keeps both migration rows and retries recover", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "save-migrate-fault-"));
    const filePath = path.join(dir, "saves.json");
    const store = new JsonFileSaveStore({ filePath });
    const service = createSaveService({ saveStore: store });
    try {
      await store.put(envelope({ high_score: 15 }));
      await store.put(envelope({ games_played: 8 }, "secondary"));
      const before = await fs.readFile(filePath, "utf8");
      const persist = store._writeSnapshot.bind(store);
      store._writeSnapshot = async () => { throw new Error("snapshot failed"); };
      await assert.rejects(service.mergeProfiles({ primaryProfileId: "player", secondaryProfileId: "secondary" }), /snapshot failed/);
      assert.equal(await fs.readFile(filePath, "utf8"), before);
      assert.equal((await store.get("game", "secondary")).payload.games_played, 8);
      assert.equal((await store.get("game", "player")).payload.games_played, 0);
      await assert.rejects(sync(service, envelope({ high_score: 99 })), /snapshot failed/);
      store._writeSnapshot = persist;
      await service.mergeProfiles({ primaryProfileId: "player", secondaryProfileId: "secondary" });
      await sync(service, envelope({ high_score: 99 }));
      const loaded = new JsonFileSaveStore({ filePath });
      assert.equal((await loaded.get("game", "player")).payload.high_score, 99);
      assert.equal((await loaded.get("game", "player")).payload.games_played, 8);
      assert.equal(await loaded.get("game", "secondary"), null);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("fails closed for old adapters without conditional writes", () => {
    assert.throws(() => createSaveService({ saveStore: { get() {}, put() {} } }), /compareAndSwap is required/);
  });
});
