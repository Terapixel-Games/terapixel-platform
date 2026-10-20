import { it } from "node:test";
import assert from "node:assert/strict";
import { createSaveService, createSaveHttpServer, InMemorySaveStore, createDefaultSaveEnvelope } from "../services/save-service/index.js";
import { createSessionToken } from "../packages/shared-utils/index.js";

it("save HTTP exposes bounded conflicts, malformed input and storage failures distinctly", async () => {
  const store = new InMemorySaveStore();
  const envelope = createDefaultSaveEnvelope({ gameId: "game", profileId: "profile", updatedAt: 100 });
  await store.put(envelope);
  const original = store.compareAndSwap.bind(store);
  store.compareAndSwap = async () => ({ applied: false });
  const service = createSaveService({ saveStore: store, maxWriteAttempts: 2 });
  const secret = "local-save-route-test-secret";
  const token = createSessionToken({ sub: "profile" }, secret, { ttlSeconds: 600 });
  const server = createSaveHttpServer({ service, sessionSecret: secret });
  const { baseUrl } = await server.listen();
  const send = (clientEnvelope) => fetch(`${baseUrl}/v1/save/sync`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ game_id: "game", client_envelope: clientEnvelope })
  });
  try {
    let response = await send(envelope), body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.error.code, "save_conflict");
    assert.equal(body.retryable, true); assert.deepEqual(body.envelope, envelope);
    for (const malformed of ["bad", [], { ...envelope, revision: "1" }]) {
      response = await send(malformed); body = await response.json();
      assert.equal(response.status, 422); assert.equal(body.error.code, "invalid_request");
    }
    store.compareAndSwap = async () => { throw new Error("private storage detail"); };
    response = await send(envelope); body = await response.json();
    assert.equal(response.status, 500); assert.equal(body.error.code, "internal_error");
    assert.ok(!JSON.stringify(body).includes("private storage detail"));
    store.compareAndSwap = original;
    response = await send(envelope); body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.source, "merged"); assert.equal(body.envelope.revision, 2);
  } finally { await server.close(); }
});
