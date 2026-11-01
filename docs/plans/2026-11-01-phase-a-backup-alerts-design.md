# Phase A backup review corrections

Use project-owned systemd OnFailure handlers for capture and freshness, reusing the
existing operator Telebuzzy channel. Alternatives are enabling team-wide Coolify
notifications (does not cover these host jobs) or another monitor/scheduler
(unnecessary). No existing monitor or provider permissions are changed.

The sender accepts only known scope/event pairs, reads one root-owned project
credential and status metadata, sends a fixed HTTPS payload with no DB/content,
keys, bucket paths or logs, rejects redirects and bounds response/timeout. Serialize
and deduplicate one failure episode locally, anchored to the latest successful
capture. Send the first alert and then at most one reminder per6hours. A successful
capture resets the episode; failed sends keep their idempotency reference. Keep failed/unknown sends nonzero and
unacknowledged; provider acceptance and independent delivery confirmation are
separate facts. Notify-handler status cannot turn a failed backup into success.

Install drop-ins only for the selected working instances. Prove OnFailure using a
bounded runtime-only inaccessible credential override: real capture must fail
before dump/upload; observe its handler, remove override, recover normal backup
and freshness, and preserve timer state. Do not replace valid provider credentials
or touch another application's monitoring.

Before real content, repeat cloud backup/isolated restore after the real OWNER has
confirmed TOTP. Require at least one decrypted TOTP and attested audit, zero forged
or unverifiable rows. Empty-generation key loading alone is not that proof. Key
bytes must match external custody, Coolify and actual Admin runtime independently.
Keep Phase B content, legal publication, domain and sales closed.
