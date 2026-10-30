# Site operations — SSR only

The old public static app is retired. Maintenance remains live until the separately authorized
SSR cutover (TOUR-67). Do not restore the retired app, DB, writers or credentials.

## Build and local verification

`DEPLOY_ENV=staging SOURCE_COMMIT=<40-hex> pnpm build:production` packages only settings/legal
and builds `.next/standalone`. `COMMERCE_PUBLIC_API_URL` is runtime-only; no build fetches Commerce.
Use the root `Dockerfile` for the CI image. Port is 3000. The image needs anonymous Commerce URL
and qualified media delivery settings, with no DB, Admin, GitHub, Refref or S3 writer credentials.

`PORT=4010 pnpm exec tsx scripts/projection-fixture.ts` supplies disposable test data only.
`SMOKE_BASE_URL=http://127.0.0.1:3000 FIXTURE_URL=http://127.0.0.1:4010 EXPECT_COMMIT=<40-hex>
pnpm exec tsx scripts/ssr-smoke.ts` verifies identity, runtime updates, outage and retired admin.

## Code release and rollback

Dispatch `site-ssr-release.yml` on main using the setup/preflight documented in
`docs/plans/2026-10-29-tour-60-ssr-source-ready.md` (historical coexistence/static restore sections
are superseded by the 2026-10-30 cleanup receipt). Keep Git auto-deploy disabled. The workflow
builds in CI, proves the candidate, then deploys one digest under its concurrency group.
Both build identity and host digest must match. A rollback dispatch supplies an earlier **SSR**
digest and its commit. No content publication/rebuild job or nightly schedule exists.

## Remaining operations

Source removal does not revoke provider credentials. TOUR-66 tracks Sveltia-exclusive PAT/S3
revocation and remaining provider cleanup; do not touch shared banking, backup/media keys,
Refref production, Flexperiment or shared GitHub/Coolify sources. New host changes require the
specific owner authorization and VPS-15 custody evidence. Sales remain CLOSED.
