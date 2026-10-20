import { it } from "node:test";
import assert from "node:assert/strict";
import { createIdentityGatewayService, createIdentityGatewayHttpServer } from "../services/identity-gateway/index.js";

it("public magic-link consumption preserves success HTML/cookie and rejects concurrent reuse", async () => {
  const secret = "test-public-magic-link-session-secret";
  const service = createIdentityGatewayService({ sessionSecret: secret });
  const { token } = await service.identityStore.createMagicLinkToken("player@example.test", "profile", { gameId: "game" });
  const server = createIdentityGatewayHttpServer({ service, sessionSecret: secret, webSessionCookieSecure: false });
  const { baseUrl } = await server.listen();
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => fetch(`${baseUrl}/v1/account/magic-link/consume?ml_token=${encodeURIComponent(token)}`)));
    assert.equal(responses.filter((response) => response.status === 200).length, 1);
    assert.equal(responses.filter((response) => response.status === 400).length, 11);
    const success = responses.find((response) => response.status === 200);
    assert.match(await success.text(), /Account Linked/i);
    assert.match(success.headers.get("set-cookie"), /tpx_session=/);
    assert.equal((await fetch(`${baseUrl}/v1/account/magic-link/consume?ml_token=${encodeURIComponent(token)}`)).status, 400);
  } finally { await server.close(); }
});
