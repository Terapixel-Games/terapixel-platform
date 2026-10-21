import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIdentityGatewayService, createIdentityGatewayHttpServer } from "../services/identity-gateway/index.js";
import { parseNakamaExchangeKeys } from "../services/identity-gateway/src/identityGatewayService.js";
import { verifySessionToken } from "../packages/shared-utils/index.js";

const keyA = "test-game-a-backend-key-at-least-32-bytes";
const keyB = "test-game-b-backend-key-at-least-32-bytes";
const config = JSON.stringify({ a: keyA, b: keyB });
const sessionSecret = "test-platform-session-signing-secret";

describe("Nakama exchange backend authentication", () => {
  it("rejects malformed configuration without echoing secrets", () => {
    for (const raw of ["{", "null", "[]", JSON.stringify({ A: keyA }), JSON.stringify({ a: "short" }), JSON.stringify({ a: keyA, b: keyA })]) {
      assert.throws(() => parseNakamaExchangeKeys(raw), /NAKAMA_EXCHANGE_KEYS_JSON/);
    }
  });

  it("fails closed in the service before touching identity storage", async () => {
    for (const raw of [undefined, "{}", config]) {
      const service = createIdentityGatewayService({ nakamaExchangeKeysJson: raw, identityStore: new Proxy({}, { get() { throw new Error("storage touched"); } }) });
      for (const backendKey of [undefined, "", "wrong", keyB]) {
        await assert.rejects(service.authenticateNakamaUser({ gameId: "a", nakamaUserId: "victim", backendKey }), { name: "NakamaExchangeAuthError" });
      }
    }
  });

  it("rejects unauthenticated HTTP requests and binds successful sessions to game and configured audience", async () => {
    const service = createIdentityGatewayService({ nakamaExchangeKeysJson: config, sessionSecret, sessionAudience: "test.platform" });
    const server = createIdentityGatewayHttpServer({ service, sessionSecret, internalServiceKey: "admin-key" });
    const { baseUrl } = await server.listen();
    try {
      for (const [gameId, headers] of [
        ["a", {}], ["a", { "x-nakama-exchange-key": "wrong" }],
        ["a", { "x-admin-key": "admin-key" }],
        ["a", { authorization: `Bearer ${keyA}` }],
        ["a", { "x-nakama-exchange-key": keyB }],
        ["unknown", { "x-nakama-exchange-key": keyA }]
      ]) {
        const response = await fetch(`${baseUrl}/v1/auth/nakama`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ game_id: gameId, nakama_user_id: "victim", backendKey: keyA }) });
        assert.equal(response.status, 401);
        assert.equal((await response.json()).session_token, undefined);
      }
      const before = Math.floor(Date.now() / 1000);
      const response = await fetch(`${baseUrl}/v1/auth/nakama`, { method: "POST", headers: { "content-type": "application/json", "x-nakama-exchange-key": keyA }, body: JSON.stringify({ game_id: " A ", nakama_user_id: "user-1", nowSeconds: 4_000_000_000, audience: "attacker" }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      const claims = verifySessionToken(result.session_token, sessionSecret, { issuer: "terapixel.identity", audience: "test.platform" });
      assert.equal(claims.game_id, "a");
      assert.equal(claims.nakama_user_id, "user-1");
      assert.ok(claims.iat >= before && claims.iat <= Math.floor(Date.now() / 1000));
      assert.throws(() => verifySessionToken(result.session_token, sessionSecret, { audience: "attacker" }));
    } finally { await server.close(); }
  });

  it("isolates identical user IDs across games and preserves game binding on repeat exchange", async () => {
    const service = createIdentityGatewayService({ nakamaExchangeKeysJson: config, sessionSecret });
    const a = await service.authenticateNakamaUser({ gameId: "a", nakamaUserId: "same-user", backendKey: keyA });
    const b = await service.authenticateNakamaUser({ gameId: "b", nakamaUserId: "same-user", backendKey: keyB });
    assert.notEqual(a.player.playerId, b.player.playerId);
    const again = await service.authenticateNakamaUser({ gameId: "a", nakamaUserId: "same-user", backendKey: keyA });
    assert.equal(again.isNewPlayer, false);
    assert.equal(again.player.playerId, a.player.playerId);
    assert.equal(verifySessionToken(again.sessionToken, sessionSecret, { audience: "terapixel.game" }).game_id, "a");
  });

  it("keeps public health and magic-link routes available with exchange disabled", async () => {
    let linkUrl = "";
    const service = createIdentityGatewayService({
      sessionSecret,
      magicLinkBaseUrl: "http://identity.test/v1/account/magic-link/consume",
      magicLinkEmailSender: { sendMagicLink: async (input) => { linkUrl = input.linkUrl; } }
    });
    const server = createIdentityGatewayHttpServer({ service, sessionSecret });
    const { baseUrl } = await server.listen();
    try {
      const denied = await fetch(`${baseUrl}/v1/auth/nakama`, { method: "POST", headers: { "content-type": "application/json", "x-nakama-exchange-key": keyA }, body: JSON.stringify({ game_id: "a", nakama_user_id: "victim" }) });
      assert.equal(denied.status, 401);
      assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/v1/web/session`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/v1/web/login?email=player%40example.test`)).status, 200);
      assert.ok(linkUrl);
      const consume = new URL(linkUrl);
      const completed = await fetch(`${baseUrl}${consume.pathname}${consume.search}`, { redirect: "manual" });
      assert.equal(completed.status, 200);
      assert.ok(completed.headers.get("set-cookie"));
    } finally { await server.close(); }
  });
});
