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
| **Commerce outage → error, not stale prices** | `app/global-error.tsx`; one read per request, no fallback | smoke: 500 with Next's error document, no `₽`, no tour links; 200 again when Commerce is back |
| **Render on request** | no ISR, no cache | smoke: a projection change shows on the next request |
| **Build** | `Dockerfile.ssr`, built by CI only | CI `site-ssr` builds it for the PR head |
| **Identity** | `/identity` → build-baked `/release.json` (`sourceCommit`), never a runtime env (Coolify sets `SOURCE_COMMIT=HEAD`) | smoke checks it equals the built commit; release `candidate` reads the baked file out of the pulled image |
| **Release by digest** | `.github/workflows/site-ssr-release.yml` | manual dispatch on `main`; build → candidate (pulled `image@digest`, baked commit, smoke) → environment `site-ssr`: target guard (name `mikluha-site-ssr`, `dockerimage`, port 3000) → PATCH `sha256-<hex>` → stored-value read-back → deploy → terminal state (tolerates the early 404) → `/identity` read-back. One concurrency group: PATCH and deploy of two releases never interleave |
| **Second read-back** | `scripts/verify-running-digest.sh` on the VPS | RepoDigests of the running container must contain `image@digest` |
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
   `COOLIFY_SITE_SSR_WRITE_TOKEN`, `COOLIFY_SITE_SSR_DEPLOY_TOKEN`; vars `SITE_SSR_APP_UUID`,
   `SITE_SSR_IDENTITY_URL`, `SITE_SSR_DEPLOY_ENV` (`staging` until the cut), `SITE_SSR_SITE_URL`.
4. After the first build, make the GHCR package public or give Coolify a pull credential.
5. Commerce must run a build that serves `/public/v1/catalog` (this change).

## Left for SSR_OPERATION_ACCEPTED (TOUR-67)

- A real release, a second release, and a rollback to the first, each with both read-backs.
- The site against real Commerce data published through Control Room, not the fixture.
- Commerce's `LiveSiteReleaseAdmission` reads `https://mikluha-maklai.ru/release.json`; at the cut
  the SSR image serves the same descriptor from the same commit as Commerce.
- The production domain switch from the static container to `mikluha-site-ssr`, and the restore
  path back to the static container while it still exists.
