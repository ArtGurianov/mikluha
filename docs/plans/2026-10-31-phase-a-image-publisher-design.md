# Phase A: publish images without deploying

TOUR-67 needs registry digests for site, Commerce, Admin UI, media worker and
decoder. The existing site release workflow publishes and deploys one image in
the same operation. Reusing it would change a Coolify Docker Image application,
whereas the accepted Phase A plan uses private Raw Compose resources.

`CUSTODY_IMPACT: NO` — source preparation only; no workflow dispatch, registry
publication, new credentials, VPS or Coolify changes in this PR.

Add one manually dispatched main-only build workflow. A fixed five-image matrix
uses the existing Dockerfiles/targets and one exact checkout commit. No deploy
job, Coolify credential, SSH access or provider credential is available to it.
Only the build jobs receive packages:write for their existing GHCR repositories.
The existing deployment workflow remains unchanged.

Before publishing, require the live-legal source/approved file hashes and the
Phase A runbook in the chosen main checkout. Public build inputs are environment
and HTTPS site origin only; no production data or runtime secret enters build.
Use linux/amd64, single-platform manifests without an attestation index. Source
tags are informational: all subsequent checks and deployment references use
registry digests.

After each push, pull that exact digest from GHCR, inspect its actual platform,
RepoDigests and expected role command, and copy its baked identity from a stopped
networkless container. No application process starts for this identity check.
Site must carry schema2 with Commerce legal authority; worker/decoder retain the
Commerce identity but have distinct expected commands. An aggregate artifact is
emitted only after all five role receipts pass and agree on source/run/build
inputs. Partial pushes never produce an accepted release bundle.

The bundle is evidence of published image identity, not runtime, DB/schema/ACL,
provider, backup/restore or installation admission. The infrastructure candidate
continues to need its independently qualified fields. Merges, registry publication
and VPS installation remain separate steps under their existing authority rules.

Tests cover wrong repository/digest/commit/platform/command/identity, missing or
duplicate roles, mixed runs/build inputs and hostile input strings. Workflow
syntax is checked with actionlint. A real GHCR run is required after the workflow
and legal/runbook changes reach main; synthetic tests never supply fake qualified
digests. A new custom image registry or local build service is unnecessary.
