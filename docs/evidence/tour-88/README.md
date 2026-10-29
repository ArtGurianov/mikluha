# TOUR-88 evidence, 2026-10-29

Scope: local synthetic PoC plus owner-authorized read-only adman-vps and
anonymous public-S3 baseline. No deploy, host write, credentials, private photos,
DNS change or production load test. `ownerDecision=PENDING`.

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
