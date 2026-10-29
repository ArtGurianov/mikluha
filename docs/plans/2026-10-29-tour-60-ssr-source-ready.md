# TOUR-60 (ART-360) · SSR source: build, release by digest, identity, rollback

- **Stage claimed by this change:** `SSR_SOURCE_READY` (roadmap v2, 2026-10-29) — for review.
  **Not** `SSR_OPERATION_ACCEPTED`: no application was created, nothing was deployed, no domain
  points at an SSR container. TOUR-60 stays open until the owner-authorized cutover, read-back and
  restore of TOUR-67 (ART-368). This is not a launch GO and opens no sale.
- **Canon:** ADR v2.3 §2, §8, §9 items 8–9; the §1 digest PoC (GO, 2026-10-18, `poc/coolify-digest/`).
- `CUSTODY_IMPACT: NO` — source only. Creating the Coolify application, its env and its tokens
  later is `YES` (VPS-15).

## Coexistence until the hard cut

The static export stays the production release: `Dockerfile`, `nginx.conf`, `publish.yml` and
`build:production` are unchanged in behaviour. `SITE_RENDERING` selects the build
(`next.config.ts`, inlined, so an image always runs the mode it was built in):

| | static export (today) | SSR (this change) |
|---|---|---|
| Build | `pnpm run build:production` → `out/` | `pnpm run build:ssr` → `.next/standalone` |
| Image | `Dockerfile` (Nginx) | `Dockerfile.ssr` (`node server.js`, port 3000, user `node`) |
| Tours, departures, reports, reviews, organizers | `content/` YAML at build | Commerce `GET /public/v1/catalog`, every request |
| Site settings, legal pages | `content/` at build | `content/` at build — code, like Commerce's legal release (TOUR-59 owns their move) |
| Media URLs | as stored | per request, `MEDIA_DELIVERY` switch (TOUR-56) |

Removing the static path (Sveltia, YAML writers, `publish.yml`, `validate:out`) is TOUR-66
(ART-367), after the cutover.

## Receipt — what was built and how it was checked

| Item | Where | Evidence in this change |
|---|---|---|
| **Source: projection API** | `commerce/src/public-api.ts`, wired in `src/bin/serve.ts` | `commerce/test/public-api.test.ts`: published data only, a saved draft never shows, unlisting hides, `no-store`, no cookie, GET only |
| **Source: SSR data layer** | `lib/cms/content.ts`, `lib/cms/projection.ts`, `normalizeCatalog` | `lib/cms/projection.test.ts`: projection → the DTOs the pages render; projection columns win over editor documents; a document missing a required field fails naming it; unknown schema refused |
| **No build reads production data** | `loadContent()` waits for the request (`connection()`); dynamic routes export no `generateStaticParams` under SSR | `next build` route table: every page `ƒ (Dynamic)`; a build has no Commerce address at all |
| **No-store, no cookies, no credentials** | Next dynamic rendering; `next.config.ts` headers; the image has no DB/Admin env | `scripts/ssr-smoke.ts` (CI job `site-ssr`, release `candidate` job) |
| **Commerce outage → error, not stale prices** | one read per request, no fallback; the root layout and legal pages never read Commerce (`loadSiteContent`); catalog pages fail into `app/error.tsx` (`retry()`) | smoke: catalog pages 500 with no `₽`, tour or booking link; `/oferta/` stays 200; 200 again when Commerce is back. Headless Chrome with JS: message, legal link and «Обновить» visible, no price. Without JS the visitor sees Next's empty error document — no stale data, but no message either (accepted) |
| **Launch gate** | `validate:content --baked` in `build:ssr` (site settings, legal, `launchReady`); `lib/launch-gate.ts` per request once launch-ready (demo items, incomplete contract, no price/capacity for OPEN), shared with the static validator | a `DEPLOY_ENV=production` SSR build with `launchReady=false` fails; `lib/launch-gate.test.ts` |
| **Prices** | `formatRub` shows kopecks when Commerce has them | smoke: 3 450 050 kopecks render as «34 500,50 ₽» |
| **Render on request** | no ISR, no cache | smoke: a projection change shows on the next request |
| **Build** | `Dockerfile.ssr`, built by CI only | CI `site-ssr` builds it for the PR head |
| **Identity** | `/identity` → build-baked `/release.json` (`sourceCommit`), never a runtime env (Coolify sets `SOURCE_COMMIT=HEAD`) | smoke checks it equals the built commit; release `candidate` reads the baked file out of the pulled image |
| **Release by digest** | `.github/workflows/site-ssr-release.yml` | manual dispatch on `main`; build → candidate (pulled `image@digest`, baked commit, smoke) → environment `site-ssr`: target guard (name `mikluha-site-ssr`, `dockerimage`, port 3000) → PATCH `sha256-<hex>` → stored-value read-back → deploy → terminal state (tolerates the early 404) → `/identity` read-back → **host read-back** (below). One concurrency group: PATCH, deploy and both read-backs of two releases never interleave |
| **Second read-back** | `scripts/verify-running-digest.sh` on the VPS, run by the release job over a restricted forced-command key | the container's `.Config.Image` must be exactly `image@digest` and its RepoDigests must contain it; a mismatch fails the release. Without the key the release ends `NOT_ATTESTED` (failed): a successful run means both read-backs passed |
| **Rollback** | the same workflow with `digest` + `commit` of an earlier release; nothing is built | the run summary records the tag running before each release |
| **Media switch** | `lib/cms/media-delivery.ts` | CI runs the same image `direct → cdn → direct`; `/identity` unchanged |

