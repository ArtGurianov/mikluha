-- Track A / A2b-3a for TOUR-79: purchase amendments (docs/plans/2026-11-07-a2b-3-purchase-amendments-contract.md,
-- OWNER decisions Q2–Q6 and Q5+ of 07.11.2026 in docs/decisions/2026-11-07-owner-decisions-a2b-3-amendments.md).
--
-- Forward-only after 0026; 0001–0026 keep their bytes. The transfer (DEPARTURE_TRANSFER, purpose AMENDMENT) is 0028.
--
--   * a closed list of bases: TICKET_TYPE_CORRECTION and PARTICIPANT_REPLACEMENT (buyer's consent to the candidate
--     hash the database recomputes), PARTIAL_CANCELLATION and FULL_TERMINATION (recorded by staff, effective at
--     once); proposal → consent → atomic revision with CAS on the current revision; refusals that change state
--     (STALE, EXPIRED) are returned as values and kept (§2.4);
--   * an amendment revision has no document order: its lines cover every seat with a status ACTIVE / CANCELLED /
--     SETTLED derived from the seat; only ACTIVE lines count (§2.3). The debt deadlines are frozen per revision;
--   * money: a seat's money is held in lots per source collection; overpayment moves between active seats of the
--     purchase keeping its source; cancelled seats' money is never offset (Q3), it goes to a lot-based settlement
--     case executed by refunds through the source collection and OWNER retentions; three refund limits; a
--     contradicted refund opens REFUND_CONTRADICTED with the bank fact and freezes the money until its split is
--     resolved by exact equalities (§5.1, §5.3, §5.5, I-10, I-21, I-22);
--   * a role change of a seat (18+ ↔ minor) and a replacement revoke the companion's access explicitly (§4.2);
--   * no new payment while an amendment is consented and pending or a contradiction freezes the money (§5.7).

-- ---------------------------------------------------------------------------------------------
-- 1. Revisions without a document order, line status, frozen debt deadlines.

ALTER TABLE purchase_revision ALTER COLUMN document_order_id DROP NOT NULL,
  ADD COLUMN amendment_id uuid UNIQUE,
  ADD COLUMN candidate_hash text CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN deposit_until timestamptz,
  ADD COLUMN balance_due_at timestamptz;
ALTER TABLE purchase_revision DROP CONSTRAINT purchase_revision_basis_check,
  ADD CONSTRAINT purchase_revision_basis_check CHECK (basis IN ('INITIAL', 'QUOTE_REPLACEMENT', 'TICKET_TYPE_CORRECTION',
    'PARTICIPANT_REPLACEMENT', 'PARTIAL_CANCELLATION', 'FULL_TERMINATION')),
  ADD CONSTRAINT purchase_revision_source CHECK ((basis IN ('INITIAL', 'QUOTE_REPLACEMENT')) = (document_order_id IS NOT NULL)
    AND (document_order_id IS NULL) = (amendment_id IS NOT NULL) AND (amendment_id IS NULL) = (candidate_hash IS NULL)),
  DROP CONSTRAINT purchase_revision_seats_check,
  ADD CONSTRAINT purchase_revision_seats_check CHECK (seats BETWEEN 0 AND 500 AND (seats > 0 OR basis = 'FULL_TERMINATION')),
  DROP CONSTRAINT purchase_revision_total_positive,
  ADD CONSTRAINT purchase_revision_total_positive CHECK (total_kopecks > 0 OR (basis = 'FULL_TERMINATION' AND total_kopecks = 0));

ALTER TABLE purchase_revision_line ADD COLUMN line_status text CHECK (line_status IN ('ACTIVE', 'CANCELLED', 'SETTLED'));

-- A line's status: explicit on amendment lines; lines before 0027 (and INITIAL lines) read it from the seat.
CREATE FUNCTION fn_line_status(p_line_status text, p_seat_state text) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(p_line_status, CASE p_seat_state WHEN 'CANCELLED' THEN 'CANCELLED' WHEN 'REFUND_SETTLED' THEN 'SETTLED' ELSE 'ACTIVE' END)
$fn$ LANGUAGE sql;

-- Same digest as 0021 for lines without a status (their hashes recompute unchanged); amendment lines add it.
CREATE OR REPLACE FUNCTION fn_purchase_lines_sha256(p_purchase uuid, p_revision int) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(s.seat_slot_ref, l.ticket_type,
           l.price_kopecks, b.pricing_basis_ref) || CASE WHEN l.line_status IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(l.line_status) END
           ORDER BY s.position), '[]'::jsonb)::text, 'UTF8')), 'hex')
    FROM purchase_revision_line l JOIN seat_slot s ON s.id = l.seat_slot_id JOIN pricing_basis b ON b.id = l.pricing_basis_id
   WHERE l.purchase_id = p_purchase AND l.revision = p_revision
$fn$ LANGUAGE sql;

-- Same JSON as 0021 for document-order revisions; an amendment revision also commits to its amendment, the
-- candidate the buyer consented to and its frozen deadlines.
CREATE OR REPLACE FUNCTION fn_purchase_revision_hash(p_purchase_ref text, r purchase_revision) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to((jsonb_build_object(
    'purchaseRef', p_purchase_ref, 'revision', r.revision, 'basis', r.basis, 'predecessor', r.predecessor_hash,
    'documentOrderId', r.document_order_id,
    'departureId', r.departure_id, 'departureVersion', r.departure_version, 'seats', r.seats,
    'unitPriceKopecks', r.unit_price_kopecks, 'totalKopecks', r.total_kopecks, 'participants', to_jsonb(r.participant_refs),
    'contractSnapshotSha256', r.contract_snapshot_sha256,
    'legalRelease', jsonb_build_object('ref', r.legal_release_ref, 'hash', r.legal_release_hash),
    'pdConsent', jsonb_build_object('ref', r.pd_consent_ref, 'hash', r.pd_consent_hash),
    'acceptedAt', to_char(r.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effectiveAt', to_char(r.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
    || CASE WHEN r.slot_model = 'PRICED_SLOTS'
            THEN jsonb_build_object('slotModel', r.slot_model, 'linesSha256', r.lines_sha256) ELSE '{}'::jsonb END
    || CASE WHEN r.amendment_id IS NOT NULL
            THEN jsonb_build_object('amendmentId', r.amendment_id, 'candidateHash', r.candidate_hash,
                   'depositUntil', to_char(r.deposit_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                   'balanceDueAt', to_char(r.balance_due_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
            ELSE '{}'::jsonb END)::text,
    'UTF8')), 'hex')
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_departure_planned_start(p_departure uuid) RETURNS timestamptz
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (d.starts_on + d.departure_time::time) AT TIME ZONE d.timezone FROM departure d WHERE d.id = p_departure
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_departure_planned_end(p_departure uuid) RETURNS timestamptz
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (d.ends_on + d.return_time::time) AT TIME ZONE d.timezone FROM departure d WHERE d.id = p_departure
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- 2. Amendments: the proposal, its candidate lines, the buyer's consent.

CREATE TABLE purchase_amendment (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  amendment_ref         text NOT NULL UNIQUE CHECK (amendment_ref ~ '^am-[0-9a-f]{20}$'),
  purchase_id           uuid NOT NULL REFERENCES purchase(id),
  basis                 text NOT NULL CHECK (basis IN ('TICKET_TYPE_CORRECTION', 'PARTICIPANT_REPLACEMENT', 'PARTIAL_CANCELLATION',
                                                       'FULL_TERMINATION')),
  base_revision         int  NOT NULL,
  base_revision_hash    text NOT NULL,
  candidate             jsonb NOT NULL,
  candidate_hash        text NOT NULL CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  consent_mode          text NOT NULL CHECK (consent_mode IN ('BUYER_HASH', 'STAFF_RECORDED')),
  initiated_by_admin    uuid NOT NULL REFERENCES admin_user(id),
  initiated_by          text NOT NULL CHECK (length(initiated_by) BETWEEN 1 AND 120),
  reason                text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  -- The buyer's request (letter or call number), no personal data.
  request_evidence_ref  text CHECK (request_evidence_ref ~ '^[A-Za-z0-9_.:/#-]{1,200}$'),
  termination_initiator text CHECK (termination_initiator IN ('BUYER', 'ORGANIZER')),
  -- The one-time consent link sent to the buyer's address; only its hash.
  link_token_sha256     text UNIQUE CHECK (link_token_sha256 ~ '^[0-9a-f]{64}$'),
  idempotency_key       text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  request_sha256        text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at            timestamptz,
  state                 text NOT NULL CHECK (state IN ('OPEN', 'COMMITTED', 'CLOSED')),
  closed_reason         text CHECK (closed_reason IN ('REJECTED', 'WITHDRAWN', 'EXPIRED', 'STALE')),
  closed_at             timestamptz,
  closed_by             text CHECK (length(closed_by) BETWEEN 1 AND 120),
  committed_revision    int,
  committed_at          timestamptz,
  committed_xact_id     xid8,
  UNIQUE (purchase_id, idempotency_key),
  FOREIGN KEY (purchase_id, base_revision) REFERENCES purchase_revision(purchase_id, revision),
  -- Q2: every category change needs the buyer's consent; a replacement too; cancellations are recorded.
  CHECK ((basis IN ('TICKET_TYPE_CORRECTION', 'PARTICIPANT_REPLACEMENT')) = (consent_mode = 'BUYER_HASH')),
  CHECK ((consent_mode = 'BUYER_HASH') = (expires_at IS NOT NULL)),
  CHECK (consent_mode = 'BUYER_HASH' OR link_token_sha256 IS NULL),
  CHECK ((basis IN ('PARTIAL_CANCELLATION', 'FULL_TERMINATION')) = (termination_initiator IS NOT NULL)),
  CHECK (termination_initiator IS DISTINCT FROM 'BUYER' OR request_evidence_ref IS NOT NULL),
  CHECK ((state = 'CLOSED') = (closed_reason IS NOT NULL) AND (state = 'CLOSED') = (closed_at IS NOT NULL)
         AND (state = 'CLOSED') = (closed_by IS NOT NULL)),
  CHECK ((state = 'COMMITTED') = (committed_revision IS NOT NULL) AND (state = 'COMMITTED') = (committed_at IS NOT NULL)
         AND (state = 'COMMITTED') = (committed_xact_id IS NOT NULL))
);
-- One open staff amendment per purchase (I-12).
CREATE UNIQUE INDEX purchase_amendment_open ON purchase_amendment (purchase_id) WHERE state = 'OPEN';
ALTER TABLE purchase_revision ADD CONSTRAINT purchase_revision_amendment FOREIGN KEY (amendment_id) REFERENCES purchase_amendment(id);

-- The candidate: a line for every seat of the purchase, as the revision will hold it.
CREATE TABLE purchase_amendment_line (
  amendment_id     uuid NOT NULL REFERENCES purchase_amendment(id),
  seat_slot_id     uuid NOT NULL REFERENCES seat_slot(id),
  ticket_type      text NOT NULL CHECK (ticket_type IN ('AGE_0_13', 'AGE_14_17', 'AGE_18_PLUS')),
  pricing_basis_id uuid NOT NULL REFERENCES pricing_basis(id),
  price_kopecks    bigint NOT NULL CHECK (price_kopecks > 0),
  line_status      text NOT NULL CHECK (line_status IN ('ACTIVE', 'CANCELLED', 'SETTLED')),
  ends_participant boolean NOT NULL DEFAULT false,
  PRIMARY KEY (amendment_id, seat_slot_id)
);

CREATE TABLE purchase_amendment_consent (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consent_ref    text NOT NULL UNIQUE CHECK (consent_ref ~ '^ac-[0-9a-f]{20}$'),
  amendment_id   uuid NOT NULL UNIQUE REFERENCES purchase_amendment(id),
  candidate_hash text NOT NULL CHECK (candidate_hash ~ '^sha256:[0-9a-f]{64}$'),
  channel        text NOT NULL CHECK (channel IN ('BUYER_SESSION', 'AMENDMENT_LINK')),
  consented_at   timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Identity and candidate are fixed; the state leaves OPEN once, to COMMITTED or CLOSED; nothing is deleted.
CREATE FUNCTION fn_purchase_amendment_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'AMENDMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'OPEN' THEN RAISE EXCEPTION 'AMENDMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.amendment_ref, NEW.purchase_id, NEW.basis, NEW.base_revision, NEW.base_revision_hash, NEW.candidate,
         NEW.candidate_hash, NEW.consent_mode, NEW.initiated_by_admin, NEW.initiated_by, NEW.reason, NEW.request_evidence_ref,
         NEW.termination_initiator, NEW.link_token_sha256, NEW.idempotency_key, NEW.request_sha256, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.amendment_ref, OLD.purchase_id, OLD.basis, OLD.base_revision, OLD.base_revision_hash, OLD.candidate,
         OLD.candidate_hash, OLD.consent_mode, OLD.initiated_by_admin, OLD.initiated_by, OLD.reason, OLD.request_evidence_ref,
         OLD.termination_initiator, OLD.link_token_sha256, OLD.idempotency_key, OLD.request_sha256, OLD.created_at, OLD.expires_at)
     OR OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'AMENDMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state = 'COMMITTED' AND (NEW.committed_revision IS DISTINCT FROM (SELECT current_revision FROM purchase WHERE id = NEW.purchase_id)
       OR NOT EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = NEW.purchase_id AND revision = NEW.committed_revision
                        AND amendment_id = NEW.id)) THEN
    RAISE EXCEPTION 'AMENDMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_amendment_guard BEFORE INSERT OR UPDATE OR DELETE ON purchase_amendment
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_amendment_guard();
CREATE TRIGGER trg_purchase_amendment_no_truncate BEFORE TRUNCATE ON purchase_amendment
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_amendment_line_immutable BEFORE UPDATE OR DELETE ON purchase_amendment_line
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_amendment_line_no_truncate BEFORE TRUNCATE ON purchase_amendment_line
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_amendment_consent_immutable BEFORE UPDATE OR DELETE ON purchase_amendment_consent
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_amendment_consent_no_truncate BEFORE TRUNCATE ON purchase_amendment_consent
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- Candidate lines are written with their amendment, in the transaction that creates it.
CREATE FUNCTION fn_purchase_amendment_line_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_amendment a JOIN seat_slot s ON s.purchase_id = a.purchase_id
                  WHERE a.id = NEW.amendment_id AND s.id = NEW.seat_slot_id AND a.state = 'OPEN'
                    AND a.xmin = pg_current_xact_id()::xid) THEN
    RAISE EXCEPTION 'AMENDMENT_LINE_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_amendment_line_on_insert BEFORE INSERT ON purchase_amendment_line
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_amendment_line_on_insert();

-- ---------------------------------------------------------------------------------------------
-- 3. Revisions: the document-order path of 0017/0021 unchanged; the amendment path appends the revision its
--    open amendment describes, on the base revision it was proposed on (CAS), with the predecessor's terms.

