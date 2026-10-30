# TOUR-60 / TOUR-66 — SSR-only source and legacy retirement

2026-10-30. Implements the accepted clean-slate source scope. `CUSTODY_IMPACT: NO`:
source and local disposable tests only; no host, provider credential, live DB or domain change.
Plane owns task status and acceptance; this document records the architecture and source receipt.

## Decision

Use one request-rendered storefront and one root Dockerfile. Retaining a selectable exporter
would leave the retired publisher usable; adding a second public app would keep two release
paths. The existing digest-based SSR workflow already supplies the candidate and read-back
mechanism, so it remains the single manual code release. It does not trigger on push.

Catalog pages read the anonymous Commerce public projection once per request via React cache,
with fetch `no-store`, no forwarded cookies or bearer credentials. No baked catalog fallback.
A failed read/normalization/launch admission renders server HTML with the outage message,
retry/legal/contact links, no dates/prices/booking links and noindex. The fallback is HTTP 200
(App Router page response); sitemap failures remain errors. Raw HTTP smoke verifies the outage
text on home, tour and report pages without hydration, plus recovery on the next request.

Settings/legal remain code-owned read-only release inputs pending TOUR-59. `prepare:site`
packages only these into `.site-build/content.json`; it never reads tours/departures. Existing
build launch/refund gates and runtime catalog launch gates remain. This change does not assert
that every TOUR-59/67 content/publication gate or native payment endpoint is implemented.

## Retired source/release resources

| Removed from target | Post-state |
| --- | --- |
| `public/admin`, Sveltia package/schema adapter/patch/vendor/config-validator | Public paths 404; no admin files in site image |
| `publish.yml` including dispatch and schedules | No static publisher or scheduled rebuild workflow |
| static root Nginx image/config, `output: export`, `SITE_RENDERING`, static params and `validate:out` | Root Dockerfile builds standalone SSR; no alternate storefront mode |
| `sync:content` and catalog YAML production inputs | Settings/legal packaging only; catalog fixtures under `test-fixtures/catalog`, absent from runtime images |
| `commerce/src/{checkout,refref,arrival,web}.ts` | Removed from compiled source; test-only historical harness under `commerce/test/retired` |
| Refref env/client wiring, initiation pool and reconciliation worker | Entrypoint starts without Refref key; performs no Refref/arrival calls across restart even with old pending test orders |
| old booking/order/return/arrival/document routes | Every method returns 410 without cookies, redirects, token reflection or checkout; database unavailability can instead fail schema admission with 503 |
| YAML catalog loading in Commerce runtime | Only settings/legal release is read from code; public catalog is PostgreSQL projection |

Historical test implementations preserve prior financial/legal/consent/stop-sales evidence.
They are neither compiled nor copied into Commerce runtime, and production source cannot import
them. Shared snapshot hashes, native purchase/order persistence, immutable migrations and Admin
contracts stay intact. `pnpm build` clears Commerce dist first so stale checkout output cannot survive.
CI checks the built images for retired modules/assets and fixture directories.

## Validation receipt

- Site lint, TypeScript, 119 tests pass. Staging standalone image builds without a Commerce address.
- Commerce typecheck/build and both Docker images pass.
- Candidate smoke on one site image: direct → CDN → direct, immutable identity, no-store/no-cookie,
  next-request catalog title/price update (including kopecks), server HTML outage/recovery,
  legal availability during outage, and retired admin URLs.
- Runtime image inspection: no public admin, test fixtures/harness or compiled Refref transport;
  packaged site catalog arrays are empty.
- Legacy route test covers GET/POST/PUT/DELETE and rejects token reflection/cookies/redirects.
- Business sabotage: 28/28 mutations killed and restored; historical test proof only.
- Full Commerce tests use a disposable local PostgreSQL 16; dump/restore uses matching version 16
  clients from that test container. Hosted CI is tracked on the PR, separately from local evidence.

## Operational boundary

No deployment or live infrastructure operation occurred. The retired host resource receipt is
owned by private infrastructure PR #19 and Plane TOUR-66; it is not re-certified here. Sveltia
provider PAT/S3 revocation and pending provider cleanup remain unproven by this source change.
Do not restore the retired static application/DB or treat the executed one-time deletion GO as
standing authorization. Shared Refref/Flexperiment/banking/control-plane resources are untouched.

TOUR-60 operation acceptance remains TOUR-67: actual new SSR/Commerce release, digest A/B/rollback,
identity/host read-backs, real public projection and owner-authorized domain cutover. Rollback
means an earlier SSR digest, never the retired static site. New DB automatic encrypted/off-host
backup plus isolated restore precedes real Admin/content/legal data. Sales remain CLOSED.
