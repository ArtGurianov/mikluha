# TOUR-68 — GPT/OPUS review resolution, review.2

2026-10-30. Baseline: PR #62 at `9bba470`. Inputs: owner-provided GPT and
OPUS reviews plus the owner's correction quoting Adman policy section 7.
These are review inputs, not exact-byte OWNER approval or a lawyer's opinion.
Current task scope/status remains in Plane; runtime source is unchanged here.

## Keep from original plan

- Minimal actual SSR/Admin/direct Cloud.ru legal release, independent of future
  sales. Domain cutover and sales remain separate gates.
- Existing OWNER-only version/hash/effective-date publication; actual publication
  date in Moscow, no fabricated effective date or approval.
- Necessary minimal Admin authority/action/publication history may use product
  operation as an upper bound, with earlier purpose-based termination. The
  owner's preference is not replaced by an invented universal N-year rule.
- Existing 30-minute idle / 12-hour absolute session validity and authority
  separation. No blanket customer-retention or bank/fiscal implementation added.

## Adopt from alternative plan

| Item | Tier | Rationale / disposition |
| --- | --- | --- |
| GPT P1: subject/purpose/data/basis mapping | Material improvement | Replaces the common legal-basis paragraph with separate visitors, Admin, approvals, organisers/review subjects, requesters and preserved test-evidence categories. Does not require consent for every network/security operation |
| GPT P1 / OPUS retention: separate account, session, security audit and legal evidence | Critical fix | Product lifetime alone does not justify every old session/credential. Adds separate purpose-end events, proposed quarterly necessity review and documented decisions, restriction/deletion/anonymisation and backup handling; no installed purge is claimed |
| GPT/OPUS: remove public Macrocomunidad speculation | Material improvement | Owner correctly cites §7: storage on servers of both named organisations is stated to be in RF/Novosibirsk. Remove the public foreign-recipient uncertainty paragraph; preserve accurate provider evidence internally |
| OPUS: organiser name/photo/phone and named/image reviews | Critical fix | Components can render these fields, so add their specific publication purpose/data/subject category. Source capability is not proof of current publication or of obtained consent |
| GPT/OPUS image/distribution rights | Material improvement | Distinguishes copyright, image use under Civil Code 152.1 and separate distribution consent under 152-FZ 10.1 where applicable; explicit lawful exceptions require evidence too |
| OPUS response time | Material improvement | State 10 business days plus a reasoned extension up to five for access/information requests. Keep different blocking/correction/distribution/erasure grounds and deadlines separate |
| GPT cookie clarification | Minor enhancement | Server idle expiry can precede browser Max-Age removal; logout sends a clearing cookie. No advertising banner is introduced for the necessary Admin cookie |
| OPUS: remove passport/non-operative and engineering caveats from public policy | Minor enhancement | Removes the passport sentence and phrases such as “not declared anonymous”/“not claimed”. Internal implementation/qualification limits remain in README/evidence |
| OPUS: qualify actual logging, not all-host unknown | Material improvement | Narrow read-only inspection of the running shared proxy and current Mikluha maintenance container; facts below replace generic speculation about owned logs |
| GPT/OPUS: preserved historic evidence can contain real PD | Material improvement | Add separate archive purpose/category and pre-exposure classification. No assumption that test transactions imply synthetic participant identity; no protected archive decrypted or PD printed |

## Reject from alternative plan

- **OPUS automatic cross-border conclusion / binary choice of a blanket no-transfer
  promise or filing a notice.** A foreign organisation's name is not a foreign
  territory. Adman §7 expressly locates the named servers in Russia. Article 3(11)
  concerns transfer to foreign territory; apply Article 12 to an actual planned
  foreign-territory flow, not to a name. No blanket all-provider no-transfer
  promise, unsupported notification or inferred foreign recipient is created.
- **Automatically call every provider an Article 6(3) commissioned processor.**
  Determine the actual operations and applicable contract. Cloud.ru offer 3.2
  distinguishes technological access and a GDPR processor role; its GDPR wording
  does not itself decide the Russian-law role. Candidate explains the hosting/
  storage roles and the required contract terms when processing is commissioned;
  does not invent an accepted account-specific instruction or require paper DPA.
- **Apply 10+5 business days to every request.** Article 20 sets the information/
  access timing; Articles 10.1/20/21 contain different cessation/correction/
  destruction duties. Candidate scopes the explicit number appropriately.
- **Mandatory arbitrary 30/90/365-day or N-year ceiling for all Admin records.**
  Neither cited principle establishes that one number. Keep the owner's upper
  bound for justified minimal history and separately terminate unnecessary data.
  The lack of an operational disposal path is an implementation qualification,
  not something a policy sentence or numerical deadline resolves.