CREATE OR REPLACE FUNCTION fn_purchase_revision_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE p purchase%ROWTYPE; o orders%ROWTYPE; prev purchase_revision%ROWTYPE; refusal text; a purchase_amendment%ROWTYPE;
BEGIN
  SELECT * INTO p FROM purchase WHERE id = NEW.purchase_id FOR UPDATE;
  SELECT * INTO prev FROM purchase_revision WHERE purchase_id = NEW.purchase_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(prev.revision, 0) + 1 THEN RAISE EXCEPTION 'PURCHASE_REVISION_SEQUENCE' USING ERRCODE = '55000'; END IF;
  IF NEW.basis IN ('INITIAL', 'QUOTE_REPLACEMENT') THEN
    IF NEW.revision = 1 AND NEW.document_order_id <> p.origin_order_id THEN
      RAISE EXCEPTION 'PURCHASE_REVISION_DOCUMENT_MISMATCH' USING ERRCODE = '55000';
    END IF;
    refusal := fn_purchase_document_order_fresh(NEW.document_order_id);
    IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
    SELECT * INTO o FROM orders WHERE id = NEW.document_order_id;
    IF NEW.basis = 'QUOTE_REPLACEMENT' AND (o.replaces_order_id IS DISTINCT FROM prev.document_order_id
       OR (SELECT status FROM orders WHERE id = prev.document_order_id) <> 'CANCELLED'
       OR o.departure_id IS DISTINCT FROM prev.departure_id) THEN
      RAISE EXCEPTION 'PURCHASE_REPLACEMENT_INVALID' USING ERRCODE = '55000';
    END IF;
    IF ROW(NEW.departure_id, NEW.departure_version, NEW.seats, NEW.unit_price_kopecks, NEW.contract_snapshot_sha256,
           NEW.legal_release_ref, NEW.legal_release_hash, NEW.pd_consent_ref, NEW.pd_consent_hash, NEW.accepted_at)
       IS DISTINCT FROM
       ROW(o.departure_id, o.accepted_departure_version, o.seats, o.unit_price_kopecks, o.contract_snapshot_sha256,
           o.legal_release_ref, o.legal_release_hash, o.pd_consent_ref, o.pd_consent_hash, o.pd_consent_accepted_at) THEN
      RAISE EXCEPTION 'PURCHASE_REVISION_DOCUMENT_MISMATCH' USING ERRCODE = '55000';
    END IF;
    -- The debt schedule accepted with the purchase (v1.8.2 §7.1): not moved by later schedule edits.
    NEW.deposit_until := fn_departure_deposit_cutoff(NEW.departure_id);
    NEW.balance_due_at := fn_departure_cutoff(NEW.departure_id);
  ELSE
    SELECT * INTO a FROM purchase_amendment WHERE id = NEW.amendment_id;
    IF NOT FOUND OR a.purchase_id <> NEW.purchase_id OR a.basis <> NEW.basis OR a.state <> 'OPEN'
       OR a.base_revision <> prev.revision OR a.base_revision_hash <> prev.revision_hash OR prev.slot_model <> 'PRICED_SLOTS'
       OR NEW.candidate_hash IS DISTINCT FROM a.candidate_hash
       OR ROW(NEW.departure_id, NEW.departure_version, NEW.unit_price_kopecks, NEW.contract_snapshot_sha256, NEW.legal_release_ref,
              NEW.legal_release_hash, NEW.pd_consent_ref, NEW.pd_consent_hash)
          IS DISTINCT FROM ROW(prev.departure_id, prev.departure_version, prev.unit_price_kopecks, prev.contract_snapshot_sha256,
              prev.legal_release_ref, prev.legal_release_hash, prev.pd_consent_ref, prev.pd_consent_hash)
       OR (a.consent_mode = 'BUYER_HASH' AND NOT EXISTS (SELECT 1 FROM purchase_amendment_consent c
                                                          WHERE c.amendment_id = a.id AND c.candidate_hash = a.candidate_hash)) THEN
      RAISE EXCEPTION 'PURCHASE_REVISION_AMENDMENT_INVALID' USING ERRCODE = '55000';
    END IF;
    -- An amendment of 0027 keeps the debt schedule of its predecessor (I-16).
    NEW.deposit_until := coalesce(prev.deposit_until, fn_departure_deposit_cutoff(prev.departure_id));
    NEW.balance_due_at := coalesce(prev.balance_due_at, fn_departure_cutoff(prev.departure_id));
  END IF;
  NEW.recorded_at := clock_timestamp();
  NEW.predecessor_hash := prev.revision_hash;
  NEW.revision_hash := fn_purchase_revision_hash(p.purchase_ref, NEW);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_purchase_revision_slot_model() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF (NEW.document_order_id IS NULL AND NEW.slot_model <> 'PRICED_SLOTS')
     OR (NEW.document_order_id IS NOT NULL AND (NEW.slot_model IS DISTINCT FROM (SELECT seat_model FROM orders WHERE id = NEW.document_order_id)
           OR (NEW.slot_model = 'PRICED_SLOTS' AND NEW.basis <> 'INITIAL'))) THEN
    RAISE EXCEPTION 'PURCHASE_REVISION_DOCUMENT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- A line of the first revision as in 0021; a line of an amendment revision is its candidate line.
CREATE OR REPLACE FUNCTION fn_purchase_line_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = NEW.purchase_id AND revision = NEW.revision) THEN
    RAISE EXCEPTION 'PURCHASE_LINE_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.line_status IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM seat_slot WHERE id = NEW.seat_slot_id AND purchase_id = NEW.purchase_id
                     AND pricing_basis_id = NEW.pricing_basis_id)
       OR NEW.price_kopecks IS DISTINCT FROM fn_pricing_basis_price(NEW.pricing_basis_id, NEW.ticket_type)
       OR NOT fn_purchase_in_creation(NEW.purchase_id) THEN
      RAISE EXCEPTION 'PURCHASE_LINE_INVALID' USING ERRCODE = '55000';
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM purchase_amendment a JOIN purchase_amendment_line x ON x.amendment_id = a.id
                     WHERE a.purchase_id = NEW.purchase_id AND a.state = 'OPEN' AND a.base_revision + 1 = NEW.revision
                       AND x.seat_slot_id = NEW.seat_slot_id AND x.ticket_type = NEW.ticket_type
                       AND x.pricing_basis_id = NEW.pricing_basis_id AND x.price_kopecks = NEW.price_kopecks
                       AND x.line_status = NEW.line_status) THEN
    RAISE EXCEPTION 'PURCHASE_LINE_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- 0021's completeness, with lines over every seat of the purchase: seats and total count ACTIVE lines only;
-- an amendment revision holds exactly its candidate lines. A deferred check runs at COMMIT as the session's
-- login: definer rights, so an amendment committed by the Admin API's login is checked like any other.
CREATE OR REPLACE FUNCTION fn_purchase_complete() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid; r purchase_revision%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'purchase' THEN v_purchase := NEW.id; ELSE v_purchase := NEW.purchase_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = v_purchase AND revision = 1)
     OR (SELECT current_revision FROM purchase WHERE id = v_purchase)
        IS DISTINCT FROM (SELECT max(revision) FROM purchase_revision WHERE purchase_id = v_purchase)
     OR (SELECT count(*) FROM purchase_revision WHERE purchase_id = v_purchase)
        <> (SELECT max(revision) FROM purchase_revision WHERE purchase_id = v_purchase) THEN
    RAISE EXCEPTION 'PURCHASE_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  FOR r IN SELECT * FROM purchase_revision WHERE purchase_id = v_purchase LOOP
    IF r.slot_model = 'UNIFORM' THEN
      IF (SELECT count(*) FROM purchase_revision_participant x WHERE x.purchase_id = r.purchase_id AND x.revision = r.revision) <> r.seats
         OR EXISTS (SELECT 1 FROM seat_slot WHERE purchase_id = v_purchase) THEN
        RAISE EXCEPTION 'PURCHASE_INCOMPLETE' USING ERRCODE = '55000';
      END IF;
    ELSIF (SELECT count(*) FROM purchase_revision_line l WHERE l.purchase_id = r.purchase_id AND l.revision = r.revision)
          <> (SELECT count(*) FROM seat_slot WHERE purchase_id = v_purchase)
       OR (SELECT count(*) FROM purchase_revision_line l WHERE l.purchase_id = r.purchase_id AND l.revision = r.revision
             AND coalesce(l.line_status, 'ACTIVE') = 'ACTIVE') <> r.seats
       OR (SELECT coalesce(sum(price_kopecks), 0) FROM purchase_revision_line l WHERE l.purchase_id = r.purchase_id
             AND l.revision = r.revision AND coalesce(l.line_status, 'ACTIVE') = 'ACTIVE') IS DISTINCT FROM r.total_kopecks
       OR fn_purchase_lines_sha256(r.purchase_id, r.revision) IS DISTINCT FROM r.lines_sha256
       OR (r.amendment_id IS NOT NULL AND EXISTS (
             (SELECT seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status FROM purchase_revision_line
               WHERE purchase_id = r.purchase_id AND revision = r.revision
              EXCEPT SELECT seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status FROM purchase_amendment_line
               WHERE amendment_id = r.amendment_id)
             UNION ALL
             (SELECT seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status FROM purchase_amendment_line
               WHERE amendment_id = r.amendment_id
              EXCEPT SELECT seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status FROM purchase_revision_line
               WHERE purchase_id = r.purchase_id AND revision = r.revision)))
       OR NOT EXISTS (SELECT 1 FROM purchase_group_member WHERE purchase_id = v_purchase) THEN
      RAISE EXCEPTION 'PURCHASE_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

-- 0021's seat transitions; CONFIRMED → CANCELLED only by the cancellation revision its amendment committed in
-- this very transaction, for a line it cancels (§3.1). A transfer cancels nothing.
CREATE OR REPLACE FUNCTION fn_seat_slot_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE h seat_hold%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.id, NEW.seat_slot_ref, NEW.purchase_id, NEW.position, NEW.pricing_basis_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.seat_slot_ref, OLD.purchase_id, OLD.position, OLD.pricing_basis_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT * INTO h FROM seat_hold WHERE purchase_id = NEW.purchase_id ORDER BY cycle DESC LIMIT 1;
    IF ((OLD.state = 'HELD' AND NEW.state = 'CONFIRMED' AND h.outcome = 'PAID')
         OR (OLD.state = 'HELD' AND NEW.state = 'RELEASED' AND h.outcome IN ('PAYMENT_FAILED', 'LAPSED'))
         OR (OLD.state = 'RELEASED' AND NEW.state = 'HELD' AND h.closed_at IS NULL AND h.fenced_at IS NULL
             AND h.expires_at > clock_timestamp())
         OR (OLD.state = 'RELEASED' AND NEW.state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION') AND h.closed_at IS NOT NULL)
         OR (OLD.state = 'PAID_NO_SEAT_EXCEPTION' AND NEW.state IN ('CONFIRMED', 'REFUND_SETTLED'))
         OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED' AND EXISTS (
               SELECT 1 FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
                 JOIN purchase_amendment a ON a.id = r.amendment_id
                 JOIN purchase_revision_line l ON l.purchase_id = r.purchase_id AND l.revision = r.revision AND l.seat_slot_id = NEW.id
                WHERE p.id = NEW.purchase_id AND r.basis IN ('PARTIAL_CANCELLATION', 'FULL_TERMINATION')
                  AND a.committed_xact_id = pg_current_xact_id() AND l.line_status = 'CANCELLED'))) IS NOT TRUE THEN
      RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
    END IF;
    NEW.state_changed_at := clock_timestamp();
  ELSIF NEW.state_changed_at IS DISTINCT FROM OLD.state_changed_at THEN
    RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- The current-revision projection of 0021, plus the line status.
CREATE OR REPLACE VIEW seat_slot_current AS
  SELECT s.id AS seat_slot_id, s.seat_slot_ref, s.purchase_id, p.purchase_ref, s.position, s.state,
         coalesce(h.fenced_at IS NOT NULL, false) AS payment_fenced, h.expires_at AS hold_expires_at, h.hold_ref,
         l.ticket_type, l.price_kopecks, l.pricing_basis_id, r.revision, r.departure_id, m.group_id,
         fn_line_status(l.line_status, s.state) AS line_status
    FROM seat_slot s
    JOIN purchase p ON p.id = s.purchase_id
    JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN purchase_revision_line l ON l.purchase_id = r.purchase_id AND l.revision = r.revision AND l.seat_slot_id = s.id
    LEFT JOIN seat_hold h ON h.purchase_id = s.purchase_id AND h.closed_at IS NULL
    LEFT JOIN purchase_group_member m ON m.purchase_id = p.id;

-- ---------------------------------------------------------------------------------------------
-- 4. Money with provenance: transfers between active seats, lot-based settlement cases, retentions and their
--    reversals, refunds bound to a case.

CREATE TABLE seat_money_transfer (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  amendment_id        uuid NOT NULL REFERENCES purchase_amendment(id),
  source_operation_id uuid NOT NULL REFERENCES bank_operation(id),
  from_seat_slot_id   uuid NOT NULL REFERENCES seat_slot(id),
  to_seat_slot_id     uuid NOT NULL REFERENCES seat_slot(id),
  amount_kopecks      bigint NOT NULL CHECK (amount_kopecks > 0),
  transferred_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (from_seat_slot_id <> to_seat_slot_id)
);
CREATE INDEX seat_money_transfer_from ON seat_money_transfer (from_seat_slot_id);
CREATE INDEX seat_money_transfer_to ON seat_money_transfer (to_seat_slot_id);

ALTER TABLE bank_settlement_case ALTER COLUMN bank_operation_id DROP NOT NULL,
  ADD COLUMN amendment_id uuid REFERENCES purchase_amendment(id),
  ADD COLUMN amount_kopecks bigint CHECK (amount_kopecks > 0),
  ADD COLUMN retention_allowed boolean,
  ADD COLUMN contradiction_to_lot bigint CHECK (contradiction_to_lot >= 0),
  ADD COLUMN contradiction_retention_reversed bigint CHECK (contradiction_retention_reversed >= 0),
  ADD COLUMN contradiction_over_refund bigint CHECK (contradiction_over_refund >= 0),
  ADD COLUMN contradiction_decision text CHECK (contradiction_decision IN ('CLAIM', 'WRITE_OFF'));
ALTER TABLE bank_settlement_case DROP CONSTRAINT bank_settlement_case_reason_check,
  ADD CONSTRAINT bank_settlement_case_reason_check CHECK (reason IN ('PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS', 'PAID_NO_SEAT',
    'EVIDENCE_MISMATCH', 'CONTRADICTORY_EVIDENCE', 'UNALLOCATED_MONEY', 'AMENDMENT_OVERPAYMENT', 'CANCELLATION_SETTLEMENT',
    'REFUND_CONTRADICTED')),
  ADD CONSTRAINT bank_settlement_case_lots CHECK ((reason IN ('AMENDMENT_OVERPAYMENT', 'CANCELLATION_SETTLEMENT')) = (amendment_id IS NOT NULL)
    AND (amendment_id IS NOT NULL) = (amount_kopecks IS NOT NULL) AND (amendment_id IS NOT NULL) = (retention_allowed IS NOT NULL)
    AND (amendment_id IS NULL) = (bank_operation_id IS NOT NULL)),
  ADD CONSTRAINT bank_settlement_case_contradiction CHECK (reason = 'REFUND_CONTRADICTED' OR (contradiction_to_lot IS NULL
    AND contradiction_retention_reversed IS NULL AND contradiction_over_refund IS NULL AND contradiction_decision IS NULL)),
  ADD CONSTRAINT bank_settlement_case_amendment_reason UNIQUE (amendment_id, reason);
-- A lot-based case is resolved by its lots' outcomes, not by one refund operation.
DO $do$
DECLARE c text;
BEGIN
  SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid = 'bank_settlement_case'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%''REFUNDED''::text) = (refund_operation_id IS NOT NULL)%';
  EXECUTE format('ALTER TABLE bank_settlement_case DROP CONSTRAINT %I', c);
  SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid = 'bank_operation'::regclass AND contype = 'c'
     AND pg_get_constraintdef(oid) LIKE '%application_due IS NULL%';
  EXECUTE format('ALTER TABLE bank_operation DROP CONSTRAINT %I', c);
END $do$;
ALTER TABLE bank_settlement_case ADD CONSTRAINT bank_settlement_case_refund_operation CHECK (
  CASE WHEN reason IN ('AMENDMENT_OVERPAYMENT', 'CANCELLATION_SETTLEMENT', 'REFUND_CONTRADICTED') THEN refund_operation_id IS NULL
       ELSE (resolution = 'REFUNDED') = (refund_operation_id IS NOT NULL) END);

-- A refund opened for a lot-based case; a confirmed one carries its application (allocation to the lots).
ALTER TABLE bank_operation ADD COLUMN settlement_case_id uuid REFERENCES bank_settlement_case(id),
  ADD CONSTRAINT bank_operation_settlement_case CHECK (kind = 'REFUND' OR settlement_case_id IS NULL),
  ADD CONSTRAINT bank_operation_application_due CHECK (kind = 'COLLECTION' OR application_due IS NULL OR settlement_case_id IS NOT NULL);
CREATE INDEX bank_operation_settlement_case ON bank_operation (settlement_case_id) WHERE settlement_case_id IS NOT NULL;

CREATE TABLE settlement_case_lot (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id             uuid NOT NULL REFERENCES bank_settlement_case(id),
  -- NULL: money of the collection outside any seat (0028).
  seat_slot_id        uuid REFERENCES seat_slot(id),
  source_operation_id uuid NOT NULL REFERENCES bank_operation(id),
  amount_kopecks      bigint NOT NULL CHECK (amount_kopecks > 0),
  UNIQUE NULLS NOT DISTINCT (case_id, seat_slot_id, source_operation_id)
);
CREATE INDEX settlement_case_lot_seat ON settlement_case_lot (seat_slot_id, source_operation_id);