Local verification of this change (2026-10-29): `build:production` (static) passes
`validate:out`; `build:ssr` and `docker build -f Dockerfile.ssr` succeed; the container passes
the smoke against `scripts/projection-fixture.ts`, including the outage and media switch runs.

## Owner setup for the first non-production release (CUSTODY_IMPACT: YES then)

1. Coolify: a **Docker Image** application named exactly `mikluha-site-ssr`, image
   `ghcr.io/artgurianov/mikluha-site-ssr`, Ports Exposes `3000`, a non-production domain,
   Git auto-deploy off, CPU/RAM limits, on the Docker network where Commerce answers.
2. Its runtime env: `COMMERCE_PUBLIC_API_URL=http://<commerce container>:3000` and, optionally,
   the `MEDIA_*` switch. No database, Admin, Refref or e-mail credential.
3. GitHub environment `site-ssr` limited to `main`: secrets `COOLIFY_BASE_URL`,
   `COOLIFY_SITE_SSR_WRITE_TOKEN`, `COOLIFY_SITE_SSR_DEPLOY_TOKEN`, `SITE_SSR_ATTEST_SSH_KEY`,
   `SITE_SSR_ATTEST_KNOWN_HOSTS`; var `SITE_SSR_ATTEST_HOST`; and vars `SITE_SSR_APP_UUID`,
   `SITE_SSR_IDENTITY_URL`, `SITE_SSR_DEPLOY_ENV` (`staging` until the cut), `SITE_SSR_SITE_URL`.
4. On the VPS: install `scripts/verify-running-digest.sh` as `/usr/local/sbin/verify-running-digest`
   (root-owned, read-only) and add the attestation public key as
   `restrict,command="/usr/local/sbin/verify-running-digest" ssh-ed25519 …` for a user that may
   only run `docker inspect`/`docker ps`. It can run that check and nothing else. Owner decision,
   recorded in VPS-15; until then every release ends `NOT_ATTESTED` and can be attested by hand.
5. After the first build, make the GHCR package public or give Coolify a pull credential.
6. Commerce must run a build that serves `/public/v1/catalog` (this change).

## Left for SSR_OPERATION_ACCEPTED (TOUR-67)

- Integration with TOUR-81 (PR #50): both change `commerce/src/bin/serve.ts`. The merged file keeps
  the `/public/v1/catalog` route **and** #50's removal of the vNext/Arrivals wiring (inert
  `/arrive`, legacy read-back, no vNext call), then CI runs again on the new exact HEAD.

- A real release, a second release, and a rollback to the first, each with both read-backs.
- The site against real Commerce data published through Control Room, not the fixture.
- Commerce's `LiveSiteReleaseAdmission` reads `https://mikluha-maklai.ru/release.json`; at the cut
  the SSR image serves the same descriptor from the same commit as Commerce.
- The production domain switch from the static container to `mikluha-site-ssr`, and the restore
  path back to the static container while it still exists.
