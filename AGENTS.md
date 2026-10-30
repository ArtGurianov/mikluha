<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Mandatory task tracking — Plane only (2026-10-28)

Agents and developers must use **Plane exclusively** for task tracking.
Workspace: `art-workspace`.
This repository uses project `TOUR` (`c9eea215-c21b-4eae-9b29-7139d9b48baa`).
Plane owns current task scope, planning, dependencies, acceptance evidence,
comments and statuses. Keep architecture in canonical repository contracts.

**Using Linear is prohibited.** Do not use its web UI, connector, API, CLI,
integrations or scripts to read current tasks/statuses or to create, edit,
comment on, transition, archive or delete tasks/projects. Do not mirror work,
post updates or run synchronization/background tracking in Linear. If Plane is
unavailable, report the blocker; do not fall back to Linear.

Old Linear URLs, `ART-…` IDs, task text, repository documents and agent memories
are historical references, not permission to use Linear. Resolve them through
Plane's migrated provenance, mapping Page or saved exports. This rule applies
to all contributors and agents and supersedes older tracker instructions.
It does not assert that Linear access permissions are technically read-only.

Resolve old `ART-…` references through the Plane title and the original Linear
UUID in `external_id` with `external_source=linear`. The workspace Page
`Linear → Plane · permanent ART map` (ID
`2f3c4b6e-4484-449f-bba2-f63e7cc99dd2`) preserves the 324 imported mappings.
Approved Mikluha v5 cards use `external_source=approved-plan` and keys
`mikluha-native-v5:N…`; N labels are plan aliases, not new issue prefixes.
Resolve actual Plane IDs before changing a parent or relation. Use the current
Plane ID in new task references; preserve ART IDs in historical evidence.

Project mapping: Mikluha → TOUR; Flexperiment → FLEX; Refref → REFREF;
shared infrastructure → VPS; the imported task without a project → INBOX.
Flexperiment has not yet been split into the empty LMS/LAB projects.
Source milestones are existing Plane Modules on the Free plan.

Plane can omit archived endpoints from an active issue's relations. For a
dependency audit, include archived work items and read the relation from the
archived endpoint when necessary. Consult the workspace Page
`Linear migration — archived relationship ledger` for the 55 source-CSV
relations omitted by the Linear connector. Do not infer a missing relationship
from a one-sided list; do not treat an archived Done item as unfinished work.
Original relation tables in provenance describe the migration snapshot;
current Plane relations and subsequent approved changes govern today's plan.

A Done/Canceled status, imported comment or tracker move is not a deployment,
provider, recovery, legal-publication or sales-activation receipt. Preserve
explicit CLOSED gates and their independently accepted prerequisites.
Imported comments retain original author identities, including email addresses;
review that provenance before any separately authorized public sharing.

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
credential, encrypted external bundle, or this project's backup tool) and link
VPS-15. Never put plaintext secrets in Git, PRs, Plane or logs.

### OWNER exception — clean-slate Mikluha replacement (2026-10-30)

The owner explicitly approved [clean-slate replacement](docs/decisions/2026-10-30-clean-slate-owner-decision.md)
and weakening the former legacy/custody acceptance. This subsection overrides
conflicting generic infrastructure/old roadmap requirements **for Mikluha only**.

- No migration/import of demo data, Sveltia/legacy checkout compatibility, old DB
  restore/PITR, retained legacy volume, fallback to old static site, or legacy
  recovery qualification is required. Preserve compact existing evidence in
  private infrastructure PR #19 and historical legal/payment/fiscal records.
- Verified obsolete Mikluha-only resources may be hard-deleted under this GO,
  with exact resource/consumer checks and deletion receipts. Shared canary,
  Refref production, Flexperiment, shared proxy/control plane, banking principal
  and others' backups/credentials are not authorized deletion targets.
- Overall VPS drift PASS and whole-host external capture/restore are not gates
  for this replacement. Review changed Mikluha resources and their actual shared
  dependencies, record their authority/post-state, and update affected inventory.
  Keep unrelated REVIEW_REQUIRED/CUSTODY_PENDING findings visible but non-blocking;
  never label overall drift PASS or complete recovery without actual evidence.
- New DB: automatic encrypted/off-host logical backup and one successful isolated
  restore before real Admin/content/legal data entry. Full PITR and independent
  external custody-device qualification are deferred to before real sales; owner
  accepts the possible loss of edits between scheduled dumps.
- Only target-architecture tests are required; remove legacy payment endpoints
  rather than implement compatibility. Maintenance page is the temporary public
  state. Actual-flow public/Admin privacy and versioned legal publication remain.
- Sales remain CLOSED; this exception authorizes no real bank operation or sales
  activation. Other projects' contracts are unchanged.
