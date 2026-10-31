# Phase A image publication

TOUR-67 / VPS-19 requires five actual GHCR image digests from qualified `main`.
The manually dispatched `.github/workflows/phase-a-images.yml` builds/publishes
all five existing Docker targets and verifies each exact pulled registry digest.
It does not contact Coolify, SSH, Cloud.ru or a running application.

`CUSTODY_IMPACT: NO` for this source-only PR. No credentials, workflow environment,
VPS path or provider resource is provisioned. A future dispatch writes GHCR
packages, not infrastructure runtime. Existing deployment workflows are unchanged.

## Before dispatch

Use the [Phase A operational runbook](2026-10-30-ssr-admin-operational-acceptance.md).
Its separately authorized legal/runbook merges must reach main before choosing
the release commit. The publisher fails if approved legal files or the live
Commerce legal source contract are missing/changed. It does not infer OWNER
approval or a successful complete application CI from file presence.

After this workflow itself is reviewed/merged and publication is authorized,
dispatch `phase-a-images.yml` on `main`, with `deploy_env=staging` for the private
acceptance build and an explicitly selected HTTPS `site_url`. That origin is
baked configuration; dispatch does not create DNS, a certificate or public route.
The run uses its exact `github.sha`, even if main moves later.

Five fixed roles use the existing targets:

| Role | Repository suffix | Docker target |
| --- | --- | --- |
| site | mikluha-site-ssr | root Dockerfile / runtime |
| commerce | mikluha-commerce | commerce/Dockerfile / service |
| admin | mikluha-control-room | control-room/Dockerfile / runtime |
| worker | mikluha-media-worker | commerce/Dockerfile / media-worker |
| decoder | mikluha-media-decoder | commerce/Dockerfile / media-decoder |

Only publish jobs have `packages:write`; no runtime credentials enter the build.
Build tags include source commit, workflow run and attempt. They are not release
identity: deploy by the verified `repository@sha256:…` values from the bundle.
Single-platform linux/amd64 images have provenance/SBOM index generation disabled,
matching the infrastructure single-manifest digest contract. No cryptographically
independent provenance attestation is claimed.

## Outputs and failure behavior

Each job pulls its pushed digest and inspects actual RepoDigests, platform and
role command, then copies the built identity file from its own stopped networkless
container. The container never starts an application and is removed on completion
or failure. Site identity must declare schema2/Commerce legal authority. Worker
and decoder share the Commerce identity schema but need their own expected command.

The final `phase-a-image-bundle-<commit>-<attempt>` artifact exists only when all
five receipts agree on commit, public build inputs, run and attempt. Its images
are inputs to the private infrastructure release candidate, not a complete release
descriptor. Preserve the qualified bundle in the private execution evidence
before the Actions artifact retention (90 days) expires. Individual diagnostic
receipts retain30 days. Source code tests do not supply invented qualified digests.

A partial run can leave published images and individual receipts. It has no
accepted aggregate bundle and cannot be used as an installed release. A rerun
gets a distinct attempt tag; do not assemble different runs or silently substitute
one image from another commit. Build bases remain those of the existing Dockerfiles;
same-source rebuilds can have different digests. The bundle pins the actual images,
without claiming bit-for-bit reproducible builds.

Use `python3 scripts/test-phase-a-images.py -v` and
`actionlint .github/workflows/phase-a-images.yml` for source validation. Real GHCR
publication, running application smoke, database/schema/ACL/key qualification,
new-DB cloud backup/isolated restore and OWNER installation authorization remain
separate evidence. Legal publication, domains and sales stay behind their gates.

References: [GitHub publishing images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images),
[Docker build action outputs](https://github.com/docker/build-push-action#outputs).
