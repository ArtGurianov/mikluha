# TOUR-56 (ART-356) · TurboFlare × cloud.ru Evolution S3 PoC and tested media fallback

- **Status (2026-10-29):** tooling and run protocol in source; **live probe NOT_RUN**, **legal
  go/no-go NOT_RUN**. Decision: **TurboFlare NOT QUALIFIED** until both pass. Direct cloud.ru
  processed-variant URLs are the normal production mode (`MEDIA_DELIVERY=direct`, the default).
- **Canon:** ADR v2.3 §2 (media URLs resolved at request time; the fallback is a runtime
  configuration switch, no HTML rebuild). Image pipeline and private originals: TOUR-63 (ART-364).
  Legal release: TOUR-68 (ART-369), privacy: TOUR-35 (ART-273).

## What is in the repository

| Piece | File | Role |
|---|---|---|
| Runtime switch | `lib/cms/media-delivery.ts` | `MEDIA_DELIVERY=direct\|cdn`; under `cdn`, only URLs under `MEDIA_ORIGIN_BASE` are served from `MEDIA_CDN_BASE`, same remaining path. Anything else (a private original, another bucket, `/media/demo/`) is never rewritten. Bad config fails the render instead of guessing |
| Where it applies | `lib/cms/content.ts` | Every image/video `src` of the SSR snapshot, per request. The static export is untouched |
| Probe | `scripts/media-probe.ts`, `lib/media-probe.ts`, `lib/s3-sigv4.ts` | One run of the matrix below; JSON + Markdown evidence with `PROBE_OUT`. The S3 key only signs one HEAD (read-only key; never written to the evidence) |
| Switch evidence | `scripts/ssr-smoke.ts` with `EXPECT_MEDIA` | Asserts which host the rendered HTML points browsers at, and the `/identity` commit |
| CI | `.github/workflows/ci.yml` job `site-ssr` | The same SSR image started `direct → cdn → direct`; every run reports the same commit, so no rebuild happened |

The CI switch run uses a non-resolving CDN base (`media.cdn.invalid`): it proves the mechanism,
not TurboFlare.

## Pass/fail matrix (one probe run)

Required rows decide `TECHNICAL_PASS`; the others are recorded for the decision.

| ID | Check | Required |
|---|---|---|
| T1 | Direct cloud.ru HTTPS serves the processed variant (200) | yes |
| T2 | The TurboFlare custom host serves it over valid TLS, without a redirect | yes |
| T3 | MIME type matches the variant's extension on both | yes |
| T4 | CDN bytes are byte-identical to the origin's (SHA-256): no transformation | yes |
| T5 | A never-seen URL is a cache MISS, the repeat a HIT | yes |
| T6 | Edge TTL (`s-maxage`, else `max-age`) ≥ `PROBE_MIN_TTL` (default 86 400 s) | yes |
| T7 | The CDN sets no cookie | yes |
| T8 | The private original exists (authorized SigV4 HEAD, `PROBE_S3_*`) | yes |
| T9 | Anonymous direct request for it is refused (401/403/404); a network error or an unconfirmed object is FAIL | yes |
| T10 | The same through the CDN host (`PROBE_PRIVATE_CDN_URL`, required) | yes |
| T11 | Plain HTTP on the CDN host redirects to HTTPS or is refused | no |
| T12 | CORS allows the site origin | yes |
| T13 | `X-Content-Type-Options: nosniff` | no |
| T14 | `Strict-Transport-Security` | no |

Rules that hold whatever the matrix says: only processed public variants are ever public; originals
stay private (TOUR-63); no CNAME straight to the bucket and no always-on gateway are assumed — T2
is run against the host TurboFlare actually provides; no image transformation or private-origin
authentication is claimed for TurboFlare.

## Run protocol (owner, non-production)

1. **Objects.** In the bucket, one processed variant under the public prefix (e.g.
   `cms/probe/turboflare-probe.webp`) and one private original outside it, not publicly readable.
   No customer media.
2. **TurboFlare.** A non-production custom host whose origin is the cloud.ru Evolution S3 public
   endpoint, TLS issued for that host. Record the provider's account/contract identity for the
   legal check below. No production domain, no DNS change of `mikluha-maklai.ru`.
3. **Probe** (twice, a few minutes apart, so T5 is not luck):

   ```bash
   PROBE_ORIGIN_BASE=https://mikluha-maklai.s3.cloud.ru/cms/ \
   PROBE_CDN_BASE=https://<turboflare host>/cms/ \
   PROBE_VARIANT=probe/turboflare-probe.webp \
   PROBE_PRIVATE_URL=https://mikluha-maklai.s3.cloud.ru/<private original> \
   PROBE_PRIVATE_CDN_URL=https://<turboflare host>/<private original> \
   PROBE_S3_ENDPOINT=https://s3.cloud.ru PROBE_S3_BUCKET=mikluha-maklai PROBE_PRIVATE_KEY=<private original> \
   PROBE_S3_ACCESS_KEY_ID=… PROBE_S3_SECRET_ACCESS_KEY=… \
   PROBE_OUT="$HOME/tour-56-evidence" pnpm exec tsx scripts/media-probe.ts
   ```

4. **Switch and switch back** on a non-production SSR application (the TOUR-60 image; any commit):
   set `MEDIA_DELIVERY=cdn`, `MEDIA_ORIGIN_BASE=https://mikluha-maklai.s3.cloud.ru/cms/`,
   `MEDIA_CDN_BASE=https://<turboflare host>/cms/` in Coolify and restart; run
   `scripts/ssr-smoke.ts` with `EXPECT_MEDIA=cdn`; set `MEDIA_DELIVERY=direct`, restart, run it
   with `EXPECT_MEDIA=direct`. Record the image digest and `/identity` of every step: they must not
   change (no rebuild). Open a page in a browser on both modes; images must load.
5. **Record** in Plane (TOUR-56): both probe outputs, the switch log, and the decision below. The
   evidence files carry no secret; they still stay out of Git.

## Legal go/no-go (NOT_RUN — owner/lawyer)

Each item needs a source document, not an assumption. Link the evidence to TOUR-68 and TOUR-35.

- [ ] Provider's corporate identity (legal entity, INN/OGRN, jurisdiction) and the contract it offers.
- [ ] Edge and subprocessor locations: where visitor requests terminate and where logs are kept.
- [ ] What the edge logs (IP, User-Agent, URL, timestamps), for how long, and in which role
      (operator vs. processor) for Mikluha's visitors; the legal basis under 152-FZ.
- [ ] A processing instruction / agreement (152-FZ art. 6 §3) where the provider processes on
      Mikluha's behalf.
- [ ] Localization (152-FZ art. 18 §5) and cross-border transfer (art. 12) analysis, including a
      notification to Roskomnadzor if a transfer occurs.
- [ ] The privacy policy and cookies page change this requires (TOUR-68), published before any
      activation.

## Decision record

| Date | Technical | Legal | TurboFlare | Production mode |
|---|---|---|---|---|
| 2026-10-29 | NOT_RUN (tooling ready; a dry run against a non-resolving host fails T2–T6 as it must) | NOT_RUN | NOT QUALIFIED | `direct` |

Qualified only when the technical result is `TECHNICAL_PASS` on two runs, switch and switch-back
are recorded, and every legal item is closed with evidence. Either failing: TurboFlare is not
activated and `direct` stays the normal mode, not an incident workaround. Activating it in
production is a configuration change of the SSR application (`CUSTODY_IMPACT: YES` for the env
change on the host).
