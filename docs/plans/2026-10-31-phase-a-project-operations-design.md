# Phase A project operations and custody

Phase A deployment and backup tooling belongs to Mikluha. The shared VPS repository
keeps the host resource index and links to project-owned contracts.

- This repository owns portable Compose definitions, pinned images, the backup and
  restore programs, failure tests and operating instructions. No per-installation
  credential, private key, actual IAM principal or owner approval provenance is
  included, including encrypted copies of credentials.
- Coolify owns runtime application environments. An operator-held age-encrypted
  bundle outside Git owns the matching recovery generation, provider credentials
  and private installation receipts. Decrypt keys remain outside Git and VPS.
- Git Compose uses the existing public Mikluha source. A generic definition uses
  required environment placeholders for installation identity and secrets. No new
  deploy key or expanded GitHub App access is required.
- The controller Git commit and baked application source are distinct pins. The
  already qualified image bundle remains pinned to its source; this source move
  creates no new registry publication or deployment.
- Real releases use an external installation descriptor. Checked-in candidate
  values are deliberately incomplete and cannot authorize an installation.

Retain the existing namespace, origin restrictions, resource limits, version-aware
Cloud.ru restore, role/ACL and Admin crypto checks. Migration changes ownership,
not the accepted backup topology: hourly VPS-to-Cloud.ru, provider lifecycle7d
current/noncurrent, manual isolated restore, no scheduled Mac replica.

Validation: offline Python failure contracts, generated Compose parity, explicit
local Docker policy outside Git, and real isolated image/PG/age restore. Hosted
source CI and real provider/runtime admission remain separate evidence.

CUSTODY_IMPACT: NO for this undeployed source. Actual enrolled resources and custody
authority changes are recorded in the private host resource index and operator
bundle. Merge, controller update, install, legal publication and sales have their
own authorization; maintenance remains the public state.
