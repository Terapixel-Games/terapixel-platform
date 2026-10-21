# NOT READY: local-work handoff and archival evidence

Forgejo is the canonical source of truth. These GitHub backups preserve work prepared before that correction; they are not approved Forgejo changes or deployment sources. Do not merge this archival branch or apply all patch exports together. Compare and port selected changes against canonical Forgejo history first.

No main branch, existing remote branch, credential, IAM setting or runtime was changed by this backup operation. No deployment workflow is dispatched. Website/loading backup belongs to the separate website task; it is not included here. The original local worktrees and patch files remain intact.

## New source backup refs

| Repository | Backup branch | Exact commit |
| --- | --- | --- |
| terapixel-platform | [backup/wip/2026-10-21-wallet-atomicity-original](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/wip/2026-10-21-wallet-atomicity-original) | `77bb6ac7e7ee6758e553e5eded8bde9e6708ba51` |
| terapixel-platform | [backup/wip/2026-10-21-file-serialization-original](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/wip/2026-10-21-file-serialization-original) | `501eaa379e8139079aef2efa1e7043c762080c88` |
| terapixel-platform | [backup/not-ready/2026-10-21-billing-lifecycle](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/not-ready/2026-10-21-billing-lifecycle) | `6c086b965a45e4489aed8f4f00fefe628da1d5d0` |
| terapixel-platform | [backup/wip/2026-10-21-postgres-consumption-original](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/wip/2026-10-21-postgres-consumption-original) | `84ebd2ba081082ab15d530889c966c00750ca552` |
| terapixel-platform | [backup/not-ready/2026-10-21-original-saves-with-billing](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/not-ready/2026-10-21-original-saves-with-billing) | `728cc043f5fa7bc75f133ac581558da8bfdaac8c` |
| terapixel-platform | [backup/not-ready/2026-10-21-integrated-with-billing](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/not-ready/2026-10-21-integrated-with-billing) | `90feb4de1ac52070b2caac601e5baf9ab83abb8d` |
| terapixel-platform | [backup/not-ready/2026-10-21-postgres-validation-with-billing](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/not-ready/2026-10-21-postgres-validation-with-billing) | `f7ba29e815c3ad98f29a37a97fc365217f8232d6` |
| terapixel-platform | [backup/not-ready/2026-10-21-paused-session-game-binding](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/not-ready/2026-10-21-paused-session-game-binding) | `bdab2f78af3c0a28dbe66a7cae3fb63b406f57af` |
| terapixel-platform | [backup/wip/2026-10-21-nakama-scaffold](https://github.com/Terapixel-Games/terapixel-platform/tree/backup/wip/2026-10-21-nakama-scaffold) | `c42eee71eeb159a945e1f81dc620fc7acd744c4e` |
| LumaRush | [backup/wip/2026-10-21-identity-rollout-wiring](https://github.com/Terapixel-Games/LumaRush/tree/backup/wip/2026-10-21-identity-rollout-wiring) | `3ab2993a8b1ea9bff2887b31334d26a7ea7608f3` |
| ArcadeCore | [backup/wip/2026-10-21-identity-template](https://github.com/Terapixel-Games/ArcadeCore/tree/backup/wip/2026-10-21-identity-template) | `29d0f7df3c036a0ead6de327a8c9dc5bb4102138` |

## Readiness and dependencies

- Billing lifecycle is incomplete: provider webhook processing remains fail-closed pending proper integration. It is not production payment readiness.
- Original saves, integrated review and PostgreSQL-validation historical branches include the billing lifecycle stack. They are all NOT-READY backups; use the separately reviewed data-safety PR10/main history for the isolated data-safety change.
- Session game binding is paused and conflicts with the intended platform-wide player-token policy. Preserve it for review only; do not roll it out.
- LumaRush caller fixes are already on review branch `fix/nakama-exchange-caller-local` at `bca6930c5fec5f3edb901ea6d1bfeb49a185de4c`. Its additional wiring backup does not authorize provisioning backend credentials or deploying callers.
- ArcadeCore identity-template and platform Nakama-scaffold work are separate companion changes, pending canonical-source reconciliation.

## Already published platform history

- PR7 gateway review branch: `80063e2668149bd9db3bfb3be939cd3733bd00e0`.
- PR8 harness review branch: `3713b682477a1afec1eba324033faff05c2bebdb`; main squash `9a30ee51eb2a811d10974322ac73846e7482c5d1`.
- PR9 gateway-only workflow branch: `4ae56f12689e4b49762e11d52a8c4d0c8bed3fab`; main squash `174e68e264dc14fe2ab4451f7163d07dd606d176`.
- PR10 focused data-safety branch: `2217a0d4c5ee31f79df86b74bfcf96bbd78a2d48`; main squash `9d4b720765843243efac2badd6f55dacea063d64`.
- PR11 targeted staging workflow branch: `a10be148b58e563a72cf979381809fd242f70473`; GitHub main squash `3b8144fe2161886e8145d75bcb4eb547d17f3981`.

## Runtime caution at source-of-truth correction

The prior approved rollout had completed before the stop arrived. Staging identity revision `00019-zkv`, saves `00013-lct` and IAP `00013-2cj` were each Ready at 100% traffic. Saves/IAP were switched to PostgreSQL with existing DB secret references; their destinations were verified as the staging Cloud SQL socket/database. Existing memory test state was explicitly disposable. No production deployment occurred. No rollback was attempted after the source correction.

The stopped workflow is https://github.com/Terapixel-Games/terapixel-platform/actions/runs/39626734749. Its only job finished completed/cancelled, with deployment steps successful and no active steps; the enclosing run still showed stale in_progress metadata during read-only follow-through. Do not restart it based on this archival note.

## Patch exports and recovered source

Patch exports preserve intermediate snapshots, not a unified patch series. Billing and paused binding exports are NOT READY. Recovered-image JavaScript is archived source evidence only, outside runtime directories. No image layers, binary builds, environment payloads, secret values, test reports or caches are included.

| File | SHA-256 |
| --- | --- |
| `patches/arcadecore-identity-template.patch` | `b48b110cc5fcebc3af073d051f94e55b900269881a98fbe87a805d1ff1663d45` |
| `patches/lumarush-identity-caller.patch` | `d4b899d7a28101aecc23b62517e10ec750581b1029d2102a5ecdfcfbc5a5d3f4` |
| `patches/lumarush-identity-rollout-wiring.patch` | `a9da714748f5337964e1ab65f9e417adb5a7553c732b9e3e30ca76aeda10a68c` |
| `patches/nakama-exchange-auth.patch` | `6ed4041446c864beeb7256ea4cdc2f9b62150eefd46e65f882d6495ec0cf1284` |
| `patches/terapixel-billing-lifecycle.patch` | `0094c07d4f9fbe3647d1136818b64e68c5b03bd1fd93cb41c68158ed46f40897` |
| `patches/terapixel-data-harness-followups.patch` | `8c824c661a00ce8a73468eeb88a7009f113d63e2e308bebc4d57c53a8f4a1a1f` |
| `patches/terapixel-data-safety-validated.patch` | `fea57830569cb37772e2532806fa6bdb18b64d4aa51495097e29704ff22a2b56` |
| `patches/terapixel-file-serialization.patch` | `445b4cee9218df2888b6c38a8346a49be3dae53cfe3ceec0aa3eb41f85083d10` |
| `patches/terapixel-nakama-scaffold.patch` | `82d0aab4aaa6c6625c2ddcd249b3130b7ef3fea9252a5fa6920c7e223897b05f` |
| `patches/terapixel-platform-integrated.patch` | `e456b4de03d7877b4ecfdcef39665700bb0204f773a3dc8bb6f2c4b9d30713f8` |
| `patches/terapixel-postgres-consumption.patch` | `a6b7f6efe69929742c53f2a3d21b158c67cb484dc1efcabc0b70ae8a6ae0a63a` |
| `patches/terapixel-revision-safe-saves.patch` | `9050ca3fca2608475500ac36537960b7348acdc9f9c61e3d337e83fec9a489d3` |
| `patches/terapixel-session-game-binding.patch` | `e9db51ed1b8b3d04e3138ef571e33dfbcbc9ecbc44e2eabcce7cc1f0301185b9` |
| `patches/terapixel-staging-gateway-replacement.patch` | `aa8262ec2e6ff5a805c0fd184782f0d97132f5e2883f6337ff32f81e32e1a988` |
| `patches/terapixel-wallet-atomicity.patch` | `0f0d5ae229fc4948aa6261a8101b917886044b3024fc93ddeae9b8c816383ba9` |
| `recovered-source/edgeguard-source-inspection/httpServer.js` | `ab9ab3483b2add4a492fea8dd42157913b3feaa0ac01df893cb1ea7b10a6718c` |
| `recovered-source/edgeguard-source-inspection/identityGatewayService.js` | `a657a5cfc3ae4ab285c58ad16cb0870005f0a0299abea4e30d4fb49ab2f2ffeb` |
| `recovered-source/edgeguard-source-inspection/identityStore.js` | `c24ea45e59a5c727124b2ae4f6eb738683c99ecef8db90bb0678f9d10b789db7` |
| `recovered-source/edgeguard-source-inspection/magicLinkEmailSender.js` | `f5b76e3d3839b5f04ab0c07a92ab0ec560ed43bb2c5621e9c2f588a4e9d32a9a` |
| `recovered-source/edgeguard-source-inspection/main.js` | `f41e60d800a20545e7140b9ef14d7bf1e22921675ac1ee6e6aa4ef4b7805b7f2` |
| `recovered-source/edgeguard-source-inspection/platformConfigStore.js` | `8a1ea2d8c4b4f369d801e3af9d367a2fff123e1cf54e338e4b17f50d7216e4b2` |
| `recovered-source/data-staging-image-source/iap-service/catalog.js` | `0af5c52f234be87530cb3bb628f3280fdd6424eaf4a84726d848d0dac5fb8593` |
| `recovered-source/data-staging-image-source/iap-service/httpServer.js` | `db9e06bb91a411dd5bcd23ad286713b0261de5bad7420d295b05251972f2d00d` |
| `recovered-source/data-staging-image-source/iap-service/iapService.js` | `a288a96f85e9526f82755850f099bc9a53e5e017544c410ca0203c41ea105121` |
| `recovered-source/data-staging-image-source/iap-service/main.js` | `79f1084acb1d7eb516700fdab281f5923cf93ed64cfe3b4ed27d54a265de46dd` |
| `recovered-source/data-staging-image-source/iap-service/providers/appleProvider.js` | `ddd85285c31f09b75bff6f9bf51eebd5a6879b326adf21628541d7ac2085c5fc` |
| `recovered-source/data-staging-image-source/iap-service/providers/googleProvider.js` | `7faf6161782024c7a3b517905491c96e4d2736954a9cef6adb0ab9c788ae7c03` |
| `recovered-source/data-staging-image-source/iap-service/providers/paypalProvider.js` | `b10981f105e766bd730dbcb567900b868c44c935b5cd9b972b618329c6da49bb` |
| `recovered-source/data-staging-image-source/iap-service/providers/providerRegistry.js` | `081ddc68f9fd412d21823933b4285b0ad0978ccb9859d43373bdf73d08932d2a` |
| `recovered-source/data-staging-image-source/iap-service/runtimeConfigProvider.js` | `f938d6ca401df83ce223a7a9db6f1e398aa64f02e9a28ed2d28455b4d0b5afbd` |
| `recovered-source/data-staging-image-source/iap-service/store/iapStore.js` | `f728d16f4459ac1bdb11fdacec1a5d755e88f67ef70748c7c1befb9f6244da7b` |
| `recovered-source/data-staging-image-source/iap-service/store/postgresIapStore.js` | `3872b80770d2a7e94a49d10307aea303d8c0989d8c702051e36e196e639f6c91` |
| `recovered-source/data-staging-image-source/save-service/httpServer.js` | `bcc553ba3ab313a85091615fcbd2593e5aade9bd93701efb7561e29b30297695` |
| `recovered-source/data-staging-image-source/save-service/main.js` | `235494332aef5389c4939dcd9f0a99444989f85c1dbbcea4cba1859e0984558d` |
| `recovered-source/data-staging-image-source/save-service/postgresSaveStore.js` | `dfeeaed52cf7f85285390b6440aabadc170475c615b2689daef57a985492cfd3` |
| `recovered-source/data-staging-image-source/save-service/saveEnvelope.js` | `617adbcef69ad160e7f312fe4f0e21f2a256926cec728de4f39e7403b4254196` |
| `recovered-source/data-staging-image-source/save-service/saveService.js` | `c9b130f4699d189a99683936748633cdcc993a750ca86263f5c14336043d100c` |
| `recovered-source/data-staging-image-source/save-service/saveStore.js` | `b8b6d242939fb02cab50bbe9a9731b90d80d1358cd9199b4c32f763352ef7d21` |
