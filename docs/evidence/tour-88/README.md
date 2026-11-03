# TOUR-88 evidence, 2026-10-29

Scope: local PoC, public-S3 baselines, then owner-authorized disposable VPS-16
experiment and manual Kemerovo SSH-tunnel probe. Temporary host resources were
created and removed; CUSTODY_IMPACT YES / CUSTODY_PENDING. No production cutover,
DNS change, private photo/credential access or commercial API load.
`ownerDecision=PENDING`.

- `local-poc-initial-ungated.json`: historical plain-NGINX first trial, with
  explicit failed size/MIME production gates.
- `local-poc-real-s3.json`: current bounded njs suite plus same-real-WebP direct /
  localhost cold / localhost warm comparison, with source hashes. Not a VPS comparison.
- `kemerovo-home-no-vpn.json`: owner manual curl run, 30/image, declared Kemerovo
  home network / VPN off; script hash, byte identity and raw summaries verified.
  Proxy configuration is bypassed, physical/VPN state remains owner-declared.
- `local-poc.json`: scoped assertions and admission results, exact source
  file SHA-256 values, image IDs and resource caps. Reproduce with
  `python3 poc/regional-media-cache/run.py /tmp/tour88.json`. Timings are local
  Docker synthetic bytes; they do not establish regional image performance.
- `direct-adman-vps.json` and `direct-operator-mac.json`: 20 GETs per legacy
  public WebP key per vantage; headers, byte hashes and raw TTFB/full transfer
  samples. No cache comparison. Mac location/network unverified.
- `host-readonly.json`: sanitized read-only live host snapshot, deployed site
  identity and active NGINX server config. Memory/headroom observations expire.
- `geography.json`: RIPE prefix observation, source URLs and eight-hop route
  excerpt. Exact VPS/bucket physical placement remains unconfirmed.

Source baseline before this change: `5e2e2d0` on origin/main; full hash below.
CI `regional-media-cache` uploads a new report for the PR candidate. Independent
`site-ssr` CI qualifies the resolver cycle on the same candidate site image;
neither proves a production route or owner/legal approval.

Full baseline: `5e2e2d01255bbf646a601d8cf2e9214a30f57ded`.

## VPS-16 follow-up

- `kemerovo-vps-tunnel.json`: owner-run no-VPN-declared Kemerovo comparison,
  10/image/path; 40 valid responses. All summaries and hashes were recomputed.
- `vps-16/manual-vps-probe.executed.py.txt`: exact executed client source; its
  SHA-256 equals `probeSha256` in the JSON. Current CLI source uses a relative
  import; it is not retroactively claimed to be the executed version.
- `vps-16/server-probe-attempt-1.json`, `server-attempt-1.json`: pinned e46d6a2
  safety suite PASS, warm-classification assertion FAIL at 18/20 HIT. Retain
  this failure; two-second TTL crossing is not suppressed.
- `vps-16/vps-stage-result.json`: bounded continuation, sparse before/after
  container identity, authority and cleanup data; 545-second overall work window.
- `vps-16/collector-receipt.json`, `cleanup-readback.json`: independent directory,
  container/network and port cleanup read-back, including after collection.
- `vps-16/preflight-attempt-1.json`: snapshot-template failure before containers.
- Operational controller/launcher `.py.txt` files and `launch.json` preserve
  execution evidence. These are **historical, do not replay**. No private test
  key/certificate bytes, production env, S3 credentials or secret hashes are kept.

Canonical drift and the disposable-resource inventory are in infrastructure
VPS-16. Active baseline files are not rewritten to pretend removed paths are
installed. Fresh custody capture/restore is NOT_RUN; no custody PASS is claimed.
