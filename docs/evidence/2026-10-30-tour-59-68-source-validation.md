# TOUR-59/68 source validation — 2026-10-30

Base `68130f02ca214eb3fea7f7893b9b2cc59e10fede`, branch
`codex/tour-59-68-active-legal-privacy`. Local working-tree evidence, not an
installed/exact-final-image or legal-publication receipt.

## Passed

- Site lint, route type generation and TypeScript.
- Full site test suite: 122/122.
- Commerce TypeScript.
- PostgreSQL 16 public API, departure controls and retired checkout tests:
  13 distinct tests (12 original selected tests plus the added identity test).
  The final public API run is 5/5, including exact body/hash and future-version
  isolation after expanding the legal-publication test.
- Staging production-mode build: dynamic legal route, no Commerce read at build.
- Standalone production server, direct media: 34/34 smoke checks. Verified raw
  HTML without browser JS, publication change without rebuilding, matching
  metadata, missing required publication, tampered text/hash refusal, outage
  with no stale legal text, no-store/no-cookie/noindex and recovery. Retired
  `/admin` paths remain 404; code identity is independent of legal identity.
- `git diff --check` and exact candidate document SHA-256 manifest.

## Local environment repairs and limits

Frozen-lockfile dependency installs were required in the main package and
the separate Commerce package; no lockfile/source dependency edit. An ignored
generated Sveltia bundle left from the former checkout polluted lint; preserved
outside the repository in a temporary directory before verification. Other
untracked `temp/` and regional-media PoC files were not included or deleted.

The first direct standalone launch omitted the repository Dockerfile's existing
`NODE_OPTIONS=--no-experimental-require-module` and failed on an untraced SWC
ESM helper. Re-ran the standalone server with that existing runtime option,
copied public/static/build-settings assets as the Dockerfile does, and completed
all 34 smoke checks. No production workaround was invented or deployed.

Preview settings keep launchReady=false; no real production catalogue, domain,
bank/CAPTCHA/EIS or live visitor/Admin/provider qualification is claimed. Sales
and customer ingress remain CLOSED/retired. Baked legal bytes remain historical
inputs, never the public SSR fallback. Future native selling must transactionally
bind accepted terms/consent to the current Commerce authority before activation.

Privacy/cookies candidate: `docs/legal/2026-10-30-ssr-admin/`, exact bytes in
`SHA256SUMS`. Product-lifetime Admin retention is an owner preference, not
approval of those exact public bytes. No effective date, approval or publication
has been fabricated. Operational access/log/erasure/backup qualification remains
separate from this source evidence and must precede the relevant real use.

CUSTODY_IMPACT: NO — source, local disposable PostgreSQL and synthetic SSR only;
no host/env/network/proxy route/credential or deployed persistent state changed.

## Hosted review correction

Initial GitHub run 41058384245 passed verify, site-ssr, commerce-image and
control-room. Commerce ran 417 tests: 416 passed; its old production-startup
expectation still required refund/sales qualification before image identity.
That expectation contradicts the sales-CLOSED read-only SSR/Admin scope: it
would require opening launchReady just to serve the first legal publication.
Updated the subprocess test to prove that unqualified sale content reaches
immutable image admission while the separate bookable/refund refusal tests
remain unchanged. No runtime change in this correction. Hosted rerun follows.
