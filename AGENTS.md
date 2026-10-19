<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Infrastructure custody (shared Adman VPS)

This project runs on the shared Adman VPS. Host baseline, encrypted custody and
recovery are owned by `ArtGurianov/adman-vps-infrastructure`; its
[`AGENTS.md`](https://github.com/ArtGurianov/adman-vps-infrastructure/blob/main/AGENTS.md)
is the canonical contract.

Every PR that deploys or changes host state states `CUSTODY_IMPACT: YES|NO`
with a one-line reason. YES covers new or changed credentials and encryption
keys, env files on the host, Docker networks, proxy routes, systemd units,
installers, backup paths, and persistent state that needs a key to restore.
Code that is not yet deployed is NO.

For YES, list each changed resource and its authority (Coolify env, SOPS host
credential, encrypted external bundle, or this project's backup tool) and open
or link an issue in the infrastructure project. Until that repository's drift
check is clean and a fresh capture exists, report `CUSTODY_PENDING`. A
successful deployment is not custody evidence. Never put plaintext secrets in
Git, PRs, Linear or logs, and never rotate keys or change the host without
explicit owner authorization.