CREATE TABLE settlement_lot_retention (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lot_id         bigint NOT NULL REFERENCES settlement_case_lot(id),
  amount_kopecks bigint NOT NULL CHECK (amount_kopecks > 0),
  legal_basis    text NOT NULL CHECK (length(btrim(legal_basis)) BETWEEN 1 AND 500),
  evidence_ref   text NOT NULL CHECK (evidence_ref ~ '^[A-Za-z0-9_.:/#-]{1,200}$'),
  retained_by    text NOT NULL CHECK (length(retained_by) BETWEEN 1 AND 120),
  retained_at    timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE settlement_lot_retention_reversal (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  retention_id          bigint NOT NULL REFERENCES settlement_lot_retention(id),
  amount_kopecks        bigint NOT NULL CHECK (amount_kopecks > 0),
  refund_operation_id   uuid NOT NULL REFERENCES bank_operation(id),
  contradiction_case_id uuid NOT NULL REFERENCES bank_settlement_case(id),
  reversed_by           text NOT NULL CHECK (length(reversed_by) BETWEEN 1 AND 120),
  reversed_at           timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Several partial refunds per seat and per case; a lot's refunds name their lot.
DO $do$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'bank_refund_allocation'::regclass AND contype = 'u' LOOP
    EXECUTE format('ALTER TABLE bank_refund_allocation DROP CONSTRAINT %I', c);
  END LOOP;
END $do$;
ALTER TABLE bank_refund_allocation ADD COLUMN settlement_case_lot_id bigint REFERENCES settlement_case_lot(id);
CREATE INDEX bank_refund_allocation_seat ON bank_refund_allocation (seat_slot_id) WHERE seat_slot_id IS NOT NULL;
CREATE INDEX bank_refund_allocation_lot ON bank_refund_allocation (settlement_case_lot_id) WHERE settlement_case_lot_id IS NOT NULL;

CREATE TRIGGER trg_seat_money_transfer_immutable BEFORE UPDATE OR DELETE ON seat_money_transfer
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_money_transfer_no_truncate BEFORE TRUNCATE ON seat_money_transfer
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_case_lot_immutable BEFORE UPDATE OR DELETE ON settlement_case_lot
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_case_lot_no_truncate BEFORE TRUNCATE ON settlement_case_lot
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_lot_retention_immutable BEFORE UPDATE OR DELETE ON settlement_lot_retention
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_lot_retention_no_truncate BEFORE TRUNCATE ON settlement_lot_retention
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_lot_reversal_immutable BEFORE UPDATE OR DELETE ON settlement_lot_retention_reversal
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_settlement_lot_reversal_no_truncate BEFORE TRUNCATE ON settlement_lot_retention_reversal
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- ---------------------------------------------------------------------------------------------
-- 5. Ledger arithmetic (§5.1).

-- holding(seat, X): what the seat holds of collection X.
CREATE FUNCTION fn_seat_lot_holding(p_seat uuid, p_operation uuid) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (coalesce((SELECT sum(amount_kopecks) FROM seat_money_allocation WHERE seat_slot_id = p_seat AND bank_operation_id = p_operation), 0)
        + coalesce((SELECT sum(amount_kopecks) FROM seat_money_transfer WHERE to_seat_slot_id = p_seat AND source_operation_id = p_operation), 0)
        - coalesce((SELECT sum(amount_kopecks) FROM seat_money_transfer WHERE from_seat_slot_id = p_seat AND source_operation_id = p_operation), 0)
        - coalesce((SELECT sum(a.amount_kopecks) FROM bank_refund_allocation a JOIN bank_operation r ON r.id = a.refund_operation_id
                     WHERE a.seat_slot_id = p_seat AND r.refunds_operation_id = p_operation), 0))::bigint
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_seat_net(p_seat uuid) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (coalesce((SELECT sum(amount_kopecks) FROM seat_money_allocation WHERE seat_slot_id = p_seat), 0)
        + coalesce((SELECT sum(amount_kopecks) FROM seat_money_transfer WHERE to_seat_slot_id = p_seat), 0)
        - coalesce((SELECT sum(amount_kopecks) FROM seat_money_transfer WHERE from_seat_slot_id = p_seat), 0)
        - coalesce((SELECT sum(amount_kopecks) FROM bank_refund_allocation WHERE seat_slot_id = p_seat), 0))::bigint
$fn$ LANGUAGE sql;

-- executed(lot) = refunds allocated to it + retentions − their reversals (I-22).
CREATE FUNCTION fn_settlement_lot_executed(p_lot bigint) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (coalesce((SELECT sum(amount_kopecks) FROM bank_refund_allocation WHERE settlement_case_lot_id = p_lot), 0)
        + coalesce((SELECT sum(amount_kopecks) FROM settlement_lot_retention WHERE lot_id = p_lot), 0)
        - coalesce((SELECT sum(v.amount_kopecks) FROM settlement_lot_retention_reversal v JOIN settlement_lot_retention t ON t.id = v.retention_id
                     WHERE t.lot_id = p_lot), 0))::bigint
$fn$ LANGUAGE sql;

-- A refund's FAILED is final for reservations only when an authoritative read-back said so (§5.5).
CREATE FUNCTION fn_refund_failure_confirmed(p_refund uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM bank_operation_evidence WHERE bank_operation_id = p_refund AND source = 'READ_BACK'
                   AND observed = 'FAILED' AND matches)
$fn$ LANGUAGE sql;

-- The case's refunds through collection X that still hold part of its lots (I-21 prevention): in flight,
-- confirmed but not allocated yet (unless contradicted), or failed without a read-back.
CREATE FUNCTION fn_settlement_case_reserve(p_case uuid, p_operation uuid, p_except uuid) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(sum(CASE
           WHEN r.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') THEN r.amount_kopecks
           WHEN r.status = 'SUCCEEDED' AND r.application_due IS NOT NULL AND r.contradicted_at IS NULL
             THEN r.amount_kopecks - coalesce((SELECT sum(a.amount_kopecks) FROM bank_refund_allocation a WHERE a.refund_operation_id = r.id), 0)
           WHEN r.status = 'FAILED' AND NOT fn_refund_failure_confirmed(r.id) THEN r.amount_kopecks
           ELSE 0 END), 0)::bigint
    FROM bank_operation r
   WHERE r.kind = 'REFUND' AND r.settlement_case_id = p_case AND r.refunds_operation_id = p_operation AND r.id IS DISTINCT FROM p_except
$fn$ LANGUAGE sql;

-- reserved(seat, X): the not yet executed part of the open lot cases' lots on this money.
CREATE FUNCTION fn_seat_lot_reserved(p_seat uuid, p_operation uuid) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(sum(l.amount_kopecks - fn_settlement_lot_executed(l.id)), 0)::bigint
    FROM settlement_case_lot l JOIN bank_settlement_case k ON k.id = l.case_id
   WHERE l.seat_slot_id = p_seat AND l.source_operation_id = p_operation AND k.resolved_at IS NULL
$fn$ LANGUAGE sql;

-- A contradicted refund of a lot-based case freezes its collection's money until REFUND_CONTRADICTED is
-- resolved; computed from the bank fact itself, not only from the case (§5.5).
CREATE FUNCTION fn_collection_frozen(p_operation uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM bank_operation r
                  WHERE r.kind = 'REFUND' AND r.refunds_operation_id = p_operation AND r.settlement_case_id IS NOT NULL
                    AND r.contradicted_at IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM bank_settlement_case k WHERE k.bank_operation_id = r.id
                                     AND k.reason = 'REFUND_CONTRADICTED' AND k.resolved_at IS NOT NULL))
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_purchase_frozen(p_purchase uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM bank_operation c WHERE c.purchase_id = p_purchase AND c.kind = 'COLLECTION' AND fn_collection_frozen(c.id))
$fn$ LANGUAGE sql;

-- The lots a seat holds, newest intention first (the accepted technical spending order, §5.1).
CREATE VIEW seat_money_lot AS
  SELECT x.seat_slot_id, s.seat_slot_ref, s.purchase_id, x.bank_operation_id, b.bank_operation_ref, b.created_at AS intended_at,
         fn_seat_lot_holding(x.seat_slot_id, x.bank_operation_id) AS holding_kopecks,
         fn_seat_lot_reserved(x.seat_slot_id, x.bank_operation_id) AS reserved_kopecks
    FROM (SELECT seat_slot_id, bank_operation_id FROM seat_money_allocation
          UNION SELECT to_seat_slot_id, source_operation_id FROM seat_money_transfer) x
    JOIN seat_slot s ON s.id = x.seat_slot_id JOIN bank_operation b ON b.id = x.bank_operation_id;

-- 0026's views over the lots: paid = received (allocations and transfers), refunded = refunds allocated to the
-- seat; the balance due of an active confirmed seat is price − net; totals count active lines only; the
-- deadlines are the current revision's, frozen.
CREATE OR REPLACE VIEW seat_money AS
  SELECT c.seat_slot_id, c.seat_slot_ref, c.purchase_id, c.purchase_ref, c.state, c.ticket_type, c.price_kopecks,
         fn_seat_deposit_kopecks(c.seat_slot_id) AS deposit_kopecks,
         coalesce((SELECT sum(a.amount_kopecks) FROM seat_money_allocation a WHERE a.seat_slot_id = c.seat_slot_id), 0)
           + coalesce((SELECT sum(t.amount_kopecks) FROM seat_money_transfer t WHERE t.to_seat_slot_id = c.seat_slot_id), 0)
           - coalesce((SELECT sum(t.amount_kopecks) FROM seat_money_transfer t WHERE t.from_seat_slot_id = c.seat_slot_id), 0) AS paid_kopecks,
         coalesce((SELECT sum(r.amount_kopecks) FROM bank_refund_allocation r WHERE r.seat_slot_id = c.seat_slot_id), 0) AS refunded_kopecks,
         CASE WHEN c.state = 'CONFIRMED' AND c.line_status = 'ACTIVE'
              THEN greatest(0::numeric, c.price_kopecks - fn_seat_net(c.seat_slot_id))
              ELSE 0 END AS balance_due_kopecks,
         c.line_status,
         fn_seat_net(c.seat_slot_id) AS net_kopecks,
         CASE WHEN c.line_status = 'ACTIVE' THEN greatest(0, fn_seat_net(c.seat_slot_id) - c.price_kopecks)
              ELSE fn_seat_net(c.seat_slot_id) END AS excess_kopecks
    FROM seat_slot_current c;

CREATE OR REPLACE VIEW purchase_money AS
  SELECT p.purchase_ref,
         coalesce(sum(m.price_kopecks) FILTER (WHERE m.line_status = 'ACTIVE'), 0) AS total_kopecks,
         coalesce(sum(m.deposit_kopecks) FILTER (WHERE m.line_status = 'ACTIVE'), 0) AS deposit_total_kopecks,
         sum(m.paid_kopecks) AS paid_kopecks, sum(m.refunded_kopecks) AS refunded_kopecks,
         sum(m.balance_due_kopecks) AS balance_due_kopecks,
         coalesce(r.deposit_until, fn_departure_deposit_cutoff(r.departure_id)) AS deposit_until,
         coalesce(r.balance_due_at, fn_departure_cutoff(r.departure_id)) AS balance_due_at,
         coalesce(sum(m.deposit_kopecks) FILTER (WHERE m.line_status = 'ACTIVE'), 0)
           < coalesce(sum(m.price_kopecks) FILTER (WHERE m.line_status = 'ACTIVE'), 0) AS deposit_offered,
         coalesce(sum(m.net_kopecks) FILTER (WHERE m.line_status = 'ACTIVE'), 0) AS active_net_kopecks
    FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN seat_money m ON m.purchase_id = p.id
   GROUP BY p.id, p.purchase_ref, r.departure_id, r.deposit_until, r.balance_due_at;

-- ---------------------------------------------------------------------------------------------
-- 6. Guards of the ledger (I-8, I-21, I-22) for every login's DML.

-- 0026's allocation guard over net money: an active seat never holds more than its price; a cancelled seat
-- receives nothing.
CREATE OR REPLACE FUNCTION fn_seat_money_allocation_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE op bank_operation%ROWTYPE; c seat_slot_current%ROWTYPE;
BEGIN
  SELECT * INTO op FROM bank_operation WHERE id = NEW.bank_operation_id;
  SELECT * INTO c FROM seat_slot_current WHERE seat_slot_id = NEW.seat_slot_id;
  IF op.kind <> 'COLLECTION' OR op.status <> 'SUCCEEDED' OR op.purchase_id IS DISTINCT FROM c.purchase_id
     OR c.line_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'SEAT_MONEY_ALLOCATION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF fn_seat_net(NEW.seat_slot_id) + NEW.amount_kopecks > c.price_kopecks
     OR (SELECT coalesce(sum(amount_kopecks), 0) FROM seat_money_allocation WHERE bank_operation_id = op.id) + NEW.amount_kopecks > op.amount_kopecks THEN
    RAISE EXCEPTION 'SEAT_MONEY_ALLOCATION_EXCEEDS' USING ERRCODE = '55000';
  END IF;
  NEW.allocated_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

-- A transfer moves money of one collection between two active seats of the same purchase: never from a
-- cancelled seat (Q3), never more than the source's free part of that collection, never beyond the target's price.
CREATE FUNCTION fn_seat_money_transfer_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE f seat_slot_current%ROWTYPE; t seat_slot_current%ROWTYPE; op bank_operation%ROWTYPE;
BEGIN
  SELECT * INTO f FROM seat_slot_current WHERE seat_slot_id = NEW.from_seat_slot_id;
  SELECT * INTO t FROM seat_slot_current WHERE seat_slot_id = NEW.to_seat_slot_id;
  SELECT * INTO op FROM bank_operation WHERE id = NEW.source_operation_id;
  IF f.line_status IS DISTINCT FROM 'ACTIVE' THEN RAISE EXCEPTION 'SEAT_MONEY_SOURCE_CANCELLED' USING ERRCODE = '55000'; END IF;
  IF t.line_status IS DISTINCT FROM 'ACTIVE' OR f.purchase_id <> t.purchase_id OR op.kind <> 'COLLECTION' OR op.status <> 'SUCCEEDED'
     OR op.purchase_id <> f.purchase_id
     OR NOT EXISTS (SELECT 1 FROM purchase_amendment WHERE id = NEW.amendment_id AND purchase_id = f.purchase_id) THEN
    RAISE EXCEPTION 'SEAT_MONEY_TRANSFER_INVALID' USING ERRCODE = '55000';
  END IF;
  IF fn_collection_frozen(op.id) THEN RAISE EXCEPTION 'REFUND_CONTRADICTION_PENDING' USING ERRCODE = '55000'; END IF;
  IF NEW.amount_kopecks > fn_seat_lot_holding(f.seat_slot_id, op.id) - fn_seat_lot_reserved(f.seat_slot_id, op.id)
     OR fn_seat_net(t.seat_slot_id) + NEW.amount_kopecks > t.price_kopecks THEN
    RAISE EXCEPTION 'SEAT_MONEY_TRANSFER_EXCEEDS' USING ERRCODE = '55000';
  END IF;
  NEW.transferred_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_money_transfer_guard BEFORE INSERT ON seat_money_transfer
  FOR EACH ROW EXECUTE FUNCTION fn_seat_money_transfer_guard();

-- A lot of a case is the case's own, on its seat and collection, created with the case, never beyond the
-- seat's free money of that collection.
CREATE FUNCTION fn_settlement_case_lot_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE k bank_settlement_case%ROWTYPE;
BEGIN
  SELECT * INTO k FROM bank_settlement_case WHERE id = NEW.case_id;
  IF k.amendment_id IS NULL OR k.resolved_at IS NOT NULL OR k.xmin <> pg_current_xact_id()::xid
     OR NOT EXISTS (SELECT 1 FROM bank_operation WHERE id = NEW.source_operation_id AND kind = 'COLLECTION' AND status = 'SUCCEEDED'
                      AND purchase_id = k.purchase_id)
     OR (NEW.seat_slot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seat_slot WHERE id = NEW.seat_slot_id AND purchase_id = k.purchase_id)) THEN
    RAISE EXCEPTION 'SETTLEMENT_LOT_INVALID' USING ERRCODE = '55000';
  END IF;
  IF fn_collection_frozen(NEW.source_operation_id) THEN RAISE EXCEPTION 'REFUND_CONTRADICTION_PENDING' USING ERRCODE = '55000'; END IF;
  IF NEW.seat_slot_id IS NOT NULL AND NEW.amount_kopecks
       > fn_seat_lot_holding(NEW.seat_slot_id, NEW.source_operation_id) - fn_seat_lot_reserved(NEW.seat_slot_id, NEW.source_operation_id) THEN
    RAISE EXCEPTION 'SETTLEMENT_LOT_EXCEEDS' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_settlement_case_lot_guard BEFORE INSERT ON settlement_case_lot
  FOR EACH ROW EXECUTE FUNCTION fn_settlement_case_lot_guard();

