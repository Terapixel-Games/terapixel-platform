import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createIdentityGatewayHttpServer,
  createIdentityGatewayService
} from "../services/identity-gateway/index.js";
import { createSessionToken } from "../packages/shared-utils/index.js";
import {
  createSignedJwt,
  createStaticKeyStore,
  generateRsaKeyPair
} from "../tools/test-helpers/jwtTestUtils.js";

describe("identity-gateway http", () => {
  const { privateKey, publicKey } = generateRsaKeyPair();
  const keyStore = createStaticKeyStore(publicKey, "cg-kid-1");
  const sessionSecret = "identity-session-secret-12345";
  let lastMagicLink = "";
  const service = createIdentityGatewayService({
    nakamaExchangeKeysJson: JSON.stringify({ lumarush: "test-lumarush-backend-key-32-bytes-long" }),
    sessionSecret,
    sessionIssuer: "terapixel.identity",
    sessionAudience: "terapixel.game",
    magicLinkBaseUrl: "https://identity.terapixel.games/v1/account/magic-link/consume",
    magicLinkEmailSender: {
      sendMagicLink: async ({ linkUrl }) => {
        lastMagicLink = String(linkUrl || "");
        return { accepted: true };
      }
    }
  });
  const httpServer = createIdentityGatewayHttpServer({
    service,
    allowedOrigins: "*",
    internalServiceKey: "internal-key-abc",
    sessionSecret,
    sessionIssuer: "terapixel.identity",
    sessionAudience: "terapixel.game",
    sessionTtlSeconds: 600,
    webSessionCookieSecure: false,
    webReturnOrigins: ["http://app.test"],
    authConfig: {
      keyStore,
      expectedIssuer: "https://auth.crazygames.com",
      expectedAudience: "lumarush",
      clockSkewSeconds: 5
    }
  });

  let baseUrl = "";
  before(async () => {
    const listenInfo = await httpServer.listen(0, "127.0.0.1");
    baseUrl = listenInfo.baseUrl;
  });

  after(async () => {
    await httpServer.close();
  });

  it("serves health", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
  });

  it("authenticates crazygames token", async () => {
    const now = 1_800_000_000;
    const token = createSignedJwt(
      {
        userId: "cg_user_9",
        username: "Nova",
        iss: "https://auth.crazygames.com",
        aud: "lumarush",
        exp: now + 300
      },
      { privateKey, kid: "cg-kid-1" }
    );
    const response = await fetch(`${baseUrl}/v1/auth/crazygames`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        token,
        nowSeconds: now
      })
    });
    assert.equal(response.status, 200);
  });

  it("authenticates nakama user", async () => {
    const response = await fetch(`${baseUrl}/v1/auth/nakama`, {
      method: "POST",
      headers: {
        "x-nakama-exchange-key": "test-lumarush-backend-key-32-bytes-long",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        game_id: "lumarush",
        nakama_user_id: "nk-http-77"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.nakama_user_id, "nk-http-77");
  });

  it("issues and redeems merge code", async () => {
    const primaryToken = createSessionToken(
      { sub: "player_primary", nakama_user_id: "primary_nk" },
      sessionSecret,
      {
        issuer: "terapixel.identity",
        audience: "terapixel.game",
        ttlSeconds: 600,
        nowSeconds: 1_800_000_000
      }
    );
    const createResponse = await fetch(`${baseUrl}/v1/account/merge/code`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${primaryToken}`
      }
    });
    assert.equal(createResponse.status, 200);
    const createBody = await createResponse.json();
    assert.ok(createBody.merge_code);

    const secondaryToken = createSessionToken(
      { sub: "player_secondary", nakama_user_id: "secondary_nk" },
      sessionSecret,
      {
        issuer: "terapixel.identity",
        audience: "terapixel.game",
        ttlSeconds: 600,
        nowSeconds: 1_800_000_001
      }
    );
    const redeemResponse = await fetch(`${baseUrl}/v1/account/merge/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secondaryToken}`
      },
      body: JSON.stringify({
        merge_code: createBody.merge_code
      })
    });
    assert.equal(redeemResponse.status, 200);
    const redeemBody = await redeemResponse.json();
    assert.equal(redeemBody.primary_profile_id, "player_primary");
    assert.equal(redeemBody.secondary_profile_id, "player_secondary");
    assert.ok(redeemBody.session_token);
  });

  it("starts and completes magic link flow", async () => {
    const now = 1_800_000_200;
    const session = createSessionToken(
      { sub: "legacy", nakama_user_id: "nk_magic_a" },
      sessionSecret,
      {
        issuer: "terapixel.identity",
        audience: "terapixel.game",
        ttlSeconds: 600,
        nowSeconds: now
      }
    );
    const start = await fetch(`${baseUrl}/v1/account/magic-link/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session}`
      },
      body: JSON.stringify({
        email: "magic@example.com",
        game_id: "lumarush",
        nowSeconds: now
      })
    });
    assert.equal(start.status, 200);
    const startBody = await start.json();
    assert.equal(startBody.accepted, true);

    const tokenRow = await service.identityStore.createMagicLinkToken(
      "magic@example.com",
      "nk_magic_a",
      { nowSeconds: now, ttlSeconds: 900 }
    );
    const complete = await fetch(`${baseUrl}/v1/account/magic-link/complete`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session}`
      },
      body: JSON.stringify({
        ml_token: tokenRow.token,
        nowSeconds: now + 1
      })
    });
    assert.equal(complete.status, 200);
    const completeBody = await complete.json();
    assert.equal(completeBody.status, "upgraded");
  });

  it("consumes magic link via web endpoint", async () => {
    const now = 1_800_000_300;
    const tokenRow = await service.identityStore.createMagicLinkToken(
      "consume@example.com",
      "nk_magic_consume",
      { nowSeconds: now, ttlSeconds: 900 }
    );
    const response = await fetch(
      `${baseUrl}/v1/account/magic-link/consume?ml_token=${encodeURIComponent(tokenRow.token)}`
    );
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Account Linked/i);
  });

  it("supports browser login, session check, and logout", async () => {
    const loginStart = await fetch(
      `${baseUrl}/v1/web/login?email=${encodeURIComponent("web@example.com")}&return_to=${encodeURIComponent("http://app.test/welcome?tpx_auth=1")}`
    );
    assert.equal(loginStart.status, 200);
    assert.match(lastMagicLink, /ml_token=/);

    const sentLink = new URL(lastMagicLink);
    const token = sentLink.searchParams.get("ml_token");
    assert.ok(token);

    const consume = await fetch(
      `${baseUrl}/v1/account/magic-link/consume?ml_token=${encodeURIComponent(token)}&return_to=${encodeURIComponent("http://app.test/welcome?tpx_auth=1")}`,
      { redirect: "manual" }
    );
    assert.equal(consume.status, 302);
    const setCookie = consume.headers.get("set-cookie") || "";
    assert.match(setCookie, /tpx_session=/);
    const location = consume.headers.get("location") || "";
    assert.match(location, /tpx_auth=1/);
    assert.doesNotMatch(location, /terapixel_user_id=/);
    assert.doesNotMatch(location, /terapixel_email=/);

    const cookieHeader = setCookie.split(";")[0];
    const session = await fetch(`${baseUrl}/v1/web/session`, {
      headers: {
        cookie: cookieHeader
      }
    });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.terapixel_email, "web@example.com");

    const logout = await fetch(`${baseUrl}/v1/web/logout`, {
      method: "POST",
      headers: {
        cookie: cookieHeader
      }
    });
    assert.equal(logout.status, 200);
    const clearedCookie = logout.headers.get("set-cookie") || "";
    assert.match(clearedCookie, /Max-Age=0/);

    const sessionAfterLogout = await fetch(`${baseUrl}/v1/web/session`, {
      headers: {
        cookie: clearedCookie.split(";")[0]
      }
    });
    const sessionAfterLogoutBody = await sessionAfterLogout.json();
    assert.equal(sessionAfterLogoutBody.authenticated, false);
  });

  it("persists display name in web session after magic-link consume", async () => {
    const authResponse = await fetch(`${baseUrl}/v1/auth/nakama`, {
      method: "POST",
      headers: {
        "x-nakama-exchange-key": "test-lumarush-backend-key-32-bytes-long",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        game_id: "lumarush",
        nakama_user_id: "nk-http-display-1",
        display_name: "Nova"
      })
    });
    assert.equal(authResponse.status, 200);
    const authBody = await authResponse.json();
    const playerId = String(authBody.player_id || "");
    assert.ok(playerId);

    const tokenRow = await service.identityStore.createMagicLinkToken(
      "display@example.com",
      playerId,
      { nowSeconds: 1_800_000_500, ttlSeconds: 900 }
    );
    const consume = await fetch(
      `${baseUrl}/v1/account/magic-link/consume?ml_token=${encodeURIComponent(tokenRow.token)}`
    );
    assert.equal(consume.status, 200);
    const cookie = (consume.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /tpx_session=/);

    const session = await fetch(`${baseUrl}/v1/web/session`, {
      headers: {
        cookie
      }
    });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.equal(sessionBody.authenticated, true);
    assert.equal(sessionBody.terapixel_display_name, "Nova");
  });

  it("validates username via internal admin endpoint", async () => {
    const response = await fetch(`${baseUrl}/v1/identity/internal/username/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": "internal-key-abc"
      },
      body: JSON.stringify({
        game_id: "lumarush",
        username: "normal_player"
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.allowed, true);
  });
});
