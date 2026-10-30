# Миклуха

Next.js 16 SSR storefront, Commerce public projection, separate Control Room.

- `pnpm install --frozen-lockfile`
- `pnpm dev` (set `COMMERCE_PUBLIC_API_URL`; the site reads anonymous `/public/v1/catalog` per request)
- `DEPLOY_ENV=staging SOURCE_COMMIT=<40-hex> pnpm build:production`
- `pnpm start`, or build the root `Dockerfile` (standalone Node, port 3000).

Production builds require the existing launch/legal gates. Settings and legal documents in
`content/` remain read-only code-release inputs pending TOUR-59. Catalog YAML is test-only in
`test-fixtures/catalog/`; it cannot supply runtime prices. An unavailable Commerce renders a
server HTML message with no prices or booking links, no-store and noindex; legal pages remain available.

Code release: manual `site-ssr-release.yml` on main, candidate smoke, immutable digest,
preflight attestation, Coolify stored-value and deployment read-back, `/identity` and host
RepoDigests. Rollback uses an earlier SSR digest/commit. No static storefront fallback.

Sveltia `/admin`, static exporter, publication schedule and legacy Refref checkout are retired.
Commerce returns 410 on old booking/order/return/arrival/document URLs, with sales CLOSED.
Historical checkout scenarios remain test-only, outside compiled production source/images.

Operational setup/cutover is TOUR-67/VPS-15. This source does not authorize deployment or sales.
Provider PAT/S3 credential cleanup remains separately recorded in TOUR-66.
See `RUNBOOK.md`, `commerce/README.md`, `control-room/README.md`, and the canonical ADRs.
