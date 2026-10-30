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
`admin_runtime`/`admin_publish_runtime`/`admin_operator_login` credentials and versioned audit keyring are new custody items for
`adman-vps-infrastructure` before that deployment.

## TOUR-64 Stage A / TOUR-65 editors and controls

The Tours, Departures and Materials tabs edit the existing Admin API documents.
Save changes only the draft. Preview renders text safely; OWNER publication uses
both revision tokens, confirms explicitly and reads the published document/history
back from the API. Unsaved changes warn before leaving the editor. An editor can
prepare drafts; public publication, legal approval and departure controls require
an authenticated live OWNER session.

Common fields use labeled inputs, contract sections support ordered programme/
service lists, and additional content keys remain available in the JSON section.
SEO is `content.seo`; tour heading/shortDescription and organizer phone/bio use the
SSR projection's field names. Invalid JSON blocks saving. Images select only
PUBLISHED assets from TOUR-63's `/api/media`, storing `{image: "media:<uuid>", alt}`;
cover, organizer/review photo and gallery references retain no storage credential.
The upload/rights/process/publish/revoke flow belongs to TOUR-63; if it is not
installed this section reports the unavailable photo library.

The operational panel reads redacted capacity counts and the global stop. It can
adjust capacity/listing, close or resume a departure, pause all in one transaction
and selectively resume a recorded batch. It cannot change the global switch,
cancel an order/departure or perform a financial operation. CLOSED defaults and
ordinary publication never opening sales are enforced server-side.

Legal publication uses `POST /api/content/<id>/publish-legal` with expected draft
and published versions, `effectiveOn` and explicit `approval`. Immutable publication
history stores document and UTF-8 body hashes. The effective public text appears
in the additive `legalPages` field of `/public/v1/catalog`; approval notes are
private. Future-effective publications remain visible in Admin history while the
public feed retains the currently effective version. This does not select a
checkout legal release or sign a processing instruction.

Stage A refuses schedule/contract changes through Admin when any order already
exists; price/editorial changes preserve accepted order snapshots. Stage B's paid
order classification/notifications/provider-delivery qualification remains open
in TOUR-64 before first sales. This is an undeployed source receipt, not complete
TOUR-63/SSR integration or sales authorization.
