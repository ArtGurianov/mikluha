# Coolify Docker Image by digest — PoC (ART-360 §1)

A synthetic image whose only route is `GET /identity` → `{"service":"mikluha-digest-poc","commit":…}`.
No secrets, volumes, database or production domain. It exists to answer one question before any real
application moves: does Coolify 4.4.6 store and run exactly the registry digest a release chooses?

## Owner setup (once)

1. Coolify: project `digest-poc`, environment `test`, a **Docker Image** application named exactly
   `mikluha-digest-poc`, port 3000, a non-production domain, auto-deploy off, CPU/RAM limits. Its
   image: `ghcr.io/artgurianov/mikluha-digest-poc`.
2. Two Coolify API tokens: one with read + write (PATCH and read-backs), one deploy-only.
3. GitHub, Mikluha, environment `digest-poc` limited to `main`: secrets `COOLIFY_BASE_URL`,
   `COOLIFY_POC_WRITE_TOKEN`, `COOLIFY_POC_DEPLOY_TOKEN`; variables `COOLIFY_POC_APP_UUID`,
   `POC_IDENTITY_URL` (`https://<poc domain>/identity`).
4. After the first build, make the GHCR package `mikluha-digest-poc` public (it holds nothing
   secret) or give Coolify a pull credential for it.

## Run

`coolify-digest-poc` workflow, three dispatches: A (build), B (build from a later commit), restore A
(inputs `digest` and `commit` from A's summary, no build). After each:

```bash
ssh adman-vps 'bash -s -- <app-uuid> sha256:<hex>' < poc/coolify-digest/verify-running-digest.sh
```

GO only if all three pass both read-backs: Coolify's stored tag and a finished deployment with
`/identity` = the chosen commit in the workflow, and the running container's RepoDigests containing
`ghcr.io/artgurianov/mikluha-digest-poc@<digest>` on the VPS. Anything else is NO-GO; record which
step failed. Delete the application and the package when the result is recorded.