- **Automatically “fix” the repeated ООО.** Preserve the current canonical
  operator name; an EGRUL extract has not been independently retrieved in this
  review. A third-party snippet or stylistic preference is insufficient.

## Conflicts / decisions needed

No exact text was approved by the owner's supplied reviews. Revised policy and
cookie hashes require separate OWNER approval; the old approval request is
superseded. Proposed quarterly review and purpose-end process are included for
review, not represented as already performed.

Before actual corresponding exposure/use, retain the existing narrow acceptance
for applicable RKN notification/exemption, real publication rights/consents (an uploader rights reference alone is not
  proof of Article 10.1 consent),
actual provider account/processing terms, disposal/request/backup procedures,
new DB encrypted off-host backup and isolated restore. No broad hosting
investigation, external-counsel dependency, legacy restore or full sales legal
package has been added. Unanswered provider/consent/archive questions remain
internal qualification items, not public admissions or invented facts.

## Risk delta

Reduced risk: public policy no longer conflates a foreign name with location,
misses organiser/review publication, suggests every request shares a deadline,
or extends product-lifetime storage to every credential/session automatically.

New proposed organisational commitment: quarterly necessity review and recorded
termination decisions. Existing append-only evidence and FK constraints mean
destructive cleanup cannot be inferred from an expired session or a draft.
Any required storage implementation needs a reviewed forward-only design;
this documentation correction introduces no migration or deployed change.

### Narrow live logging evidence

`2026-10-30T13:55:01Z`: read-only SSH to the repository's canonical `adman-vps`,
only `docker ps`, selected `docker inspect` fields, and `nginx -T` for the current
Mikluha container. No log contents, env secrets, request/IP records, keys or their
hashes were output. A second pass selected only a fixed whitelist of Traefik
observability env settings; none were set. Sanitised receipt:
`2026-10-30-tour-68-logging-readonly.json`.

- Running `mikluha-maintenance`: `access_log off`; errors to stderr at `warn`.
- Running `coolify-proxy`, Traefik v3.6: no accesslog/log config or config-file
  arguments; no whitelisted logging/config-file env overrides. With CLI static
  configuration and documented default `accesslog=false`, access logging is
  not enabled. Error/service diagnostics are distinct from access logs.
- Both inspected containers use Docker `json-file`, `max-size=10m`, `max-file=3`.
  This is volume rotation, not a proven days-based age cap or backup deletion.
- No target SSR/Admin container was running in the selected Mikluha scope.
  Source Admin nginx disables access logs but does not suppress all errors.
  Recheck target logging before its exposure; current maintenance facts do not
  qualify an uninstalled deployment. Shared proxy, host and other apps unchanged.

## Revised merged plan

1. Keep TOUR-59 runtime and existing OWNER approval mechanism.
2. Replace the two draft bodies with review.2, recompute SHA256SUMS, retain old
   draft identities in Git and record supersession in Plane/PR.
3. Present exact revised bytes to OWNER without relabelling either reviewer as
   the approving owner or a legal expert.
4. Qualify only the actual Admin/public/archived flows before use; publish via
   the normal versioned mechanism on the approved actual publication date.
5. Domain/sales/host operations retain their independent authorization boundary.

Sources verified 2026-10-30:
[Adman policy §7](https://adman.com/privacy_policy_admancom.pdf),
[Cloud.ru offer 260918 §3.2](https://cloud.ru/documents/contracts/offer/offer-service-provision),
[152-FZ article 3(11)](https://www.consultant.ru/document/cons_doc_LAW_61801/4f41fe599ce341751e4e34dc50a4b676674c1416/),
[article 5](https://www.consultant.ru/document/cons_doc_LAW_61801/96fbc469f91f57235cc842a85e0516a99f23dc85/),
[article 6](https://www.consultant.ru/document/cons_doc_LAW_61801/315f051396c88f1e4f827ba3f2ae313d999a1873/),
[article 10.1](https://www.consultant.ru/document/cons_doc_LAW_61801/591acc70f577873c1ee54765eda110b7a0271eaf/),
[article 18.1](https://www.consultant.ru/document/cons_doc_LAW_61801/eeeebe22bf738fd65bb66b95cc278911ae2525ee/),
[article 20](https://www.consultant.ru/document/cons_doc_LAW_61801/7aeb0acd5aa76dbc888a07e52ca06a92568c6e96/),
[article 21](https://www.consultant.ru/document/cons_doc_LAW_61801/d3fe43a7c415353b17faab255bc0de92bea127da/),
[Civil Code 152.1](https://www.consultant.ru/document/cons_doc_LAW_5142/14c6c3902cffa17ab26d330b2fd4fae28e5cd059/),
[Traefik CLI defaults](https://doc.traefik.io/traefik/reference/install-configuration/cli-options-list/).

CUSTODY_IMPACT: NO — documentation and read-only metadata inspection only.
