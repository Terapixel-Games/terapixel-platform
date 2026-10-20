import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const source = fs.readFileSync(new URL("../templates/nakama-game-backend/nakama/modules/index.js", import.meta.url), "utf8");
const key = "test-only-scaffold-server-key-at-least-32-bytes";
function scaffold(env = {}) {
  const context = vm.createContext({}); vm.runInContext(source, context);
  let rpc;
  const calls = [], logs = [];
  const logger = { info() {}, error(message) { logs.push(message); } };
  const nk = { httpRequest(url, method, headers, body) { calls.push({ url, headers, body: JSON.parse(body) }); return { code: 200, body: '{"session_token":"test-session"}' }; } };
  context.InitModule({ env: { GAME_ID: "fixture", PLATFORM_IDENTITY_URL: "https://identity.test", TPX_NAKAMA_EXCHANGE_KEY: key, ...env } }, logger, nk, { registerRpc(name, handler) { assert.equal(name, "platform_auth_exchange"); rpc = handler; } });
  return { rpc, nk, logger, calls, logs };
}
it("compatibility scaffold uses the actual Nakama callback and server-owned identity contract", () => {
  const { rpc, nk, logger, calls } = scaffold();
  const response = rpc({ userId: "caller", env: { GAME_ID: "other", TPX_NAKAMA_EXCHANGE_KEY: "attacker" } }, logger, nk, '{"nakama_user_id":"victim","game_id":"other"}');
  assert.equal(JSON.parse(response).session_token, "test-session");
  assert.equal(calls[0].body.nakama_user_id, "caller");
  assert.equal(calls[0].body.game_id, "fixture");
  assert.equal(calls[0].headers["x-nakama-exchange-key"], key);
});
it("compatibility scaffold fails before HTTP for missing authentication/configuration", () => {
  const { rpc, logger, nk, calls } = scaffold();
  for (const ctx of [undefined, {}, { userId: " " }, { userId: 42 }]) assert.throws(() => rpc(ctx, logger, nk, "{}"), /authenticated Nakama/);
  assert.equal(calls.length, 0);
  for (const env of [{ TPX_NAKAMA_EXCHANGE_KEY: "" }, { GAME_ID: "" }, { TPX_NAKAMA_EXCHANGE_KEY: "bad\nkey" }]) {
    const s = scaffold(env);
    assert.throws(() => s.rpc({ userId: "caller" }, s.logger, s.nk, "{}"), /required|configured/);
    assert.equal(s.calls.length, 0);
  }
});
it("compatibility scaffold rejects malformed payloads and never logs response secrets", () => {
  const s = scaffold();
  for (const body of ["{", "null", "[]"]) assert.throws(() => s.rpc({ userId: "caller" }, s.logger, s.nk, body));
  s.nk.httpRequest = () => ({ code: 401, body: "sensitive-response-must-not-be-logged" });
  assert.throws(() => s.rpc({ userId: "caller" }, s.logger, s.nk, "{}"), /exchange failed/);
  assert.equal(s.logs.join("").includes("sensitive-response"), false);
});
