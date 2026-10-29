# TOUR-88 · Regional photo cache: NO-GO for production now

Date: 2026-10-29. **Status: experiment / recommendation; owner GO/NO-GO PENDING.**
The engineering recommendation is **B: retain direct cloud.ru delivery** until
the gates below have evidence. This is not owner acceptance of B, permanent
rejection of a regional cache, or permission to activate TurboFlare.
CUSTODY_IMPACT: **NO** — local PoC and read-only VPS/S3 discovery; no deployed
host files, env, networks, routes, keys or persistent state changed.

Scope: [TOUR-88](https://app.plane.so/art-workspace/browse/TOUR-88/),
[experiment design](../plans/2026-10-29-tour-88-regional-media-cache-design.md),
[reproduction](../../poc/regional-media-cache/README.md),
[raw evidence index](../evidence/tour-88/README.md). Related current work:
TOUR-56 (TurboFlare), TOUR-63 (secure image ingest), TOUR-68 / TOUR-35 (legal),
TOUR-53 (parent epic). Their scope and existing gates are unchanged.

## Current source and served path

Inspected source baseline: `5e2e2d0` (use the complete hash in the evidence index).
`lib/cms/content.ts` reads media env during dynamic SSR requests;
`lib/cms/media-delivery.ts` implements `MEDIA_DELIVERY=direct|cdn`, origin-prefix
rewrite, and direct as default. A runtime env update requires a process restart,
not HTML/image rebuild. It does not health-check the edge or rewrite HTML already
in browsers. Unit coverage includes the narrower `/processed/` photo prefix;
existing `site-ssr` CI tests direct → cdn → direct using one image. Actual S3/TLS
cache delivery and rendered SSR are distinct evidence paths.

The **served** site is still a static NGINX container at image commit
`349098bcceb8c8c010c07b0ced528c9ea12c6c7a`, confirmed over owner-authorized SSH.
Its active default server uses filesystem `try_files`; no `proxy_cache` is
configured there. Thus changing the SSR env on today's static runtime would
not switch production media. SSR activation belongs to its separate release.
The live homepage points at public S3 `/cms/mikluha-thumbnail.webp` (181,750 bytes)
and `/cms/organized.webp` (470,636 bytes); video is outside this experiment.
Both returned `image/webp`, ETag and Last-Modified, without Cache-Control in
these requests. They use **mutable names**, not immutable versioned keys.
`CmsImage` uses native `<img>`; no Next/Image optimizer, srcset or sizes was
found in app/components. Variant sizing remains TOUR-63 work, potentially more
valuable than caching oversized files. No second runtime optimizer was added.

## Geography and baseline

Read-only host snapshot: 6 vCPUs, 7.75 GiB RAM, ~4.87 GiB available, ~25.76 GiB
root disk available, load ~0.39/0.44/0.41. This is a momentary headroom observation,
not a reservation for another 5–10 GB cache. Existing Mikluha container has no
Docker memory/CPU limits. Some unrelated canaries were already unhealthy before
this experiment; none were restarted or used for load testing.

RIPE RDAP assigns `185.175.159.0/24` to Adman, RU.
[Adman describes its Novosibirsk-area facility](https://adman.com/pages/dc/).
These support the regional hypothesis, but an account/order receipt tying this
VPS to that facility is **NOT_CONFIRMED**. S3 resolved from VPS to
`176.109.98.30` / `.31`. An eight-hop trace rose from ~1 ms to ~45–53 ms and did
not reach the destination; it proves neither a city nor a complete route.
[Cloud.ru describes Evolution infrastructure in Russia](https://cloud.ru/docs/evolution/overview/index),
but the exact bucket location remains **NOT_CONFIRMED** by account evidence.
Do not infer physical city from `ru-central-1`, DNS or RTT.

Twenty sequential anonymous HTTPS GETs per key, fresh TLS connection per sample:

| Vantage / legacy WebP | TTFB p50 / p75 / p95, ms | Full transfer p50 / p75 / p95, ms | Errors |
|---|---|---|---|
| VPS / thumbnail | 187 / 224 / 381 | 337 / 374 / 537 | 0/20 |
| VPS / organized | 199 / 227 / 375 | 423 / 522 / 720 | 0/20 |
| Operator Mac / thumbnail | 749 / 1024 / 1624 | 1881 / 1974 / 2705 | 0/20 |
| Operator Mac / organized | 734 / 867 / 1568 | 1814 / 2035 / 2880 | 0/20 |

Mac network/location is not independently verified. These are **direct-S3
baselines only**, not Kemerovo/Novokuznetsk/Novosibirsk audience measurements.
Each vantage downloaded 13,047,720 bytes across 40 GETs; no provider invoice or
egress dashboard was read. Regional cold MISS, warm HIT, HIT rate, mobile p75
LCP and shared-host commercial p95 regressions are **NOT_RUN**. The local tiny
synthetic fixture's timings must never be compared to this table as speedup.

## Isolated PoC result and its limits

Pinned Traefik TLS → NGINX **disk** proxy_cache → synthetic HTTP origin runs
locally, with loopback-only published test ports and a private Compose bridge.
It has no S3 keys, real private photos, Docker socket or shared host routes.
The bridge is not an egress firewall. Certificate trust is checked against a
disposable test CA; this is not real custom-domain DNS/ACME/S3 peer-TLS evidence.

The checked report records 38 scoped passing assertions: MISS→HIT with byte
identity; HEAD; client 304 and expired ETag revalidation; 12 concurrent cold
requests collapse into **one** upstream request; negative/private paths and
query attacks never reach the private sentinel; Host/auth/cookie/method refusal;
header poisoning protection; no caching of 404/503/timeouts, Set-Cookie,
private/no-store or wrong MIME; no internal X-Accel redirect; no stale photo on
origin outage; offline single-key revoke deletes the selected file and denies
refill while a sibling remains HIT; cache outage leaves direct origin available.

Traefik can normalize aliases before NGINX sees `$request_uri`; allowed aliases
may only resolve to the exact same public object. Private-path and encoded
traversal probes remain denied. This matches the proxy's
[documented normalization](https://doc.traefik.io/traefik/v3.6/reference/install-configuration/entrypoints/).
Only finite allowlisted keys are proxied; NGINX does not verify content digests.
A real ingest manifest must establish immutable bytes, public classification,
MIME, dimensions, size and permission for every admitted key.

**Two production gates fail in the executable experiment:** a 2 MiB body passes
`proxy_max_temp_file_size 1m`, and wrong MIME is delivered uncached rather than
refused. NGINX's [proxy module documentation](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_max_temp_file_size)
explains the first limitation. `max_size=32m` is also an eviction target, not a
hard filesystem quota. Production needs a verified bounded ingest and/or strict
response gate, a hard disk budget, and tested I/O/aggregate traffic controls.
The suite's green result deliberately does not mean production qualification.

Local enforced caps are cache 128 MiB / 0.25 CPU / 32 pids, origin 96 MiB /
0.25 CPU / 32 pids, test Traefik 96 MiB / 0.25 CPU / 64 pids; roots read-only.
Cache is limited to 16 active requests and 20 requests/s plus burst 32;
per-response read/send rate is 1 MiB/s. Local resource snapshot is after the
short test, not peak/burst capacity evidence. Host I/O, total bandwidth and
5–10 GB quota/eviction saturation remain unqualified. No load was applied to
Commerce, SSR, Admin or bank callbacks on the shared VPS.

## Revocation, legal and cost boundaries

Lab browser freshness is zero (`max-age=0, must-revalidate`); error responses use
no-store and stale-on-error is disabled. Test edge freshness is 2 seconds for
fast revalidation checks, not a proposed production TTL. Proposed operational
revocation target: ≤5 minutes after an authorized request, with denial before
reopening; this SLA has not been accepted or measured on the VPS. Stop workers,
persist the key denial, delete exactly its cache file, then reopen. Keep denial
across restarts/restores. Direct S3 variants must also be removed/unpublished;
otherwise direct fallback defeats cache-only revocation. Browser downloads
already held by a person cannot be recalled. Do not promise instant erasure or
a year-long browser TTL for consent-dependent photos.

Production data flow would be visitor IP/TLS → existing Traefik → public photo
cache → public S3 variant. Private originals, video, documents and customer data
stay outside it. NGINX access logging is disabled in the lab and runtime errors
are suppressed; Traefik access logs are not enabled. Existing shared Traefik/
provider network logs, retention, operator roles and exact locations still need
a real audit. No new TurboFlare processor is added by this design. This fact
alone does not establish legal compliance. TOUR-68/TOUR-35 must separately accept
photo permissions, anonymization, withdrawals, disclosures and retention before
any real tourist-photo cache activation. Synthetic data has no consent claim.

No extra provider charge was incurred by a cache installation (none occurred).
Marginal VPS price, included transfer and disk terms are **NOT_VERIFIED**.
Capacity has opportunity cost even if the monthly VPS invoice stays unchanged.
Compare actual contracted prices using, for monthly requests N, hit fraction h,
mean bytes B, GET price g and egress price e:

- direct: `N*g + N*B*e`;
- cache origin portion: `N*(1-h)*g + N*(1-h)*B*e`, plus revalidation, VPS transfer,
  disk, monitoring, custody and operator work;
- TurboFlare: measured origin miss cost plus its accepted provider tariff.

Do not present maximum theoretical savings as a bill reduction. A separate
regional VPS is justified only if measured user benefit survives its added
cost and isolates a resource budget the shared host cannot guarantee. A CDN
needs a new assessment if multiple regions, higher availability or sustained
traffic exceed the single cache's tested envelope.

## Decision still required

| Gate | Receipt now |
|---|---|
| Local cache/security mechanism | 38 assertions PASS; size/MIME production gaps explicit |
| Real public immutable S3 + known existing private original | NOT_RUN; TOUR-63 manifest/pipeline needed |
| Actual media-host DNS/TLS, S3 TLS verification, purge and SSR rollback | NOT_RUN; production installer absent |
| Three regional networks / mobile LCP / commercial budgets | NOT_RUN; proposed protocol fixed before trials |
| Hard disk/response/I/O/traffic bounds and outage recovery | NOT_QUALIFIED |
| Exact VPS/bucket location and legal acceptance | NOT_CONFIRMED / NOT_RUN |
| Owner A / B / C decision | PENDING |

Recommend **B now**. The owner may accept B, authorize a separately bounded next
experiment, or request C (external CDN reassessment). A requires the missing
receipts, then a separate production implementation with infrastructure issue,
resource authorities, rollback and custody refresh/restore evidence. Only an
accepted A triggers updates to TOUR-56/63/68/53. No dependent task was rewritten,
TurboFlare remains NOT QUALIFIED, and the default stays direct S3.