-- A refund allocated to a lot: a confirmed refund through the lot's collection, bound to the lot's case; the
-- lot never executes beyond its amount, a seat never gives back more than it holds of that collection.
CREATE FUNCTION fn_bank_refund_allocation_lot_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE l settlement_case_lot%ROWTYPE; r bank_operation%ROWTYPE;
BEGIN
  IF NEW.settlement_case_lot_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO l FROM settlement_case_lot WHERE id = NEW.settlement_case_lot_id;
  SELECT * INTO r FROM bank_operation WHERE id = NEW.refund_operation_id;
  IF r.kind <> 'REFUND' OR r.status <> 'SUCCEEDED' OR r.refunds_operation_id <> l.source_operation_id
     OR r.settlement_case_id IS DISTINCT FROM l.case_id OR NEW.seat_slot_id IS DISTINCT FROM l.seat_slot_id
     OR (l.seat_slot_id IS NULL AND NEW.settlement_case_id IS DISTINCT FROM l.case_id) THEN
    RAISE EXCEPTION 'REFUND_ALLOCATION_INVALID' USING ERRCODE = '55000';
  END IF;
  IF fn_settlement_lot_executed(l.id) + NEW.amount_kopecks > l.amount_kopecks
     OR (l.seat_slot_id IS NOT NULL AND NEW.amount_kopecks > fn_seat_lot_holding(l.seat_slot_id, l.source_operation_id)) THEN
    RAISE EXCEPTION 'REFUND_INSUFFICIENT' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_refund_allocation_lot_guard BEFORE INSERT ON bank_refund_allocation
  FOR EACH ROW EXECUTE FUNCTION fn_bank_refund_allocation_lot_guard();

-- Retention: OWNER only (through its command), an open case that allows it, within the lot's remainder.
CREATE FUNCTION fn_settlement_lot_retention_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE l settlement_case_lot%ROWTYPE; k bank_settlement_case%ROWTYPE;
BEGIN
  SELECT * INTO l FROM settlement_case_lot WHERE id = NEW.lot_id;
  SELECT * INTO k FROM bank_settlement_case WHERE id = l.case_id;
  IF k.resolved_at IS NOT NULL OR NOT k.retention_allowed THEN RAISE EXCEPTION 'RETENTION_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
  IF fn_collection_frozen(l.source_operation_id) THEN RAISE EXCEPTION 'REFUND_CONTRADICTION_PENDING' USING ERRCODE = '55000'; END IF;
  -- Within the lot, and within what the case's lots on this collection leave once its pending refunds land.
  IF fn_settlement_lot_executed(l.id) + NEW.amount_kopecks > l.amount_kopecks
     OR NEW.amount_kopecks > (SELECT sum(x.amount_kopecks - fn_settlement_lot_executed(x.id)) FROM settlement_case_lot x
                                WHERE x.case_id = l.case_id AND x.source_operation_id = l.source_operation_id)
                             - fn_settlement_case_reserve(l.case_id, l.source_operation_id, NULL) THEN
    RAISE EXCEPTION 'RETENTION_EXCEEDS' USING ERRCODE = '55000';
  END IF;
  NEW.retained_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_settlement_lot_retention_guard BEFORE INSERT ON settlement_lot_retention
  FOR EACH ROW EXECUTE FUNCTION fn_settlement_lot_retention_guard();

-- A reversal undoes part of a retention the bank refunded after all, only by its contradiction case.
CREATE FUNCTION fn_settlement_lot_reversal_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE t settlement_lot_retention%ROWTYPE; k bank_settlement_case%ROWTYPE;
BEGIN
  SELECT * INTO t FROM settlement_lot_retention WHERE id = NEW.retention_id;
  SELECT * INTO k FROM bank_settlement_case WHERE id = NEW.contradiction_case_id;
  IF k.reason <> 'REFUND_CONTRADICTED' OR k.resolved_at IS NOT NULL OR k.bank_operation_id <> NEW.refund_operation_id
     OR NEW.amount_kopecks > t.amount_kopecks - coalesce((SELECT sum(amount_kopecks) FROM settlement_lot_retention_reversal
                                                            WHERE retention_id = t.id), 0) THEN
    RAISE EXCEPTION 'RETENTION_REVERSAL_INVALID' USING ERRCODE = '55000';
  END IF;
  NEW.reversed_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_settlement_lot_reversal_guard BEFORE INSERT ON settlement_lot_retention_reversal
  FOR EACH ROW EXECUTE FUNCTION fn_settlement_lot_reversal_guard();

-- A refund's case binding never changes; a confirmed refund of a case is applied to its lots (application_due),
-- and a contradicted one opens REFUND_CONTRADICTED with the bank fact itself, outside the application.
CREATE FUNCTION fn_bank_operation_case_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.settlement_case_id IS DISTINCT FROM OLD.settlement_case_id THEN
    RAISE EXCEPTION 'BANK_OPERATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.kind = 'REFUND' AND NEW.settlement_case_id IS NOT NULL AND NEW.status = 'SUCCEEDED' AND OLD.status <> 'SUCCEEDED' THEN
    NEW.application_due := 'SUCCEEDED';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_operation_case_immutable BEFORE UPDATE ON bank_operation
  FOR EACH ROW EXECUTE FUNCTION fn_bank_operation_case_immutable();

CREATE FUNCTION fn_bank_operation_refund_contradicted() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_bank_settlement_open(NEW.id, 'REFUND_CONTRADICTED');
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_operation_refund_contradicted AFTER UPDATE OF contradicted_at ON bank_operation
  FOR EACH ROW WHEN (NEW.kind = 'REFUND' AND NEW.settlement_case_id IS NOT NULL AND OLD.contradicted_at IS NULL
                     AND NEW.contradicted_at IS NOT NULL)
  EXECUTE FUNCTION fn_bank_operation_refund_contradicted();

-- Whether a lot-based case may close now (I-22 (б)).
CREATE FUNCTION fn_settlement_case_closable(p_case uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM settlement_case_lot l WHERE l.case_id = p_case AND fn_settlement_lot_executed(l.id) <> l.amount_kopecks)
     AND NOT EXISTS (SELECT 1 FROM bank_operation r WHERE r.settlement_case_id = p_case
                      AND (r.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') OR r.application_due IS NOT NULL
                           OR (r.status = 'FAILED' AND NOT fn_refund_failure_confirmed(r.id))))
     AND NOT EXISTS (SELECT 1 FROM settlement_case_lot l WHERE l.case_id = p_case AND fn_collection_frozen(l.source_operation_id))
$fn$ LANGUAGE sql;

-- The split of a contradicted refund R1 (§5.5): recomputed from the lot data before R1, exact equalities.
CREATE FUNCTION fn_refund_contradiction_valid(k bank_settlement_case) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE r1 bank_operation%ROWTYPE; v_lots bigint; v_exec bigint; v_ret bigint; v_rev_all bigint; v_r1_lots bigint; v_r1_case bigint;
  v_rev_k bigint; v_rem bigint; v_act bigint; v_to bigint; v_rev bigint;
BEGIN
  IF k.contradiction_to_lot IS NULL OR k.contradiction_retention_reversed IS NULL OR k.contradiction_over_refund IS NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO r1 FROM bank_operation WHERE id = k.bank_operation_id;
  IF r1.kind <> 'REFUND' OR r1.contradicted_at IS NULL OR r1.settlement_case_id IS NULL OR r1.application_due IS NOT NULL
     OR k.contradiction_to_lot + k.contradiction_retention_reversed + k.contradiction_over_refund <> r1.amount_kopecks
     OR (k.contradiction_over_refund > 0 AND k.contradiction_decision IS NULL)
     OR fn_settlement_case_reserve(r1.settlement_case_id, r1.refunds_operation_id, r1.id) > 0 THEN
    RETURN false;
  END IF;
  SELECT coalesce(sum(l.amount_kopecks), 0), coalesce(sum(fn_settlement_lot_executed(l.id)), 0) INTO v_lots, v_exec
    FROM settlement_case_lot l WHERE l.case_id = r1.settlement_case_id AND l.source_operation_id = r1.refunds_operation_id;
  SELECT coalesce(sum(t.amount_kopecks), 0) INTO v_ret FROM settlement_lot_retention t JOIN settlement_case_lot l ON l.id = t.lot_id
   WHERE l.case_id = r1.settlement_case_id AND l.source_operation_id = r1.refunds_operation_id;
  SELECT coalesce(sum(v.amount_kopecks), 0) INTO v_rev_all FROM settlement_lot_retention_reversal v
    JOIN settlement_lot_retention t ON t.id = v.retention_id JOIN settlement_case_lot l ON l.id = t.lot_id
   WHERE l.case_id = r1.settlement_case_id AND l.source_operation_id = r1.refunds_operation_id;
  SELECT coalesce(sum(a.amount_kopecks), 0) INTO v_r1_lots FROM bank_refund_allocation a
   WHERE a.refund_operation_id = r1.id AND a.settlement_case_lot_id IS NOT NULL;
  SELECT coalesce(sum(a.amount_kopecks), 0) INTO v_r1_case FROM bank_refund_allocation a
   WHERE a.refund_operation_id = r1.id AND a.settlement_case_id = k.id;
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_rev_k FROM settlement_lot_retention_reversal WHERE contradiction_case_id = k.id;
  IF v_r1_lots <> k.contradiction_to_lot + k.contradiction_retention_reversed OR v_r1_case <> k.contradiction_over_refund
     OR v_rev_k <> k.contradiction_retention_reversed THEN
    RETURN false;
  END IF;
  -- Before R1: executed was v_exec − to_lot (R1's lot allocations minus its reversals), active retentions
  -- v_ret − (v_rev_all − reversed).
  v_rem := v_lots - (v_exec - k.contradiction_to_lot);
  v_act := v_ret - (v_rev_all - k.contradiction_retention_reversed);
  v_to := least(r1.amount_kopecks, v_rem);
  v_rev := least(r1.amount_kopecks - v_to, v_act);
  RETURN k.contradiction_to_lot = v_to AND k.contradiction_retention_reversed = v_rev
     AND k.contradiction_over_refund = r1.amount_kopecks - v_to - v_rev;
END $fn$ LANGUAGE plpgsql;

-- 0022's case guard, plus: a lot-based case closes only when executed, a contradiction only by its valid
-- split; both checked on the data whoever writes the row (I-22, §5.5).
CREATE OR REPLACE FUNCTION fn_bank_settlement_case_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.resolved_at IS NOT NULL OR NEW.contradiction_to_lot IS NOT NULL OR NEW.contradiction_retention_reversed IS NOT NULL
       OR NEW.contradiction_over_refund IS NOT NULL OR NEW.contradiction_decision IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    NEW.opened_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.case_ref, NEW.bank_operation_id, NEW.purchase_id, NEW.reason, NEW.opened_at, NEW.amendment_id,
         NEW.amount_kopecks, NEW.retention_allowed)
     IS DISTINCT FROM ROW(OLD.id, OLD.case_ref, OLD.bank_operation_id, OLD.purchase_id, OLD.reason, OLD.opened_at, OLD.amendment_id,
         OLD.amount_kopecks, OLD.retention_allowed)
     OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.resolved_at IS NULL THEN
    IF ROW(NEW.contradiction_to_lot, NEW.contradiction_retention_reversed, NEW.contradiction_over_refund, NEW.contradiction_decision)
       IS DISTINCT FROM ROW(OLD.contradiction_to_lot, OLD.contradiction_retention_reversed, OLD.contradiction_over_refund,
                            OLD.contradiction_decision) THEN
      RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.reason IN ('AMENDMENT_OVERPAYMENT', 'CANCELLATION_SETTLEMENT') AND NOT fn_settlement_case_closable(NEW.id) THEN
    RAISE EXCEPTION 'SETTLEMENT_CASE_NOT_EXECUTED' USING ERRCODE = '55000';
  ELSIF NEW.reason = 'REFUND_CONTRADICTED' AND NOT fn_refund_contradiction_valid(NEW) THEN
    RAISE EXCEPTION 'REFUND_CONTRADICTION_OUTCOME_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW bank_settlement_open AS
  SELECT k.case_ref, k.reason, k.opened_at, b.bank_operation_ref, b.kind, coalesce(b.amount_kopecks, k.amount_kopecks) AS amount_kopecks,
         coalesce(b.currency, 'RUB') AS currency, b.status, b.contradicted_at, p.purchase_ref, a.amendment_ref
    FROM bank_settlement_case k LEFT JOIN bank_operation b ON b.id = k.bank_operation_id JOIN purchase p ON p.id = k.purchase_id
    LEFT JOIN purchase_amendment a ON a.id = k.amendment_id
   WHERE k.resolved_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 7. What stops an amendment and what stops a payment (§3.2, §5.7, I-11, I-13).

CREATE FUNCTION fn_purchase_money_in_flight(p_purchase uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM bank_operation b WHERE b.purchase_id = p_purchase
                   AND (b.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') OR b.application_due IS NOT NULL
                        -- a 0022 refund confirmed by the bank but not yet allocated by its settlement function
                        OR (b.kind = 'REFUND' AND b.settlement_case_id IS NULL AND b.status = 'SUCCEEDED'
                            AND b.amount_kopecks > coalesce((SELECT sum(a.amount_kopecks) FROM bank_refund_allocation a
                                                              WHERE a.refund_operation_id = b.id), 0))))
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_purchase_amendment_blocker(p_purchase uuid, p_basis text) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT o2.* INTO o FROM purchase p JOIN orders o2 ON o2.id = p.origin_order_id WHERE p.id = p_purchase;
  IF o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN RETURN 'PURCHASE_CLOSED'; END IF;
  IF EXISTS (SELECT 1 FROM seat_slot WHERE purchase_id = p_purchase AND state IN ('HELD', 'RELEASED')) THEN
    RETURN 'AMENDMENT_PURCHASE_NOT_CONFIRMED';
  END IF;
  IF EXISTS (SELECT 1 FROM seat_slot WHERE purchase_id = p_purchase AND state = 'PAID_NO_SEAT_EXCEPTION') THEN
    RETURN 'AMENDMENT_SEAT_NOT_ELIGIBLE';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM seat_slot_current WHERE purchase_id = p_purchase AND state = 'CONFIRMED' AND line_status = 'ACTIVE') THEN
    RETURN 'AMENDMENT_PURCHASE_TERMINATED';
  END IF;
  IF fn_purchase_money_in_flight(p_purchase) THEN RETURN 'AMENDMENT_PAYMENT_IN_FLIGHT'; END IF;
  IF fn_purchase_frozen(p_purchase) THEN RETURN 'REFUND_CONTRADICTION_PENDING'; END IF;
  IF p_basis <> 'PARTICIPANT_REPLACEMENT' AND EXISTS (SELECT 1 FROM bank_settlement_case k WHERE k.purchase_id = p_purchase
       AND k.resolved_at IS NULL AND k.reason <> 'PAID_NO_SEAT') THEN
    RETURN 'AMENDMENT_SETTLEMENT_PENDING';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_purchase_payment_blocker(p_purchase uuid) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM purchase_amendment a JOIN purchase_amendment_consent c ON c.amendment_id = a.id
                  WHERE a.purchase_id = p_purchase AND a.state = 'OPEN') THEN 'AMENDMENT_IN_PROGRESS'
    WHEN fn_purchase_frozen(p_purchase) THEN 'REFUND_CONTRADICTION_PENDING'
  END
$fn$ LANGUAGE sql;

