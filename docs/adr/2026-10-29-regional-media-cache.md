# TOUR-88 · Regional photo cache experiment

2026-10-29. **Production NOT QUALIFIED. Owner decision A/B/C PENDING.**
The owner requested continued local-cache research and did **not** accept B.
Direct S3 remains the existing default; no TurboFlare activation or production
cutover is authorized by this PoC. CUSTODY_IMPACT: **NO** for work executed so
far: local test resources and owner-authorized read-only VPS/S3 requests only.

Scope: [TOUR-88](https://app.plane.so/art-workspace/browse/TOUR-88/),
[protocol/budgets](../plans/2026-10-29-tour-88-regional-media-cache-design.md),
[reproduction](../../poc/regional-media-cache/README.md),
[evidence index](../evidence/tour-88/README.md). TOUR-56/63/68/53 scopes and gates
are unchanged. Legal review remains TOUR-68 / TOUR-35.

## Inventory and geography

Source baseline `5e2e2d0` implements request-time SSR
`MEDIA_DELIVERY=direct|cdn`, `MEDIA_ORIGIN_BASE` / `MEDIA_CDN_BASE` prefix rewrite.
Changing env restarts the same SSR image; it does not rebuild HTML or repair
image URLs in an already-open browser. Existing `site-ssr` CI exercises
`direct → cdn → direct`. The cache prefix can be `/processed/` so video,
originals and purchase fields remain outside it.

The **served** site is still static NGINX, image commit
`349098bcceb8c8c010c07b0ced528c9ea12c6c7a`. Its active default server uses
filesystem `try_files`, without `proxy_cache`. Today's production cannot switch
via SSR env; SSR release is a separate gate. `CmsImage` uses native `<img>`,
without Next/Image, srcset or sizes. TOUR-63 variant sizing is still needed.
Current public S3 WebP names `/cms/mikluha-thumbnail.webp` (181,750 bytes) and
`/cms/organized.webp` (470,636 bytes) are mutable. They returned image/webp,
ETag/Last-Modified, without Cache-Control in observed requests.

Read-only host snapshot: 6 vCPUs, 7.75 GiB RAM (~4.87 available), ~25.76 GiB disk
available, load ~0.39/0.44/0.41. This is not a capacity reservation. Existing
Mikluha container has no Docker CPU/memory cap. No unrelated canary was restarted
or used for load testing.

RIPE assigns 185.175.159.0/24 to Adman, RU; [Adman describes its facility near
Novosibirsk](https://adman.com/pages/dc/). Exact placement of this VPS remains
NOT_CONFIRMED by an account/order receipt. S3 resolved to 176.109.98.30/.31;
an incomplete eight-hop trace grew from ~1 ms to ~45–53 ms, without reaching the
destination. Neither DNS, RTT nor `ru-central-1` proves a city.
[Cloud.ru describes Evolution infrastructure in Russia](https://cloud.ru/docs/evolution/overview/index);
the bucket's exact physical location remains NOT_CONFIRMED by account evidence.

## Direct baseline from Kemerovo

Owner-declared Kemerovo / home network / VPN off, 2026-10-29 **19:05–19:06
Asia/Novosibirsk**, manual curl run. Script SHA-256, raw summaries and all byte
hashes were independently checked against the saved JSON. curl configuration
and explicit/system HTTP proxy settings were bypassed; VPN state/location are
operator declarations. Fresh curl/TCP/TLS per request, interleaved image order:

| Public WebP | TTFB p50 / p75 / p95, ms | Full transfer p50 / p75 / p95, ms | Errors |
|---|---|---|---|
| thumbnail | 382 / 586 / 764 | 993 / 1186 / 2640 | 0/30 |
| gallery | 341 / 405 / 544 | 1434 / 1850 / 2745 | 0/30 |

This is a useful **regional direct baseline**, not a VPS-cache comparison,
mobile LCP or the ≥100 samples/key/mode acceptance run. `UNKNOWN` cache status
means no recognized status header, not proof of no intermediary cache.
The earlier direct VPS baseline (20/key) had p75 TTFB 224/227 ms and full-transfer
p75 374/522 ms, 0/40 errors. Earlier Mac Python measurements had unknown VPN state
and a different HTTP/TLS client. Do not attribute differences to VPN or combine
these runs into one controlled A/B experiment. No provider billing was read.

## Local bounded-cache PoC

Pinned Traefik TLS → NGINX disk proxy_cache → **loopback njs admission in the
same NGINX** → fixed public-origin URL. No separate gateway service or arbitrary
proxy URL. The finite offline manifest pins source URL, SHA-256 and validator;
private originals, video, documents and customer data are excluded. Traefik can
[normalize aliases](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/entrypoints/)
before NGINX; they can only reach the same allowlisted public object. Queries,
credentials, host override and private-path variants are refused.

Initial plain-NGINX evidence is preserved in `local-poc-initial-ungated.json`:
`proxy_max_temp_file_size 1m` did not cap a 2 MiB response, and wrong MIME was
served uncached. The [NGINX proxy documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_max_temp_file_size)
explains that limitation. **Current admission fixes both before cache fill:**
≤1 MiB complete body, image/webp MIME and SHA-256 match; cookies/private/no-store
and redirects are refused. S3 uses trusted system CAs and `verify=true`.
[njs 1.0.2](https://nginx.org/en/docs/njs/changes.html) is pinned because it fixes
size enforcement for chunked responses. This is response admission, not image
transformation or proof of tourist-photo permissions.

The reproducible suite checks MISS/HIT and byte identity; HEAD/client 304;
expiry/revalidation; 12 cold requests → one upstream; known-existing private
sentinel exclusion; traversal/query/header attacks; failure responses; MIME,
Content-Length/chunked oversize and altered-byte refusal; redirect/TLS refusal;
no stale-on-error; offline one-key denial/deletion with a retained sibling;
cache failure with independent direct availability. Fixture control endpoints
and test CA exist only locally. The bridge is not an egress firewall, and no
production S3 ACL/private-original proof is claimed.

Optional `--real-s3` compares the **same real public WebP bytes** via direct,
local cold and local warm paths. Content-addressed local aliases pin existing
mutable S3 source bytes; this does not implement TOUR-63 immutable uploads.
The local endpoint is on the Mac, so its HIT time is **not Kemerovo→VPS latency**.
Admission buffers the full body before the first downstream byte, adding cold
TTFB cost; Docker networking and HTTP/TLS stacks also differ between these paths.
The current local run (10 direct / 10 cold / 20 measured warm per image, no
errors, exact byte identity) records:

| WebP | Direct / local cold p95 TTFB, ms | Local warm p75 TTFB / full transfer, ms |
|---|---|---|
| thumbnail | 963 / 1583 | 13 / 179 |
| gallery | 1902 / 3265 | 12 / 441 |

This local cold comparison exceeds the proposed +100 ms budget; it is **not**
a regional VPS verdict. 40/40 measured local warm responses were HIT. Source
hashes tie the 44 synthetic checks and 54 combined checks to the candidate.
Warm loopback speed alone cannot pass regional cold-regression or LCP budgets.

Local enforced caps: cache 128 MiB / 0.25 CPU / 32 pids, test origin and Traefik
96 MiB / 0.25 CPU each; roots read-only. NGINX allows 16 active requests,
20 requests/s + burst 32 and 1 MiB/s downstream per response. Cache
`max_size=32m` is asynchronous eviction, **not a filesystem quota**. Hard disk,
I/O and aggregate traffic limits, burst/eviction saturation and commercial p95
regression remain unqualified; no shared-VPS load was applied. Snapshot resource
usage is not peak evidence.

## Revocation, legal and decision gates

Browser freshness is zero (revalidate or no-store), stale serving disabled;
2-second lab edge TTL accelerates tests. Proposed revoke SLA ≤5 minutes is not
accepted or VPS-measured. Stop cache workers, persist denial, delete only that
key, reopen; denial must survive restore. Also unpublish/delete direct S3
variants, or direct fallback defeats revocation. Previously downloaded copies
cannot be recalled. Avoid a year-long browser TTL for consent-dependent photos.

Real data flow would be visitor IP/TLS → existing Traefik → cache → public S3.
Lab access logs are disabled; shared proxy/provider logs, roles, retention,
locations, photo permissions/anonymization, withdrawals and disclosures still
need TOUR-68/35 acceptance. Own VPS adds no TurboFlare processor, which alone
does not prove legal compliance. No real private photos or credentials were used.

No cache installation charge was incurred. Contracted VPS transfer/disk terms
and provider prices are NOT_VERIFIED. Compare direct `N*g + N*B*e` with cache
origin cost `N*(1-h)*g + N*(1-h)*B*e` plus revalidation, VPS traffic/disk,
monitoring, custody and operator work. TurboFlare requires its separately
accepted tariff and qualification. Warm cache's theoretical savings are not a
bill receipt. A separate regional VPS is justified only by measured user benefit
and an isolated capacity budget; multi-region/availability/traffic needs may
justify a separate CDN assessment.

| Gate | Current receipt |
|---|---|
| Local cache, bounded size/MIME/hash, failure/revoke mechanisms | Executable local suite; see current source-hash receipt |
| Real public bytes through local cache + verified S3 TLS | Local `--real-s3` evidence; not regional VPS traffic |
| Kemerovo direct baseline | 60/60 measured responses OK, operator declares VPN off |
| Real immutable S3 ingest and known existing private original ACL | NOT_RUN; TOUR-63 needed |
| Kemerovo→VPS cold/warm, other cities/mobile/LCP, commercial budgets | NOT_RUN |
| Real media-host DNS/TLS, SSR-to-cache rollback, hard disk/I/O/traffic | NOT_QUALIFIED |
| Exact VPS/bucket placement and legal acceptance | NOT_CONFIRMED / NOT_RUN |
| Owner A/B/C | PENDING; owner chose to continue research |

A needs the missing receipts, then separately approved production implementation,
infrastructure resource authorities, rollback and fresh custody/restore evidence.
Only an accepted A changes TOUR-56/63/68/53. Default remains direct S3, TurboFlare
NOT QUALIFIED. No task completion, CI success or local result activates production.
