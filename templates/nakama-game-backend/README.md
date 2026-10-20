# nakama-game-backend template

Scaffold for per-game Nakama backend repositories.

Includes:
- `Dockerfile`
- `render.yaml`
- `nakama/modules/index.js`

## Auth Pattern
- Client authenticates with Nakama custom auth (guest/email/provider).
- Nakama module calls `terapixel-platform` `POST /v1/auth/nakama`.
- Module returns platform `session_token` + `global_player_id` to client as RPC payload.

## Identity exchange compatibility and rollout

Prefer the canonical `Terapixel-Games/ArcadeCore` backend template for new games.
This compatibility scaffold now registers Nakama's `(ctx, logger, nk, payload)`
RPC callback directly and requires authenticated `ctx.userId`. Client-selected
user IDs/game IDs/keys are ignored. `GAME_ID`, `PLATFORM_IDENTITY_URL` and dedicated
`TPX_NAKAMA_EXCHANGE_KEY` are read from server runtime configuration at InitModule.
The key must match the gateway mapping for this game/environment and contain at
least 32 URL-safe characters. No key is provided. Never reuse an admin/API key.
Only the identity exchange gets `x-nakama-exchange-key`; failure logs omit response
bodies. Missing configuration fails before HTTP.

An operator must inject the approved key into Nakama `runtime.env`; merely adding
it to the container environment does not configure the JavaScript runtime. This
minimal Docker/Render scaffold does not supply that wiring and is not deployment
ready by itself. No credentials, hosting settings or live bindings are created.
Coordinate gateway PR7 and all backend callers from reviewed main revisions,
then staging, then production. Do not grant a credential to any remaining caller
that forwards payload-selected identities. The canonical rollout inventory is in
ArcadeCore `docs/IDENTITY_EXCHANGE_ROLLOUT.md`.
