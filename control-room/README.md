# mikluha-control-room

The static Control Room of the isolated Admin API (ADR v2.3 §7, Linear ART-363). A Next.js
`output: "export"` app served by its own Nginx; the only dynamic thing it does is call `/api/` on
its own origin, and that Nginx proxies exactly `/api/` to the Admin API container
(`commerce/src/admin/api.ts`, see `commerce/README.md`, "Admin API"). It is not part of the public
site, and the public site and `book.*` never route to it.

Flexperiment's Control Room was the UX/API reference; none of its runtime or SQLite is imported.

## What is here

| route | |
|---|---|
| `/login/` | login, password and TOTP code at every login |
| `/enroll/` | first enrolment or re-enrolment after an operator reset: QR code (drawn in the browser from the otpauth URI), then the first code. No recovery codes, no web disable |
| `/` | the session (refresh, logout, other sessions), tours and departures (read), the audit (OWNER). Editors are ART-365 on the same API |

The bundle holds no credential: no database URL, no TOTP key, no GitHub PAT, no S3 key, no
`NEXT_PUBLIC_*` value. It never reads the session cookie (HttpOnly) and stores nothing in browser
storage. `pnpm run build` ends with `scripts/check-bundle.mjs out`, which fails on anything that
looks like a credential or a server-side configuration name.

## Runtime

`nginx.conf.template`: CSP `default-src 'self'` with `connect-src 'self'`, `frame-ancestors 'none'`,
`no-store` HTML, no access log, `/api/` limited to 320 KiB bodies, and `/api/auth/` capped for all
clients together (2 requests/s, burst 20) in front of the Admin API's own throttle. The Admin API address comes from
`ADMIN_API_UPSTREAM` (default `mikluha-admin-api:3000`) and is resolved through Docker's DNS every
10 s, so an Admin API redeploy needs no Nginx reload and Nginx starts while the API is down.
`X-Forwarded-For` from Traefik (one client address) is passed through unchanged for the login
throttle; `Host` is passed so the API can refuse any host but the admin origin.

`/identity.json` reports the source commit the image was built from (release read-back, ADR v2.3 §8).

## Commands

```bash
pnpm install --ignore-workspace     # its own package, not part of the site's workspace
pnpm dev                            # needs an Admin API behind the same origin for /api/
pnpm run typecheck
pnpm test                           # the bundle checker's own test
pnpm run build                      # static export to out/, then the no-secret check
docker build --build-arg SOURCE_COMMIT=$(git rev-parse HEAD) control-room
```

## Deployment (not done here)

Two Coolify applications, by image digest (ADR v2.3 §8): this image on the admin domain, and the
commerce image with `node dist/bin/admin-api.js` as the Admin API, on a private network shared only
with this Nginx and the database, with no public domain of its own. The Admin API's environment and
`admin_runtime`/`admin_operator_login` credentials are new custody items for
`adman-vps-infrastructure` before that deployment.