-- Lock order for an amendment command (§7.2 R1–R3): the departure as checkout, the document order (the
-- purchase's serialization point), then the purchase.
CREATE FUNCTION fn_amendment_lock(p_purchase uuid) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_purchase_lock_departure(p_purchase);
  PERFORM 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id WHERE p.id = p_purchase FOR UPDATE OF o;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 8. The candidate (§2.3): every seat's line after the amendment and the money snapshot; the database
--    recomputes it for the consent, so a changed base or ledger makes the proposal stale.

-- The current revision's lines as candidate lines: [{seat, type, basis, price, status, ends}] by position.
CREATE FUNCTION fn_amendment_base_lines(p_purchase uuid) RETURNS jsonb
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('seat', c.seat_slot_id, 'type', c.ticket_type, 'basis', c.pricing_basis_id,
           'price', c.price_kopecks, 'status', c.line_status, 'ends', false) ORDER BY c.position), '[]'::jsonb)
    FROM seat_slot_current c WHERE c.purchase_id = p_purchase
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_amendment_stored_lines(p_amendment uuid) RETURNS jsonb
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(jsonb_agg(jsonb_build_object('seat', l.seat_slot_id, 'type', l.ticket_type, 'basis', l.pricing_basis_id,
           'price', l.price_kopecks, 'status', l.line_status, 'ends', l.ends_participant) ORDER BY s.position), '[]'::jsonb)
    FROM purchase_amendment_line l JOIN seat_slot s ON s.id = l.seat_slot_id WHERE l.amendment_id = p_amendment
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_amendment_candidate(p_purchase uuid, p_basis text, p_lines jsonb, p_expires_at timestamptz) RETURNS jsonb
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT jsonb_build_object(
    'purchaseRef', p.purchase_ref, 'basis', p_basis, 'baseRevision', r.revision, 'baseRevisionHash', r.revision_hash,
    'departureId', r.departure_id, 'departureVersion', r.departure_version,
    'depositUntil', to_char(coalesce(r.deposit_until, fn_departure_deposit_cutoff(r.departure_id)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'balanceDueAt', to_char(coalesce(r.balance_due_at, fn_departure_cutoff(r.departure_id)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'expiresAt', to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'legalRelease', jsonb_build_object('ref', r.legal_release_ref, 'hash', r.legal_release_hash),
    'pdConsent', jsonb_build_object('ref', r.pd_consent_ref, 'hash', r.pd_consent_hash),
    'seats', (SELECT count(*) FROM jsonb_array_elements(p_lines) x WHERE x->>'status' = 'ACTIVE'),
    'totalKopecks', (SELECT coalesce(sum((x->>'price')::bigint), 0) FROM jsonb_array_elements(p_lines) x WHERE x->>'status' = 'ACTIVE'),
    'lines', (SELECT jsonb_agg(jsonb_build_array(s.seat_slot_ref, x->>'status', x->>'type', (x->>'price')::bigint, b.pricing_basis_ref,
                (x->>'ends')::boolean, fn_seat_net(s.id),
                CASE WHEN x->>'status' = 'ACTIVE' THEN greatest(0, (x->>'price')::bigint - fn_seat_net(s.id)) ELSE 0 END,
                CASE WHEN x->>'status' = 'ACTIVE' THEN greatest(0, fn_seat_net(s.id) - (x->>'price')::bigint) ELSE fn_seat_net(s.id) END)
                ORDER BY s.position)
                FROM jsonb_array_elements(p_lines) x JOIN seat_slot s ON s.id = (x->>'seat')::uuid
                JOIN pricing_basis b ON b.id = (x->>'basis')::uuid))
    FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision WHERE p.id = p_purchase
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_amendment_hash(p_candidate jsonb) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to(p_candidate::text, 'UTF8')), 'hex')
$fn$ LANGUAGE sql;

-- Creates the open amendment and its candidate lines; the caller holds the locks and checked the basis.
CREATE FUNCTION fn_amendment_create(p_purchase uuid, p_basis text, p_lines jsonb, p_consent_mode text, p_admin uuid, p_by text,
  p_reason text, p_evidence text, p_initiator text, p_link text, p_key text, p_request text, p_expires_at timestamptz)
RETURNS purchase_amendment SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE a purchase_amendment%ROWTYPE; v_candidate jsonb := fn_amendment_candidate(p_purchase, p_basis, p_lines, p_expires_at);
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_amendment WHERE purchase_id = p_purchase AND state = 'OPEN') THEN
    RAISE EXCEPTION 'AMENDMENT_ALREADY_OPEN' USING ERRCODE = '55000';
  END IF;
  INSERT INTO purchase_amendment (amendment_ref, purchase_id, basis, base_revision, base_revision_hash, candidate, candidate_hash,
      consent_mode, initiated_by_admin, initiated_by, reason, request_evidence_ref, termination_initiator, link_token_sha256,
      idempotency_key, request_sha256, expires_at, state)
    SELECT fn_new_ref('am'), p_purchase, p_basis, r.revision, r.revision_hash, v_candidate, fn_amendment_hash(v_candidate),
           p_consent_mode, p_admin, p_by, p_reason, p_evidence, p_initiator, p_link, p_key, p_request, p_expires_at, 'OPEN'
      FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision WHERE p.id = p_purchase
    RETURNING * INTO a;
  INSERT INTO purchase_amendment_line (amendment_id, seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status, ends_participant)
    SELECT a.id, (x->>'seat')::uuid, x->>'type', (x->>'basis')::uuid, (x->>'price')::bigint, x->>'status', (x->>'ends')::boolean
      FROM jsonb_array_elements(p_lines) x;
  RETURN a;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 9. Commit (§2.1 п.3): the revision, its lines, the seats, the roles and the money, atomically. Only the
--    amendment commands call it; no login executes it.

-- The companion access a seat loses (§4.2): a replacement ends both sides and the seat's invitations; a role
-- change 18+ → minor ends the seat's companionships and its own adult access; minor → 18+ ends the
-- companionship of this child. Invitations of a revoked companionship follow (0021 trigger).
CREATE FUNCTION fn_seat_role_changed(p_slot uuid, p_old_type text, p_new_type text, p_replaced boolean) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_replaced THEN
    UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = 'PARTICIPANT_REPLACED'
     WHERE (companion_slot_id = p_slot OR minor_slot_id = p_slot) AND revoked_at IS NULL;
    UPDATE seat_invitation SET revoked_at = clock_timestamp(), revoke_reason = 'PARTICIPANT_REPLACED'
     WHERE seat_slot_id = p_slot AND revoked_at IS NULL;
  ELSIF p_old_type = 'AGE_18_PLUS' AND p_new_type <> 'AGE_18_PLUS' THEN
    UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = 'COMPANION_ROLE_LOST'
     WHERE companion_slot_id = p_slot AND revoked_at IS NULL;
    UPDATE seat_invitation SET revoked_at = clock_timestamp(), revoke_reason = 'ADULT_ROLE_LOST'
     WHERE seat_slot_id = p_slot AND purpose = 'SELF' AND revoked_at IS NULL;
  ELSIF p_old_type <> 'AGE_18_PLUS' AND p_new_type = 'AGE_18_PLUS' THEN
    UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = 'MINOR_BECAME_ADULT'
     WHERE minor_slot_id = p_slot AND revoked_at IS NULL;
  END IF;
END $fn$ LANGUAGE plpgsql;

-- Opens a lot-based case on the given lots [{seat, op, amount}] (none: no case).
CREATE FUNCTION fn_amendment_case_open(p_amendment uuid, p_reason text, p_retention boolean, p_lots jsonb) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_case uuid; v_amount bigint; a purchase_amendment%ROWTYPE;
BEGIN
  SELECT coalesce(sum((x->>'amount')::bigint), 0) INTO v_amount FROM jsonb_array_elements(p_lots) x;
  IF v_amount <= 0 THEN RETURN NULL; END IF;
  SELECT * INTO a FROM purchase_amendment WHERE id = p_amendment;
  INSERT INTO bank_settlement_case (case_ref, bank_operation_id, purchase_id, reason, amendment_id, amount_kopecks, retention_allowed)
    VALUES (fn_new_ref('bc'), NULL, a.purchase_id, p_reason, a.id, v_amount, p_retention) RETURNING id INTO v_case;
  INSERT INTO settlement_case_lot (case_id, seat_slot_id, source_operation_id, amount_kopecks)
    SELECT v_case, (x->>'seat')::uuid, (x->>'op')::uuid, (x->>'amount')::bigint FROM jsonb_array_elements(p_lots) x;
  RETURN v_case;
END $fn$ LANGUAGE plpgsql;

-- §5.3 and §5.5 after the revision: excess of active seats covers dues of other active seats (keeping the
-- source collection, newest intention first); what remains is AMENDMENT_OVERPAYMENT; the money of seats
-- this amendment cancelled is CANCELLATION_SETTLEMENT, never offset (Q3). Collections are locked by id (R5).
CREATE FUNCTION fn_amendment_settle_money(p_amendment uuid) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE a purchase_amendment%ROWTYPE; src record; dst record; lot record; v_excess bigint; v_need bigint; v_amt bigint;
  v_lots jsonb := '[]'; v_case uuid;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE id = p_amendment;
  PERFORM 1 FROM bank_operation WHERE purchase_id = a.purchase_id AND kind = 'COLLECTION' ORDER BY id FOR UPDATE;
  FOR src IN SELECT c.seat_slot_id, c.price_kopecks FROM seat_slot_current c
              WHERE c.purchase_id = a.purchase_id AND c.line_status = 'ACTIVE' AND fn_seat_net(c.seat_slot_id) > c.price_kopecks
              ORDER BY c.position LOOP
    v_excess := fn_seat_net(src.seat_slot_id) - src.price_kopecks;
    FOR dst IN SELECT c.seat_slot_id, c.price_kopecks FROM seat_slot_current c
                WHERE c.purchase_id = a.purchase_id AND c.line_status = 'ACTIVE' AND c.state = 'CONFIRMED'
                  AND c.seat_slot_id <> src.seat_slot_id ORDER BY c.position LOOP
      EXIT WHEN v_excess <= 0;
      v_need := dst.price_kopecks - fn_seat_net(dst.seat_slot_id);
      CONTINUE WHEN v_need <= 0;
      FOR lot IN SELECT m.bank_operation_id, m.holding_kopecks - m.reserved_kopecks AS free FROM seat_money_lot m
                  WHERE m.seat_slot_id = src.seat_slot_id ORDER BY m.intended_at DESC, m.bank_operation_ref DESC LOOP
        v_amt := least(v_excess, v_need, lot.free);
        CONTINUE WHEN v_amt <= 0;
        INSERT INTO seat_money_transfer (amendment_id, source_operation_id, from_seat_slot_id, to_seat_slot_id, amount_kopecks)
          VALUES (a.id, lot.bank_operation_id, src.seat_slot_id, dst.seat_slot_id, v_amt);
        v_excess := v_excess - v_amt;
        v_need := v_need - v_amt;
        EXIT WHEN v_excess <= 0 OR v_need <= 0;
      END LOOP;
    END LOOP;
    -- What no other seat needed: refundable overpayment, from the newest collections first.
    FOR lot IN SELECT m.bank_operation_id, m.holding_kopecks - m.reserved_kopecks AS free FROM seat_money_lot m
                WHERE m.seat_slot_id = src.seat_slot_id ORDER BY m.intended_at DESC, m.bank_operation_ref DESC LOOP
      EXIT WHEN v_excess <= 0;
      v_amt := least(v_excess, lot.free);
      CONTINUE WHEN v_amt <= 0;
      v_lots := v_lots || jsonb_build_object('seat', src.seat_slot_id, 'op', lot.bank_operation_id, 'amount', v_amt);
      v_excess := v_excess - v_amt;
    END LOOP;
  END LOOP;
  PERFORM fn_amendment_case_open(a.id, 'AMENDMENT_OVERPAYMENT', false, v_lots);
  v_lots := '[]';
  FOR lot IN SELECT m.seat_slot_id, m.bank_operation_id, m.holding_kopecks - m.reserved_kopecks AS free
               FROM seat_money_lot m JOIN purchase_amendment_line l ON l.seat_slot_id = m.seat_slot_id AND l.amendment_id = a.id
               JOIN seat_slot s ON s.id = m.seat_slot_id
              WHERE l.line_status = 'CANCELLED' AND s.state = 'CANCELLED'
                AND s.state_changed_at >= a.committed_at
              ORDER BY s.position, m.intended_at DESC, m.bank_operation_ref DESC LOOP
    CONTINUE WHEN lot.free <= 0;
    v_lots := v_lots || jsonb_build_object('seat', lot.seat_slot_id, 'op', lot.bank_operation_id, 'amount', lot.free);
  END LOOP;
  v_case := fn_amendment_case_open(a.id, 'CANCELLATION_SETTLEMENT', a.termination_initiator = 'BUYER', v_lots);
  RETURN v_case;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_amendment_commit(p_amendment uuid, p_accepted_at timestamptz) RETURNS TABLE (revision int, case_id uuid)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE a purchase_amendment%ROWTYPE; prev purchase_revision%ROWTYPE; v_rev int; v_seats int; v_total bigint; l record; v_case uuid;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE id = p_amendment FOR UPDATE;
  SELECT r.* INTO prev FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
   WHERE p.id = a.purchase_id;
  v_rev := prev.revision + 1;
  INSERT INTO purchase_revision_line (purchase_id, revision, seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status)
    SELECT a.purchase_id, v_rev, seat_slot_id, ticket_type, pricing_basis_id, price_kopecks, line_status
      FROM purchase_amendment_line WHERE amendment_id = a.id;
  SELECT count(*) FILTER (WHERE line_status = 'ACTIVE'), coalesce(sum(price_kopecks) FILTER (WHERE line_status = 'ACTIVE'), 0)
    INTO v_seats, v_total FROM purchase_amendment_line WHERE amendment_id = a.id;
  INSERT INTO purchase_revision (purchase_id, revision, basis, document_order_id, amendment_id, candidate_hash, departure_id,
      departure_version, seats, unit_price_kopecks, total_kopecks, participant_refs, contract_snapshot_sha256, legal_release_ref,
      legal_release_hash, pd_consent_ref, pd_consent_hash, accepted_at, effective_at, recorded_at, revision_hash, slot_model, lines_sha256)
    VALUES (a.purchase_id, v_rev, a.basis, NULL, a.id, a.candidate_hash, prev.departure_id, prev.departure_version, v_seats,
      prev.unit_price_kopecks, v_total, '{}', prev.contract_snapshot_sha256, prev.legal_release_ref, prev.legal_release_hash,
      prev.pd_consent_ref, prev.pd_consent_hash, p_accepted_at, greatest(p_accepted_at, clock_timestamp()), clock_timestamp(),
      'sha256:' || repeat('0', 64), 'PRICED_SLOTS', fn_purchase_lines_sha256(a.purchase_id, v_rev));
  UPDATE purchase SET current_revision = v_rev WHERE id = a.purchase_id;
  UPDATE purchase_amendment SET state = 'COMMITTED', committed_revision = v_rev, committed_at = clock_timestamp(),
      committed_xact_id = pg_current_xact_id()
    WHERE id = a.id RETURNING * INTO a;
  FOR l IN SELECT x.seat_slot_id, x.ticket_type, x.line_status, x.ends_participant, s.state,
                  (SELECT pl.ticket_type FROM purchase_revision_line pl WHERE pl.purchase_id = a.purchase_id AND pl.revision = prev.revision
                     AND pl.seat_slot_id = x.seat_slot_id) AS old_type
             FROM purchase_amendment_line x JOIN seat_slot s ON s.id = x.seat_slot_id
            WHERE x.amendment_id = a.id ORDER BY s.position LOOP
    IF l.line_status = 'CANCELLED' AND l.state = 'CONFIRMED' THEN
      UPDATE seat_slot SET state = 'CANCELLED' WHERE id = l.seat_slot_id;
      INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason)
        VALUES (l.seat_slot_id, 'CONFIRMED', 'CANCELLED', a.initiated_by, a.basis || ' ' || a.amendment_ref);
    ELSIF l.ends_participant THEN
      UPDATE seat_participant SET ended_at = clock_timestamp(), end_reason = 'REPLACED' WHERE seat_slot_id = l.seat_slot_id AND ended_at IS NULL;
      PERFORM fn_seat_role_changed(l.seat_slot_id, NULL, NULL, true);
    ELSIF l.line_status = 'ACTIVE' AND l.old_type IS DISTINCT FROM l.ticket_type THEN
      PERFORM fn_seat_role_changed(l.seat_slot_id, l.old_type, l.ticket_type, false);
    END IF;
  END LOOP;
  v_case := fn_amendment_settle_money(a.id);
  RETURN QUERY SELECT v_rev, v_case;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 10. Amendment commands (§4): proposals by staff, consent and rejection by the buyer, recorded
--     cancellations, expiry by maintain().

CREATE FUNCTION fn_amendment_replay(p_purchase uuid, p_key text, p_request text) RETURNS purchase_amendment
STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE a purchase_amendment%ROWTYPE;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE purchase_id = p_purchase AND idempotency_key = p_key;
  IF FOUND AND a.request_sha256 <> p_request THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = '55000'; END IF;
  RETURN a;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_amendment_args(p_key text, p_link text, p_evidence text) RETURNS void
IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_.:-]{8,100}$' OR (p_link IS NOT NULL AND p_link !~ '^[0-9a-f]{64}$')
     OR (p_evidence IS NOT NULL AND p_evidence !~ '^[A-Za-z0-9_.:/#-]{1,200}$') THEN
    RAISE EXCEPTION 'AMENDMENT_INVALID' USING ERRCODE = '22023';
  END IF;
END $fn$ LANGUAGE plpgsql;

-- TICKET_TYPE_CORRECTION (§4, Q2): [{seatSlotRef, ticketType}], each by the seat's own frozen price grid; the
-- buyer's consent is required whatever the price does. Not a new sale: no minors' pause, no T−24; the
-- departure's age rules still apply; until the planned end of the trip (§4.1).
CREATE FUNCTION fn_amendment_propose_correction(p_admin_id uuid, p_purchase_ref text, p_changes jsonb, p_link_token_sha256 text,
  p_reason text, p_evidence_ref text, p_idempotency_key text)
