# TOUR-88 regional media cache experiment

Scope is the Plane card TOUR-88: research and isolated non-production PoC, with
owner-authorized **read-only SSH** to adman-vps. No host install, production
route/DNS changes, credential operations or sales/financial activation.

Compare three options: keep direct cloud.ru processed WebP (current default),
reuse the regional VPS with a narrowly scoped NGINX disk cache, or independently
qualify TurboFlare. Recommend keeping direct until the regional cache has both
technical and legal evidence and an explicit owner decision. A local cache can
reduce repeat S3 fetches, but adds shared disk/I/O, operational and revocation
risk. TurboFlare adds another provider and remains NOT QUALIFIED under TOUR-56.

Use a local Traefik TLS → NGINX proxy_cache → synthetic origin fixture. No real
private originals, tourist data or S3 keys are copied to the lab. Allow only
exact immutable processed WebP keys as received after Traefik normalization; reject queries and
credential-bearing requests; normalized aliases may reach only the same public key; fix upstream authority and strip browser headers.
Test MISS/HIT, concurrent misses, ETag and expiry, origin errors/outage, poisoned
headers and scoped revocation. Keep all browser responses immediately
revalidated, no stale-on-error. Revocation closes cache workers, persists denial,
deletes just the selected cache key, then reopens; sibling entries survive.

Before performance trials, propose these acceptance criteria (they are **not
owner-approved production budgets**): at least 20% and 30 ms improvement in warm
p75 image TTFB on each of the three regional networks; cold p95 no more than
100 ms worse than direct; errors ≤0.1%; Commerce/SSR p95 regression ≤5% **and**
≤10 ms, with no additional errors; mobile p75 LCP no regression and ≥100 ms gain
on image-dominated pages. Use ≥100 samples/key/mode/network and 30 page loads
per mode/network, alternating comparable time windows. Mobile is separate.

Read-only S3 baseline here uses only 20 sequential GETs for each of two public
legacy WebP keys from Mac and VPS. This is inventory, not the regional experiment
or an immutable-variant qualification. Never compare these to tiny local
synthetic bytes as a performance gain. Missing regional/mobile, real private
original, hard resource bounds, physical-location, legal and rollback receipts
remain explicit NO-GO gates in the ADR. Checkout is never called by the cache;
absence of commercial regression must still be measured before production.


## Follow-up accepted for research, 2026-10-29

The owner chose continued local-cache research, not decision B. Initial plain
NGINX could neither enforce a maximum response size nor reject wrong MIME before
delivery. The next local experiment therefore uses njs 1.0.2 admission inside
the same NGINX: fixed public URL and SHA-256 manifest, full body ≤1 MiB, MIME,
TLS/redirect/cookie/private-response checks before cache fill. Chunked length,
changed content and untrusted TLS are adversarial cases. This preserves one
cache process and adds no separate universal gateway, but increases cold TTFB.
The experiment must report that regression rather than qualifying on warm HIT.

The owner supplied a direct-S3 run from Kemerovo home network, VPN off by
operator declaration: 30 requests per image, all bytes match, 0/60 errors.
This is an exploratory regional baseline, not the planned ≥100/key/mode
comparison or independent physical/VPN verification. Future VPS experiments
remain separately bounded and subject to the infrastructure host-write rule.
