# Manual network probe for TOUR-88

Run on the Mac **after manually turning VPN off**. Requires only Python ≥3.9 and
curl; no Docker, SSH or credentials. The probe does not change VPN settings.
Location/network/VPN are the operator's declarations. curl ignores `.curlrc` and
explicit/system HTTP proxy settings; the script cannot prove whether a VPN or
transparent tunnel is active. No client public IP, provider account, cookie,
proxy value or private object is collected.

From the existing checkout:

```sh
cd /Users/artguranov/Documents/Projects/mikluha
python3 poc/regional-media-cache/manual-probe.py \
  --city Кемерово --network home --vpn off --samples 30 \
  --output "$HOME/Documents/TOUR-88/kemerovo-home-no-vpn.json"
```

Use `--network mobile` and a different output filename for a mobile hotspot.
Thirty GETs per each of two WebP plus two reference reads download approximately
20 MB. Every measured request uses a new curl process/TCP/TLS connection;
requests are interleaved. This is exploratory HTTP evidence, not browser LCP or
the full ≥100 samples/key/mode regional acceptance run. Use `--samples 100` for
a larger run once the test endpoint/protocol is ready.

The script records status, byte hash, safe response headers, cumulative curl
DNS/connect/TLS/TTFB/total timing, errors, p50/p75/p95 and declared network metadata.
The JSON is updated after each request and retained on interruption/failure.
A nonzero exit preserves the failed observations; do not discard them and keep
only a successful rerun. Original downloaded image bodies are temporary and
removed at the end.

**Currently the default run measures direct S3 only.** No non-production cache
has been installed on adman-vps. When an actual test cache endpoint and matching
pinned manifest are prepared, add `--cache-base` with the supplied HTTPS
`/processed/` base. The manifest must serve the pinned alias
`<sha256>/source-0-warm.webp` for the thumbnail and `source-1-warm.webp` for the
gallery. The probe checks byte identity and groups actual `X-Cache-Status`
observations. It never assumes that the first request is cold and cannot purge
remote cache entries. A controlled cold-MISS trial needs an independently
prepared cache state. A localhost cache does not measure Kemerovo-to-VPS latency.

Send the resulting JSON, or its summary, in the current chat for analysis.
Do not commit personal network names or unreviewed probe output to the repository.