RETURNS TABLE (amendment_ref text, candidate_hash text, expires_at timestamptz, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_by text := fn_staff_require(p_admin_id, 'amendment.record'); v_reason text := fn_staff_reason(p_reason);
  v_purchase uuid; a purchase_amendment%ROWTYPE; v_request text; v_lines jsonb; ch jsonb; c seat_slot_current%ROWTYPE;
  d departure%ROWTYPE; refusal text; v_price bigint; v_end timestamptz; i int;
BEGIN
  PERFORM fn_amendment_args(p_idempotency_key, p_link_token_sha256, p_evidence_ref);
  IF p_changes IS NULL OR jsonb_typeof(p_changes) <> 'array' OR jsonb_array_length(p_changes) = 0
     OR (SELECT count(DISTINCT x->>'seatSlotRef') FROM jsonb_array_elements(p_changes) x) <> jsonb_array_length(p_changes)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_changes) x WHERE jsonb_typeof(x) <> 'object'
                  OR coalesce(x->>'ticketType', '') NOT IN ('AGE_0_13', 'AGE_14_17', 'AGE_18_PLUS') OR x->>'seatSlotRef' IS NULL) THEN
    RAISE EXCEPTION 'AMENDMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_amendment_lock(v_purchase);
  v_request := encode(sha256(convert_to(jsonb_build_object('basis', 'TICKET_TYPE_CORRECTION',
    'changes', (SELECT jsonb_agg(x ORDER BY x->>'seatSlotRef') FROM jsonb_array_elements(p_changes) x),
    'link', p_link_token_sha256, 'reason', v_reason, 'evidence', p_evidence_ref)::text, 'UTF8')), 'hex');
  a := fn_amendment_replay(v_purchase, p_idempotency_key, v_request);
  IF a.id IS NOT NULL THEN RETURN QUERY SELECT a.amendment_ref, a.candidate_hash, a.expires_at, true; RETURN; END IF;
  refusal := fn_purchase_amendment_blocker(v_purchase, 'TICKET_TYPE_CORRECTION');
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT d2.* INTO d FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN departure d2 ON d2.id = r.departure_id WHERE p.id = v_purchase;
  v_end := fn_departure_planned_end(d.id);
  IF clock_timestamp() >= v_end THEN RAISE EXCEPTION 'SERVICE_PERIOD_ENDED' USING ERRCODE = '55000'; END IF;
  v_lines := fn_amendment_base_lines(v_purchase);
  FOR ch IN SELECT * FROM jsonb_array_elements(p_changes) LOOP
    SELECT * INTO c FROM seat_slot_current WHERE seat_slot_ref = ch->>'seatSlotRef' AND purchase_id = v_purchase;
    IF NOT FOUND OR c.state <> 'CONFIRMED' OR c.line_status <> 'ACTIVE' THEN
      RAISE EXCEPTION 'AMENDMENT_SEAT_NOT_ELIGIBLE' USING ERRCODE = '55000';
    END IF;
    IF c.ticket_type = ch->>'ticketType' THEN RAISE EXCEPTION 'AMENDMENT_NO_CHANGE' USING ERRCODE = '55000'; END IF;
    IF ch->>'ticketType' <> 'AGE_18_PLUS' AND NOT d.minors_allowed THEN RAISE EXCEPTION 'MINORS_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
    IF ch->>'ticketType' = 'AGE_0_13' AND coalesce(d.minor_min_age, 0) >= 14 THEN
      RAISE EXCEPTION 'TICKET_TYPE_NOT_ALLOWED' USING ERRCODE = '55000';
    END IF;
    v_price := fn_pricing_basis_price(c.pricing_basis_id, ch->>'ticketType');
    i := c.position - 1;
    v_lines := jsonb_set(jsonb_set(v_lines, ARRAY[i::text, 'type'], to_jsonb(ch->>'ticketType')), ARRAY[i::text, 'price'], to_jsonb(v_price));
  END LOOP;
  a := fn_amendment_create(v_purchase, 'TICKET_TYPE_CORRECTION', v_lines, 'BUYER_HASH', p_admin_id, v_by, v_reason, p_evidence_ref, NULL,
    p_link_token_sha256, p_idempotency_key, v_request, least(clock_timestamp() + interval '72 hours', v_end));
  RETURN QUERY SELECT a.amendment_ref, a.candidate_hash, a.expires_at, false;
END $fn$ LANGUAGE plpgsql;

-- PARTICIPANT_REPLACEMENT (§4): the person of a confirmed seat whose questionnaire was sent; same category;
-- buyer's consent; until the planned departure.
CREATE FUNCTION fn_amendment_propose_replacement(p_admin_id uuid, p_purchase_ref text, p_seat_slot_ref text, p_link_token_sha256 text,
  p_reason text, p_evidence_ref text, p_idempotency_key text)
