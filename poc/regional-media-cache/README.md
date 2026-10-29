# TOUR-88: isolated regional photo-cache PoC

**Not a VPS installer. Production qualification NO-GO; owner decision pending.**
See [ADR](../../docs/adr/2026-10-29-regional-media-cache.md) for measurements and
remaining gates. CUSTODY_IMPACT: NO — local test resources only; adman-vps reads
use the owner's SSH permission. No production DNS/route, S3 write or credentials.

Run from repository root with Docker Compose, Python ≥3.9 and openssl:

```sh
python3 poc/regional-media-cache/run.py /tmp/tour-88-local-poc.json
```

This creates a dedicated local Compose project, a one-day disposable TLS cert
for `media.localhost`, disk cache and a synthetic origin. Images are pinned by
digest. Only localhost ports **18088** (fixture control) and **18488** (TLS) are
published; cache has no published port. Do not run with a remote Docker context.
The dedicated bridge is not attached to production networks; outbound networking
is not firewall-qualified. No Docker socket is mounted. Leave the fixture
control endpoints off any shared or public host. Ports must be free. Only one
run per checkout is allowed (`.runtime/` is the lock); there is no public purge API.
The fixture bytes identify synthetic WebP but are not a decodable photograph:
this suite does not prove image rendering or LCP.

The runner verifies TLS against its test CA, exact byte identity, MISS/HIT,
HEAD/ETag, TTL revalidation, 12-way miss collapse, path/query/private exclusions,
credential/method/host refusal, header poisoning, negative responses, no stale
on origin outage, scoped revoke and cache failure with independent direct
availability. The private sentinel exists at the fixture origin and is
*deliberately readable there*: refusal at the cache cannot accidentally pass
because the object is missing. This does **not** prove real S3 bucket ACLs.

NGINX allowlists the raw target **as received from Traefik**. Traefik normalizes
some URL aliases first; an alias can only reach the same public allowlisted
object. Query and private-path variants remain denied. No arbitrary upstream
URL, bucket, Host or browser header is forwarded. The origin hostname in
`nginx.conf` is a fixture, not an S3 production setting.

Scoped revocation is demonstrated by stopping all cache workers, persisting the
denial, deleting exactly the `md5("public-v1:" + path)` file under this test's
cache root, then reopening. Sibling entries remain HIT. This is an offline
administrative operation with brief cache outage. A production procedure must
also unpublish every direct S3 URL and remove the source variant; stopping this
cache alone cannot revoke direct S3 access or a downloaded photograph. Browser
freshness is zero, no stale serving is allowed. Do not use a year-long immutable
browser TTL for consent-dependent images. Reinstatement of a revoked key is a
separate owner operation; denied keys must remain durable across restore.

The suite exits zero when its scoped assertions pass, **including observations
of production deficiencies**. Inspect `productionQualification`,
`observations.responseSizeGate` and `observations.mimeGate`: 2 MiB still passes a
1 MiB `proxy_max_temp_file_size`, and wrong MIME bypasses caching but is delivered.
Neither a CI check nor this configuration is production admission. Disk
`max_size` is an asynchronous eviction target, not a filesystem quota. No
host-level aggregate bandwidth/I/O cap or production regression is demonstrated.

The runner always tears down its own Compose project and disposable files on
ordinary exit/failure. After a killed runner, inspect first, then clean up:

```sh
docker compose -p mikluha-tour88-local -f poc/regional-media-cache/compose.yaml down --remove-orphans
```

Remove only this checkout's `.runtime/` after verifying that project's containers
are gone. Reports include hashes of tested PoC sources, container image IDs,
enforced CPU/memory/pid/read-only limits, checks, counters and local timings.
CI `regional-media-cache` uploads a fresh report; `site-ssr` separately proves
the existing SSR runtime resolver `direct → cdn → direct` on one site image.
The new resolver unit case scopes the cache prefix to processed photos; videos,
originals and purchase fields remain outside it. The rendered SSR switch does
not implement automatic failover of images in already-served HTML.

Read-only discovery and direct-S3 baseline (no private objects, 40 small GETs):

```sh
python3 poc/regional-media-cache/measure-direct.py --vantage operator-mac > /tmp/tour88-direct-mac.json
ssh adman-vps 'python3 - --vantage adman-vps' < poc/regional-media-cache/measure-direct.py > /tmp/tour88-direct-vps.json
ssh adman-vps 'python3 -' < poc/regional-media-cache/inventory-vps.py > /tmp/tour88-host.json
```

SSH scripts do not print env, credentials or credential hashes. The inventory
selects the known Mikluha container prefix; a missing/replaced app fails rather
than inspecting unrelated containers. Baselines use current public **mutable**
WebP names found in the live HTML; they are not inputs to a production cache.
Regional A/B and mobile LCP protocol/budgets are fixed in the
[experiment design](../../docs/plans/2026-10-29-tour-88-regional-media-cache-design.md).