RETURNS TABLE (amendment_ref text, candidate_hash text, expires_at timestamptz, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_by text := fn_staff_require(p_admin_id, 'amendment.record'); v_reason text := fn_staff_reason(p_reason);
  v_purchase uuid; a purchase_amendment%ROWTYPE; v_request text; v_lines jsonb; c seat_slot_current%ROWTYPE; refusal text;
  v_start timestamptz;
BEGIN
  PERFORM fn_amendment_args(p_idempotency_key, p_link_token_sha256, p_evidence_ref);
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_amendment_lock(v_purchase);
  v_request := encode(sha256(convert_to(jsonb_build_object('basis', 'PARTICIPANT_REPLACEMENT', 'seat', p_seat_slot_ref,
    'link', p_link_token_sha256, 'reason', v_reason, 'evidence', p_evidence_ref)::text, 'UTF8')), 'hex');
  a := fn_amendment_replay(v_purchase, p_idempotency_key, v_request);
  IF a.id IS NOT NULL THEN RETURN QUERY SELECT a.amendment_ref, a.candidate_hash, a.expires_at, true; RETURN; END IF;
  refusal := fn_purchase_amendment_blocker(v_purchase, 'PARTICIPANT_REPLACEMENT');
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT * INTO c FROM seat_slot_current WHERE seat_slot_ref = p_seat_slot_ref AND purchase_id = v_purchase;
  IF NOT FOUND OR c.state <> 'CONFIRMED' OR c.line_status <> 'ACTIVE' THEN RAISE EXCEPTION 'AMENDMENT_SEAT_NOT_ELIGIBLE' USING ERRCODE = '55000'; END IF;
  v_start := fn_departure_planned_start(c.departure_id);
  IF clock_timestamp() >= v_start THEN RAISE EXCEPTION 'SERVICE_PERIOD_ENDED' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM seat_participant WHERE seat_slot_id = c.seat_slot_id AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'REPLACEMENT_NOT_NEEDED' USING ERRCODE = '55000';
  END IF;
  v_lines := jsonb_set(fn_amendment_base_lines(v_purchase), ARRAY[(c.position - 1)::text, 'ends'], 'true'::jsonb);
  a := fn_amendment_create(v_purchase, 'PARTICIPANT_REPLACEMENT', v_lines, 'BUYER_HASH', p_admin_id, v_by, v_reason, p_evidence_ref, NULL,
    p_link_token_sha256, p_idempotency_key, v_request, least(clock_timestamp() + interval '72 hours', v_start));
  RETURN QUERY SELECT a.amendment_ref, a.candidate_hash, a.expires_at, false;
END $fn$ LANGUAGE plpgsql;

-- PARTIAL_CANCELLATION / FULL_TERMINATION (§4, §4.2): recorded by staff with the buyer's request or the
-- organizer's decision, effective at once; cancelling a companion's seat proceeds (v1.9.0 §3 п.5); the
-- cancelled seats' money goes to CANCELLATION_SETTLEMENT; until the planned end of the trip.
CREATE FUNCTION fn_amendment_record_cancellation(p_admin_id uuid, p_purchase_ref text, p_seat_slot_refs text[], p_initiator text,
  p_reason text, p_evidence_ref text, p_idempotency_key text)
RETURNS TABLE (amendment_ref text, basis text, revision int, case_ref text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_by text := fn_staff_require(p_admin_id, 'amendment.record'); v_reason text := fn_staff_reason(p_reason);
  v_purchase uuid; a purchase_amendment%ROWTYPE; v_request text; v_lines jsonb; refusal text; v_ref text; c seat_slot_current%ROWTYPE;
  v_basis text; v_active int; v_end timestamptz; v_case uuid; v_rev int;
BEGIN
  PERFORM fn_amendment_args(p_idempotency_key, NULL, p_evidence_ref);
  IF p_seat_slot_refs IS NULL OR cardinality(p_seat_slot_refs) = 0 OR array_position(p_seat_slot_refs, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(p_seat_slot_refs) x) <> cardinality(p_seat_slot_refs)
     OR p_initiator IS NULL OR p_initiator NOT IN ('BUYER', 'ORGANIZER') OR (p_initiator = 'BUYER' AND p_evidence_ref IS NULL) THEN
    RAISE EXCEPTION 'AMENDMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_amendment_lock(v_purchase);
  v_request := encode(sha256(convert_to(jsonb_build_object('basis', 'CANCELLATION', 'seats',
    (SELECT jsonb_agg(x ORDER BY x) FROM unnest(p_seat_slot_refs) x), 'initiator', p_initiator, 'reason', v_reason,
    'evidence', p_evidence_ref)::text, 'UTF8')), 'hex');
  a := fn_amendment_replay(v_purchase, p_idempotency_key, v_request);
  IF a.id IS NOT NULL THEN
    RETURN QUERY SELECT a.amendment_ref, a.basis, a.committed_revision,
      (SELECT k.case_ref FROM bank_settlement_case k WHERE k.amendment_id = a.id AND k.reason = 'CANCELLATION_SETTLEMENT'), true;
    RETURN;
  END IF;
  refusal := fn_purchase_amendment_blocker(v_purchase, 'PARTIAL_CANCELLATION');
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT fn_departure_planned_end(r.departure_id) INTO v_end FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id
     AND r.revision = p.current_revision WHERE p.id = v_purchase;
  IF clock_timestamp() >= v_end THEN RAISE EXCEPTION 'SERVICE_PERIOD_ENDED' USING ERRCODE = '55000'; END IF;
  v_lines := fn_amendment_base_lines(v_purchase);
  FOREACH v_ref IN ARRAY p_seat_slot_refs LOOP
    SELECT * INTO c FROM seat_slot_current WHERE seat_slot_ref = v_ref AND purchase_id = v_purchase;
    IF NOT FOUND OR c.state <> 'CONFIRMED' OR c.line_status <> 'ACTIVE' THEN RAISE EXCEPTION 'AMENDMENT_SEAT_NOT_ELIGIBLE' USING ERRCODE = '55000'; END IF;
    v_lines := jsonb_set(v_lines, ARRAY[(c.position - 1)::text, 'status'], '"CANCELLED"'::jsonb);
  END LOOP;
  SELECT count(*) INTO v_active FROM jsonb_array_elements(v_lines) x WHERE x->>'status' = 'ACTIVE';
  v_basis := CASE WHEN v_active = 0 THEN 'FULL_TERMINATION' ELSE 'PARTIAL_CANCELLATION' END;
  a := fn_amendment_create(v_purchase, v_basis, v_lines, 'STAFF_RECORDED', p_admin_id, v_by, v_reason, p_evidence_ref, p_initiator,
    NULL, p_idempotency_key, v_request, NULL);
  SELECT x.revision, x.case_id INTO v_rev, v_case FROM fn_amendment_commit(a.id, clock_timestamp()) x;
  RETURN QUERY SELECT a.amendment_ref, v_basis, v_rev, (SELECT k.case_ref FROM bank_settlement_case k WHERE k.id = v_case), false;
END $fn$ LANGUAGE plpgsql;

-- The buyer (own session of 0023, or the amendment's one-time link) answers the proposal.
CREATE FUNCTION fn_amendment_buyer(a purchase_amendment, p_session_token_sha256 text, p_link_token_sha256 text) RETURNS text
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_link_token_sha256 IS NOT NULL AND a.link_token_sha256 = p_link_token_sha256 THEN RETURN 'AMENDMENT_LINK'; END IF;
  IF p_session_token_sha256 IS NOT NULL
     AND fn_purchase_session_owns((SELECT purchase_ref FROM purchase WHERE id = a.purchase_id), p_session_token_sha256) THEN
    RETURN 'BUYER_SESSION';
  END IF;
  RAISE EXCEPTION 'PURCHASE_NOT_OWNED' USING ERRCODE = '42501';
END $fn$ LANGUAGE plpgsql;

-- Consent (§2.1 п.2, §2.4): returns COMMITTED / REPLAYED / STALE / EXPIRED / NOT_OPEN as a value, so a
-- closing refusal is kept; refusals that change nothing raise.
CREATE FUNCTION fn_amendment_consent(p_amendment_ref text, p_candidate_hash text, p_session_token_sha256 text, p_link_token_sha256 text)
RETURNS TABLE (result text, amendment_ref text, consent_ref text, revision int)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE a purchase_amendment%ROWTYPE; v_channel text; v_now jsonb; refusal text; v_consent text; v_rev int;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE amendment_ref = p_amendment_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'AMENDMENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  v_channel := fn_amendment_buyer(a, p_session_token_sha256, p_link_token_sha256);
  PERFORM fn_amendment_lock(a.purchase_id);
  SELECT * INTO a FROM purchase_amendment WHERE id = a.id FOR UPDATE;
  SELECT c.consent_ref INTO v_consent FROM purchase_amendment_consent c WHERE c.amendment_id = a.id AND c.candidate_hash = p_candidate_hash;
  IF a.state = 'COMMITTED' AND v_consent IS NOT NULL THEN
    RETURN QUERY SELECT 'REPLAYED', a.amendment_ref, v_consent, a.committed_revision; RETURN;
  END IF;
  IF a.state <> 'OPEN' OR a.consent_mode <> 'BUYER_HASH' THEN
    RETURN QUERY SELECT 'NOT_OPEN', a.amendment_ref, NULL::text, NULL::int; RETURN;
  END IF;
  IF clock_timestamp() >= a.expires_at THEN
    UPDATE purchase_amendment SET state = 'CLOSED', closed_reason = 'EXPIRED', closed_at = clock_timestamp(), closed_by = 'buyer' WHERE id = a.id;
    RETURN QUERY SELECT 'EXPIRED', a.amendment_ref, NULL::text, NULL::int; RETURN;
  END IF;
  v_now := fn_amendment_candidate(a.purchase_id, a.basis, fn_amendment_stored_lines(a.id), a.expires_at);
  IF p_candidate_hash IS DISTINCT FROM a.candidate_hash OR fn_amendment_hash(v_now) <> a.candidate_hash THEN
    UPDATE purchase_amendment SET state = 'CLOSED', closed_reason = 'STALE', closed_at = clock_timestamp(), closed_by = 'buyer' WHERE id = a.id;
    RETURN QUERY SELECT 'STALE', a.amendment_ref, NULL::text, NULL::int; RETURN;
  END IF;
  refusal := fn_purchase_amendment_blocker(a.purchase_id, a.basis);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  INSERT INTO purchase_amendment_consent (consent_ref, amendment_id, candidate_hash, channel)
    VALUES (fn_new_ref('ac'), a.id, a.candidate_hash, v_channel) RETURNING consent_ref INTO v_consent;
  SELECT x.revision INTO v_rev FROM fn_amendment_commit(a.id, clock_timestamp()) x;
  RETURN QUERY SELECT 'COMMITTED', a.amendment_ref, v_consent, v_rev;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_amendment_reject(p_amendment_ref text, p_session_token_sha256 text, p_link_token_sha256 text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE a purchase_amendment%ROWTYPE;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE amendment_ref = p_amendment_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'AMENDMENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM fn_amendment_buyer(a, p_session_token_sha256, p_link_token_sha256);
  PERFORM fn_amendment_lock(a.purchase_id);
  SELECT * INTO a FROM purchase_amendment WHERE id = a.id FOR UPDATE;
  IF a.state <> 'OPEN' THEN RETURN 'NOT_OPEN'; END IF;
  UPDATE purchase_amendment SET state = 'CLOSED', closed_reason = 'REJECTED', closed_at = clock_timestamp(), closed_by = 'buyer' WHERE id = a.id;
  RETURN 'REJECTED';
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_amendment_withdraw(p_admin_id uuid, p_amendment_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'amendment.record'); v_reason text := fn_staff_reason(p_reason);
  a purchase_amendment%ROWTYPE;
BEGIN
  SELECT * INTO a FROM purchase_amendment WHERE amendment_ref = p_amendment_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'AMENDMENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM fn_amendment_lock(a.purchase_id);
  SELECT * INTO a FROM purchase_amendment WHERE id = a.id FOR UPDATE;
  IF a.state <> 'OPEN' THEN RAISE EXCEPTION 'AMENDMENT_NOT_OPEN' USING ERRCODE = '55000'; END IF;
  UPDATE purchase_amendment SET state = 'CLOSED', closed_reason = 'WITHDRAWN', closed_at = clock_timestamp(),
      closed_by = left(v_by || ': ' || v_reason, 120) WHERE id = a.id;
END $fn$ LANGUAGE plpgsql;

-- maintain(): proposals past their time close EXPIRED, each under its purchase's locks, its own statement.
CREATE FUNCTION fn_amendments_close_due() RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_id uuid; a purchase_amendment%ROWTYPE; v_n int := 0;
BEGIN
  FOR v_id IN SELECT id FROM purchase_amendment WHERE state = 'OPEN' AND expires_at <= clock_timestamp() ORDER BY created_at LOOP
    SELECT * INTO a FROM purchase_amendment WHERE id = v_id;
    PERFORM fn_amendment_lock(a.purchase_id);
    SELECT * INTO a FROM purchase_amendment WHERE id = v_id FOR UPDATE;
    CONTINUE WHEN a.state <> 'OPEN' OR a.expires_at > clock_timestamp();
    UPDATE purchase_amendment SET state = 'CLOSED', closed_reason = 'EXPIRED', closed_at = clock_timestamp(), closed_by = 'maintain'
     WHERE id = v_id;
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 11. Lot-based settlement (§5.5): refunds by lot through the source collection, OWNER retentions,
--     automatic closing, contradicted refunds.

CREATE FUNCTION fn_settlement_case_try_close(p_case uuid, p_by text) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE k bank_settlement_case%ROWTYPE; v_retained boolean;
BEGIN
  SELECT * INTO k FROM bank_settlement_case WHERE id = p_case FOR UPDATE;
  IF k.resolved_at IS NOT NULL OR k.amendment_id IS NULL OR NOT fn_settlement_case_closable(p_case) THEN RETURN false; END IF;
  v_retained := EXISTS (SELECT 1 FROM settlement_lot_retention t JOIN settlement_case_lot l ON l.id = t.lot_id WHERE l.case_id = p_case);
  UPDATE bank_settlement_case SET resolved_at = clock_timestamp(), resolved_by = left(p_by, 120),
      resolution = CASE WHEN v_retained THEN 'OWNER_DECISION' ELSE 'REFUNDED' END,
      resolution_reason = CASE WHEN v_retained THEN 'ALL_LOTS_EXECUTED_WITH_RETENTION' ELSE 'ALL_LOTS_REFUNDED' END
    WHERE id = p_case;
  RETURN true;
END $fn$ LANGUAGE plpgsql;

-- Locks a lot-based case for a money command: the purchase's departure and document order (R1–R2), the case,
-- then the collection (R5).
CREATE FUNCTION fn_settlement_case_lock(p_case_ref text) RETURNS bank_settlement_case
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE k bank_settlement_case%ROWTYPE;
BEGIN
  SELECT * INTO k FROM bank_settlement_case WHERE case_ref = p_case_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_CASE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM fn_amendment_lock(k.purchase_id);
  SELECT * INTO k FROM bank_settlement_case WHERE id = k.id FOR UPDATE;
  RETURN k;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_settlement_refund_open(p_admin_id uuid, p_case_ref text, p_collection_ref text, p_amount_kopecks bigint, p_reason text)
RETURNS text SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  k bank_settlement_case%ROWTYPE; c bank_operation%ROWTYPE; v_remaining bigint; v_refunded bigint; v_ref text := fn_new_ref('bo');
BEGIN
  k := fn_settlement_case_lock(p_case_ref);
  IF k.amendment_id IS NULL THEN RAISE EXCEPTION 'SETTLEMENT_CASE_NOT_LOT_BASED' USING ERRCODE = '55000'; END IF;
  IF k.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'SETTLEMENT_CASE_ALREADY_RESOLVED' USING ERRCODE = '55000'; END IF;
  SELECT * INTO c FROM bank_operation WHERE bank_operation_ref = p_collection_ref FOR UPDATE;
  IF NOT FOUND OR c.kind <> 'COLLECTION' OR c.status <> 'SUCCEEDED' OR c.purchase_id <> k.purchase_id
     OR NOT EXISTS (SELECT 1 FROM settlement_case_lot WHERE case_id = k.id AND source_operation_id = c.id) THEN
    RAISE EXCEPTION 'REFUND_SOURCE_INVALID' USING ERRCODE = '55000';
  END IF;
  IF fn_collection_frozen(c.id) THEN RAISE EXCEPTION 'REFUND_CONTRADICTION_PENDING' USING ERRCODE = '55000'; END IF;
  -- Limit 3: the case's lots on X not executed yet, less what the case's refunds through X still hold.
  SELECT coalesce(sum(l.amount_kopecks - fn_settlement_lot_executed(l.id)), 0) INTO v_remaining
    FROM settlement_case_lot l WHERE l.case_id = k.id AND l.source_operation_id = c.id;
  v_remaining := v_remaining - fn_settlement_case_reserve(k.id, c.id, NULL);
  -- Limit 1: never beyond what the collection received.
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_refunded FROM bank_operation WHERE refunds_operation_id = c.id AND status <> 'FAILED';
  IF p_amount_kopecks IS NULL OR p_amount_kopecks <= 0 OR p_amount_kopecks > v_remaining
     OR v_refunded + p_amount_kopecks > c.amount_kopecks THEN
    RAISE EXCEPTION 'REFUND_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, refunds_operation_id, provider, merchant_account,
      amount_kopecks, currency, status, created_by, reason, settlement_case_id)
    VALUES (v_ref, 'REFUND', c.purchase_id, c.id, c.provider, c.merchant_account, p_amount_kopecks, c.currency, 'INTENDED', v_by, v_reason, k.id);
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- A confirmed refund of a case is allocated to the case's lots on its collection (limit 2 by the lot guard).
CREATE FUNCTION fn_settlement_refund_apply(p_refund uuid) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r bank_operation%ROWTYPE; l record; v_left bigint; v_put bigint;
BEGIN
  SELECT * INTO r FROM bank_operation WHERE id = p_refund;
  PERFORM 1 FROM bank_operation WHERE id = r.refunds_operation_id FOR UPDATE;
  v_left := r.amount_kopecks - coalesce((SELECT sum(amount_kopecks) FROM bank_refund_allocation WHERE refund_operation_id = r.id), 0);
  FOR l IN SELECT x.id, x.seat_slot_id, x.amount_kopecks - fn_settlement_lot_executed(x.id) AS free FROM settlement_case_lot x
            WHERE x.case_id = r.settlement_case_id AND x.source_operation_id = r.refunds_operation_id ORDER BY x.id LOOP
    EXIT WHEN v_left <= 0;
    v_put := least(v_left, l.free);
    CONTINUE WHEN v_put <= 0;
    INSERT INTO bank_refund_allocation (refund_operation_id, seat_slot_id, settlement_case_id, settlement_case_lot_id, amount_kopecks, allocated_by)
      VALUES (r.id, l.seat_slot_id, CASE WHEN l.seat_slot_id IS NULL THEN r.settlement_case_id END, l.id, v_put, 'refund');
    v_left := v_left - v_put;
  END LOOP;
  IF v_left > 0 THEN RAISE EXCEPTION 'REFUND_ALLOCATION_EXCEEDS' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_settlement_lot_retain(p_admin_id uuid, p_case_ref text, p_lot_id bigint, p_amount_kopecks bigint, p_legal_basis text,
  p_evidence_ref text) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_basis text := fn_staff_reason(p_legal_basis);
  k bank_settlement_case%ROWTYPE; l settlement_case_lot%ROWTYPE;
BEGIN
  k := fn_settlement_case_lock(p_case_ref);
  SELECT * INTO l FROM settlement_case_lot WHERE id = p_lot_id AND case_id = k.id;
  IF NOT FOUND OR k.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'SETTLEMENT_LOT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM 1 FROM bank_operation WHERE id = l.source_operation_id FOR UPDATE;
  IF p_evidence_ref IS NULL OR p_evidence_ref !~ '^[A-Za-z0-9_.:/#-]{1,200}$' OR p_amount_kopecks IS NULL OR p_amount_kopecks <= 0 THEN
    RAISE EXCEPTION 'RETENTION_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO settlement_lot_retention (lot_id, amount_kopecks, legal_basis, evidence_ref, retained_by)
    VALUES (l.id, p_amount_kopecks, v_basis, p_evidence_ref, v_by);
  RETURN fn_settlement_case_try_close(k.id, v_by);
END $fn$ LANGUAGE plpgsql;

-- The resolution of a contradicted refund R1 (§5.5): the remaining lot first, then the retentions the bank
-- in fact refunded (reversed, newest first), the rest an over-refund with the OWNER's decision.
CREATE FUNCTION fn_refund_contradiction_resolve(p_admin_id uuid, p_case_ref text, p_reason text, p_decision text)
RETURNS TABLE (to_lot bigint, retention_reversed bigint, over_refund bigint)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  k bank_settlement_case%ROWTYPE; r1 bank_operation%ROWTYPE; l record; t record; v_left bigint; v_put bigint; v_to bigint := 0;
  v_rev bigint := 0; v_over bigint;
BEGIN
  k := fn_settlement_case_lock(p_case_ref);
  IF k.reason <> 'REFUND_CONTRADICTED' THEN RAISE EXCEPTION 'SETTLEMENT_CASE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF k.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'SETTLEMENT_CASE_ALREADY_RESOLVED' USING ERRCODE = '55000'; END IF;
  SELECT * INTO r1 FROM bank_operation WHERE id = k.bank_operation_id FOR UPDATE;
  PERFORM 1 FROM bank_operation WHERE id = r1.refunds_operation_id FOR UPDATE;
  PERFORM fn_bank_operation_apply_locked(r1.id);
  IF (SELECT application_due FROM bank_operation WHERE id = r1.id) IS NOT NULL
     OR fn_settlement_case_reserve(r1.settlement_case_id, r1.refunds_operation_id, r1.id) > 0 THEN
    RAISE EXCEPTION 'REFUND_CONTRADICTION_WAITING' USING ERRCODE = '55000';
  END IF;
  IF p_decision IS NOT NULL AND p_decision NOT IN ('CLAIM', 'WRITE_OFF') THEN RAISE EXCEPTION 'RETENTION_INVALID' USING ERRCODE = '22023'; END IF;
  v_left := r1.amount_kopecks;
  -- 1. The lot's unexecuted remainder.
  FOR l IN SELECT x.id, x.seat_slot_id, x.amount_kopecks - fn_settlement_lot_executed(x.id) AS free FROM settlement_case_lot x
            WHERE x.case_id = r1.settlement_case_id AND x.source_operation_id = r1.refunds_operation_id ORDER BY x.id LOOP
    v_put := least(v_left, l.free);
    CONTINUE WHEN v_put <= 0;
    INSERT INTO bank_refund_allocation (refund_operation_id, seat_slot_id, settlement_case_id, settlement_case_lot_id, amount_kopecks, allocated_by)
      VALUES (r1.id, l.seat_slot_id, CASE WHEN l.seat_slot_id IS NULL THEN r1.settlement_case_id END, l.id, v_put, v_by);
    v_left := v_left - v_put;
    v_to := v_to + v_put;
  END LOOP;
  -- 2. Retentions the bank refunded after all: reversed, newest first, and R1 allocated to their lots.
  FOR t IN SELECT x.id, x.lot_id, s.seat_slot_id, x.amount_kopecks
                  - coalesce((SELECT sum(v.amount_kopecks) FROM settlement_lot_retention_reversal v WHERE v.retention_id = x.id), 0) AS active
             FROM settlement_lot_retention x JOIN settlement_case_lot s ON s.id = x.lot_id
            WHERE s.case_id = r1.settlement_case_id AND s.source_operation_id = r1.refunds_operation_id
            ORDER BY x.retained_at DESC, x.id DESC LOOP
    EXIT WHEN v_left <= 0;
    v_put := least(v_left, t.active);
    CONTINUE WHEN v_put <= 0;
    INSERT INTO settlement_lot_retention_reversal (retention_id, amount_kopecks, refund_operation_id, contradiction_case_id, reversed_by)
      VALUES (t.id, v_put, r1.id, k.id, v_by);
    INSERT INTO bank_refund_allocation (refund_operation_id, seat_slot_id, settlement_case_id, settlement_case_lot_id, amount_kopecks, allocated_by)
      VALUES (r1.id, t.seat_slot_id, CASE WHEN t.seat_slot_id IS NULL THEN r1.settlement_case_id END, t.lot_id, v_put, v_by);
    v_left := v_left - v_put;
    v_rev := v_rev + v_put;
  END LOOP;
  -- 3. Beyond the lot: an over-refund outside the seats, on the OWNER's decision (claim or write-off).
  v_over := v_left;
  IF v_over > 0 THEN
    IF p_decision IS NULL THEN RAISE EXCEPTION 'REFUND_CONTRADICTION_DECISION_REQUIRED' USING ERRCODE = '55000'; END IF;
    PERFORM fn_bank_refund_allocate(r1.id, v_over, NULL, k.id, v_by);
  END IF;
  UPDATE bank_settlement_case SET contradiction_to_lot = v_to, contradiction_retention_reversed = v_rev, contradiction_over_refund = v_over,
      contradiction_decision = CASE WHEN v_over > 0 THEN p_decision END, resolved_at = clock_timestamp(), resolved_by = v_by,
      resolution = 'OWNER_DECISION', resolution_reason = v_reason
    WHERE id = k.id;
  PERFORM fn_settlement_case_try_close(r1.settlement_case_id, v_by);
  RETURN QUERY SELECT v_to, v_rev, v_over;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 12. 0022/0026 functions under the new rules.

-- 0022's application, same signature: a confirmed refund of a lot case is allocated to its lots; a
-- contradicted one only records NONE (its split is the contradiction's resolution); collections as in 0026.
CREATE OR REPLACE FUNCTION fn_bank_operation_apply_locked(p_operation uuid) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE op bank_operation%ROWTYPE; h seat_hold%ROWTYPE; v_purchase_ref text; v_confirmed int := 0; v_no_seat int := 0;
  v_effect text; v_case uuid; v_was_open boolean;
BEGIN
  SELECT * INTO op FROM bank_operation WHERE id = p_operation;
  IF op.application_due IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM bank_operation_application WHERE bank_operation_id = op.id AND outcome = op.application_due) THEN
    UPDATE bank_operation SET application_due = NULL, application_error = NULL WHERE id = op.id;
    RETURN;
  END IF;
  IF op.kind = 'REFUND' THEN
    BEGIN
      IF op.contradicted_at IS NULL THEN PERFORM fn_settlement_refund_apply(op.id); END IF;
      INSERT INTO bank_operation_application (bank_operation_id, outcome, seat_effect, confirmed, no_seat, settlement_case_id)
        VALUES (op.id, op.application_due, 'NONE', 0, 0, op.settlement_case_id);
      UPDATE bank_operation SET application_due = NULL, application_error = NULL WHERE id = op.id;
      -- The last outcome of the case closes it (I-22 (б)), once this application is no longer due.
      IF op.contradicted_at IS NULL THEN PERFORM fn_settlement_case_try_close(op.settlement_case_id, 'refund'); END IF;
    EXCEPTION WHEN OTHERS THEN
      UPDATE bank_operation SET application_error = left(SQLSTATE || ' ' || SQLERRM, 500) WHERE id = op.id;
    END;
    RETURN;
  END IF;
  SELECT purchase_ref INTO v_purchase_ref FROM purchase WHERE id = op.purchase_id;
  SELECT * INTO h FROM seat_hold WHERE id = op.seat_hold_id;
  v_was_open := h.closed_at IS NULL;
  BEGIN
    IF op.purpose = 'BALANCE' THEN
      v_effect := 'NONE';
      IF op.application_due = 'SUCCEEDED' THEN v_case := fn_bank_operation_allocate(op.id); END IF;
    ELSIF op.application_due = 'SUCCEEDED' THEN
      BEGIN
        SELECT c.confirmed, c.no_seat INTO v_confirmed, v_no_seat FROM fn_purchase_payment_confirmed(v_purchase_ref, op.bank_operation_ref) c;
        v_effect := CASE WHEN v_was_open THEN 'SEATS_CONFIRMED' WHEN v_no_seat > 0 THEN 'PAID_NO_SEAT' ELSE 'LATE_CONFIRMED' END;
        IF v_no_seat > 0 THEN v_case := fn_bank_settlement_open(op.id, 'PAID_NO_SEAT'); END IF;
        v_case := coalesce(fn_bank_operation_allocate(op.id), v_case);
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM NOT IN ('PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS') THEN RAISE; END IF;
        v_effect := SQLERRM;
        v_case := fn_bank_settlement_open(op.id, SQLERRM);
      END;
    ELSIF v_was_open AND h.attempt_ref = op.bank_operation_ref THEN
      PERFORM fn_purchase_payment_failed(v_purchase_ref, op.bank_operation_ref);
      v_effect := 'SEATS_RELEASED';
    ELSE
      v_effect := 'NONE';
    END IF;
    INSERT INTO bank_operation_application (bank_operation_id, outcome, seat_effect, confirmed, no_seat, settlement_case_id)
      VALUES (op.id, op.application_due, v_effect, v_confirmed, v_no_seat, v_case);
    UPDATE bank_operation SET application_due = NULL, application_error = NULL WHERE id = op.id;
  EXCEPTION WHEN OTHERS THEN
    UPDATE bank_operation SET application_error = left(SQLSTATE || ' ' || SQLERRM, 500) WHERE id = op.id;
  END;
END $fn$ LANGUAGE plpgsql;

-- 0022's refund open, same signature and limit: now under the purchase's locks (R4–R5), and never for money a
-- lot-based case or a contradiction holds (those refunds go through fn_settlement_refund_open).
CREATE OR REPLACE FUNCTION fn_bank_refund_open(p_admin_id uuid, p_collection_ref text, p_amount_kopecks bigint, p_reason text)
RETURNS text SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  c bank_operation%ROWTYPE; v_refunded bigint; v_ref text := fn_new_ref('bo');
BEGIN
  SELECT * INTO c FROM bank_operation WHERE bank_operation_ref = p_collection_ref;
  IF NOT FOUND OR c.kind <> 'COLLECTION' OR c.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'REFUND_SOURCE_INVALID' USING ERRCODE = '55000';
  END IF;
  PERFORM fn_amendment_lock(c.purchase_id);
  SELECT * INTO c FROM bank_operation WHERE id = c.id FOR UPDATE;
  IF fn_collection_frozen(c.id) OR EXISTS (SELECT 1 FROM settlement_case_lot l JOIN bank_settlement_case k ON k.id = l.case_id
                                            WHERE l.source_operation_id = c.id AND k.resolved_at IS NULL) THEN
    RAISE EXCEPTION 'REFUND_SOURCE_UNDER_SETTLEMENT' USING ERRCODE = '55000';
  END IF;
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_refunded FROM bank_operation
   WHERE refunds_operation_id = c.id AND status <> 'FAILED';
  IF p_amount_kopecks IS NULL OR p_amount_kopecks <= 0 OR v_refunded + p_amount_kopecks > c.amount_kopecks THEN
    RAISE EXCEPTION 'REFUND_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, refunds_operation_id, provider, merchant_account,
      amount_kopecks, currency, status, created_by, reason)
    VALUES (v_ref, 'REFUND', c.purchase_id, c.id, c.provider, c.merchant_account, p_amount_kopecks, c.currency, 'INTENDED', v_by, v_reason);
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- 0022's resolution, same signature: only for 0022/0026 reasons; a lot-based case is closed by its lots'
-- outcomes, a contradiction by its own resolution.
CREATE OR REPLACE FUNCTION fn_bank_settlement_resolve(p_admin_id uuid, p_case_ref text, p_resolution text, p_refund_ref text, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  k bank_settlement_case%ROWTYPE; r bank_operation%ROWTYPE; c bank_operation%ROWTYPE;
BEGIN
  SELECT * INTO k FROM bank_settlement_case WHERE case_ref = p_case_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_CASE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF k.reason IN ('AMENDMENT_OVERPAYMENT', 'CANCELLATION_SETTLEMENT') THEN
    RAISE EXCEPTION 'SETTLEMENT_CASE_LOT_BASED' USING ERRCODE = '55000';
  END IF;
  IF k.reason = 'REFUND_CONTRADICTED' THEN
    RAISE EXCEPTION 'REFUND_CONTRADICTED_REQUIRES_SPECIAL_RESOLUTION' USING ERRCODE = '55000';
  END IF;
  IF k.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'SETTLEMENT_CASE_ALREADY_RESOLVED' USING ERRCODE = '55000'; END IF;
  IF p_resolution = 'REFUNDED' THEN
    SELECT * INTO c FROM bank_operation WHERE id = k.bank_operation_id;
    SELECT * INTO r FROM bank_operation WHERE bank_operation_ref = p_refund_ref;
    IF NOT FOUND OR r.kind <> 'REFUND' OR r.status <> 'SUCCEEDED' OR r.refunds_operation_id <> k.bank_operation_id THEN
      RAISE EXCEPTION 'REFUND_NOT_CONFIRMED' USING ERRCODE = '55000';
    END IF;
    IF k.reason = 'PAID_NO_SEAT' THEN
      IF EXISTS (SELECT 1 FROM seat_slot_event e JOIN seat_slot s ON s.id = e.seat_slot_id
                  WHERE e.bank_operation_ref = c.bank_operation_ref AND e.to_state = 'PAID_NO_SEAT_EXCEPTION'
                    AND NOT EXISTS (SELECT 1 FROM bank_refund_allocation a WHERE a.seat_slot_id = s.id))
         OR NOT EXISTS (SELECT 1 FROM bank_refund_allocation a WHERE a.refund_operation_id = r.id AND a.seat_slot_id IS NOT NULL) THEN
        RAISE EXCEPTION 'REFUND_INSUFFICIENT' USING ERRCODE = '55000';
      END IF;
    ELSE
      PERFORM fn_bank_refund_allocate(r.id, c.amount_kopecks, NULL, k.id, v_by);
    END IF;
  ELSIF p_resolution IS DISTINCT FROM 'OWNER_DECISION' OR p_refund_ref IS NOT NULL THEN
    RAISE EXCEPTION 'SETTLEMENT_RESOLUTION_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE bank_settlement_case SET resolved_at = clock_timestamp(), resolved_by = v_by, resolution = p_resolution,
      resolution_reason = v_reason, refund_operation_id = r.id
    WHERE id = k.id;
END $fn$ LANGUAGE plpgsql;

-- 0026's open with a purpose, same signature: the replay first; then no new payment while an amendment is
-- consented and pending or a contradiction freezes the money (§5.7); the windows are the current revision's
-- frozen deadlines (§5.6).
CREATE OR REPLACE FUNCTION fn_bank_operation_open_payment(p_purchase_ref text, p_session_token_sha256 text, p_provider text,
  p_merchant_account text, p_legal_release_ref text, p_legal_release_hash text, p_pd_consent_ref text, p_pd_consent_hash text,
  p_purpose text)
RETURNS TABLE (bank_operation_ref text, hold_ref text, amount_kopecks bigint, currency text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_purchase uuid; h seat_hold%ROWTYPE; op bank_operation%ROWTYPE; refusal text; o orders%ROWTYPE; rv purchase_revision%ROWTYPE;
  v_amount bigint; v_total bigint; v_deposit bigint;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_-]{1,30}$'
     OR p_merchant_account IS NULL OR p_merchant_account !~ '^[A-Za-z0-9_.:-]{1,100}$'
     OR p_purpose IS NULL OR p_purpose NOT IN ('FULL', 'DEPOSIT', 'BALANCE') THEN
    RAISE EXCEPTION 'BANK_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_purchase_lock_departure(v_purchase);
  SELECT o2.* INTO o FROM purchase p JOIN orders o2 ON o2.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o2;
  SELECT r.* INTO rv FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
   WHERE p.id = v_purchase;

  IF p_purpose = 'BALANCE' THEN
    SELECT * INTO op FROM bank_operation b WHERE b.purchase_id = v_purchase AND b.purpose = 'BALANCE'
       AND b.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') FOR UPDATE;
    IF FOUND THEN
      IF op.provider = p_provider AND op.merchant_account = p_merchant_account THEN
        RETURN QUERY SELECT op.bank_operation_ref, NULL::text, op.amount_kopecks, op.currency, true;
        RETURN;
      END IF;
      RAISE EXCEPTION 'BALANCE_PAYMENT_IN_FLIGHT' USING ERRCODE = '55000';
    END IF;
    refusal := fn_purchase_payment_blocker(v_purchase);
    IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
    IF EXISTS (SELECT 1 FROM bank_operation b WHERE b.purchase_id = v_purchase AND b.application_due IS NOT NULL) THEN
      RAISE EXCEPTION 'BALANCE_APPLICATION_PENDING' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (SELECT 1 FROM bank_settlement_case k WHERE k.purchase_id = v_purchase AND k.resolved_at IS NULL
                AND k.reason <> 'PAID_NO_SEAT') THEN
      RAISE EXCEPTION 'BALANCE_SETTLEMENT_PENDING' USING ERRCODE = '55000';
    END IF;
    IF clock_timestamp() >= coalesce(rv.balance_due_at, fn_departure_cutoff(rv.departure_id)) THEN
      RAISE EXCEPTION 'BALANCE_WINDOW_CLOSED' USING ERRCODE = '55000';
    END IF;
    PERFORM 1 FROM seat_slot WHERE purchase_id = v_purchase ORDER BY id FOR UPDATE;
    SELECT coalesce(sum(m.balance_due_kopecks), 0) INTO v_amount FROM seat_money m WHERE m.purchase_id = v_purchase;
    IF v_amount <= 0 THEN RAISE EXCEPTION 'NOTHING_DUE' USING ERRCODE = '55000'; END IF;
    INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, seat_hold_id, provider, merchant_account, amount_kopecks,
        currency, status, created_by, purpose)
      VALUES (fn_new_ref('bo'), 'COLLECTION', v_purchase, NULL, p_provider, p_merchant_account, v_amount, 'RUB', 'INTENDED', 'payment', 'BALANCE')
      RETURNING * INTO op;
    RETURN QUERY SELECT op.bank_operation_ref, NULL::text, op.amount_kopecks, op.currency, false;
    RETURN;
  END IF;

  SELECT * INTO h FROM seat_hold s WHERE s.purchase_id = v_purchase AND s.closed_at IS NULL FOR UPDATE;
  IF FOUND AND h.fenced_at IS NOT NULL THEN
    SELECT * INTO op FROM bank_operation b WHERE b.seat_hold_id = h.id;
    IF FOUND AND op.provider = p_provider AND op.merchant_account = p_merchant_account
       AND coalesce(op.purpose, 'FULL') = p_purpose THEN
      RETURN QUERY SELECT op.bank_operation_ref, h.hold_ref, op.amount_kopecks, op.currency, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'HOLD_ALREADY_FENCED' USING ERRCODE = '55000';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOLD_NOT_OPEN' USING ERRCODE = '55000'; END IF;
  refusal := fn_purchase_payment_blocker(v_purchase);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  IF o.status <> 'RESERVED' OR o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_CLOSED' USING ERRCODE = '55000';
  END IF;
  refusal := fn_purchase_terms_refusal(v_purchase, p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT sum(m.price_kopecks), sum(m.deposit_kopecks) INTO v_total, v_deposit FROM seat_money m WHERE m.purchase_id = v_purchase;
  IF p_purpose = 'DEPOSIT' THEN
    IF clock_timestamp() >= coalesce(rv.deposit_until, fn_departure_deposit_cutoff(rv.departure_id)) THEN
      RAISE EXCEPTION 'DEPOSIT_WINDOW_CLOSED' USING ERRCODE = '55000';
    END IF;
    IF v_deposit >= v_total THEN RAISE EXCEPTION 'DEPOSIT_NOT_AVAILABLE' USING ERRCODE = '55000'; END IF;
    v_amount := v_deposit;
  ELSE
    v_amount := v_total;
  END IF;
  INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, seat_hold_id, provider, merchant_account, amount_kopecks,
      currency, status, created_by, purpose)
    VALUES (fn_new_ref('bo'), 'COLLECTION', v_purchase, h.id, p_provider, p_merchant_account, v_amount, 'RUB', 'INTENDED', 'payment', p_purpose)
    RETURNING * INTO op;
  PERFORM fn_purchase_hold_fence(p_purchase_ref, op.bank_operation_ref);
  RETURN QUERY SELECT op.bank_operation_ref, h.hold_ref, op.amount_kopecks, op.currency, false;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 13. Privileges. No personal data in any of these objects.

REVOKE ALL ON purchase_amendment, purchase_amendment_line, purchase_amendment_consent, seat_money_transfer, settlement_case_lot,
  settlement_lot_retention, settlement_lot_retention_reversal, seat_money_lot FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_planned_start(uuid), fn_departure_planned_end(uuid),
  fn_purchase_amendment_guard(), fn_purchase_amendment_line_on_insert(), fn_seat_lot_holding(uuid, uuid), fn_seat_net(uuid),
  fn_settlement_lot_executed(bigint), fn_refund_failure_confirmed(uuid), fn_settlement_case_reserve(uuid, uuid, uuid),
  fn_seat_lot_reserved(uuid, uuid), fn_collection_frozen(uuid), fn_purchase_frozen(uuid), fn_seat_money_transfer_guard(),
  fn_settlement_case_lot_guard(), fn_bank_refund_allocation_lot_guard(), fn_settlement_lot_retention_guard(),
  fn_settlement_lot_reversal_guard(), fn_bank_operation_case_immutable(), fn_bank_operation_refund_contradicted(),
  fn_settlement_case_closable(uuid), fn_refund_contradiction_valid(bank_settlement_case), fn_purchase_money_in_flight(uuid),
  fn_purchase_amendment_blocker(uuid, text), fn_purchase_payment_blocker(uuid), fn_amendment_lock(uuid),
  fn_amendment_base_lines(uuid), fn_amendment_stored_lines(uuid), fn_amendment_candidate(uuid, text, jsonb, timestamptz),
  fn_amendment_hash(jsonb), fn_amendment_create(uuid, text, jsonb, text, uuid, text, text, text, text, text, text, text, timestamptz),
  fn_seat_role_changed(uuid, text, text, boolean), fn_amendment_case_open(uuid, text, boolean, jsonb), fn_amendment_settle_money(uuid),
  fn_amendment_commit(uuid, timestamptz), fn_amendment_replay(uuid, text, text), fn_amendment_args(text, text, text),
  fn_amendment_propose_correction(uuid, text, jsonb, text, text, text, text),
  fn_amendment_propose_replacement(uuid, text, text, text, text, text, text),
  fn_amendment_record_cancellation(uuid, text, text[], text, text, text, text),
  fn_amendment_buyer(purchase_amendment, text, text), fn_amendment_consent(text, text, text, text), fn_amendment_reject(text, text, text),
  fn_amendment_withdraw(uuid, text, text), fn_amendments_close_due(), fn_settlement_case_try_close(uuid, text),
  fn_settlement_case_lock(text), fn_settlement_refund_open(uuid, text, text, bigint, text), fn_settlement_refund_apply(uuid),
  fn_settlement_lot_retain(uuid, text, bigint, bigint, text, text), fn_refund_contradiction_resolve(uuid, text, text, text) FROM PUBLIC;

GRANT SELECT ON purchase_amendment, purchase_amendment_line, purchase_amendment_consent, seat_money_transfer, settlement_case_lot,
  settlement_lot_retention, settlement_lot_retention_reversal, seat_money_lot TO commerce_app, admin_app;
-- Functions inside views run with the reader's EXECUTE privilege.
GRANT EXECUTE ON FUNCTION fn_seat_lot_holding(uuid, uuid), fn_seat_net(uuid), fn_seat_lot_reserved(uuid, uuid),
  fn_settlement_lot_executed(bigint) TO commerce_app, admin_app;
GRANT EXECUTE ON FUNCTION fn_amendment_consent(text, text, text, text), fn_amendment_reject(text, text, text), fn_amendments_close_due()
  TO commerce_app;
GRANT EXECUTE ON FUNCTION fn_amendment_propose_correction(uuid, text, jsonb, text, text, text, text),
  fn_amendment_propose_replacement(uuid, text, text, text, text, text, text),
  fn_amendment_record_cancellation(uuid, text, text[], text, text, text, text), fn_amendment_withdraw(uuid, text, text),
  fn_settlement_refund_open(uuid, text, text, bigint, text), fn_settlement_lot_retain(uuid, text, bigint, bigint, text, text),
  fn_refund_contradiction_resolve(uuid, text, text, text) TO admin_app;
