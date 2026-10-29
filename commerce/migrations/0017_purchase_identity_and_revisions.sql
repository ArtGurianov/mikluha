-- TOUR-76 / N2: stable purchase identity, immutable booking revisions and an immutable,
-- server-assigned lifecycle profile (docs/plans/2026-10-29-tour-76-purchase-identity-design.md).
--
-- Forward-only. 0001–0016, legacy order snapshots and accepted documents are untouched, and no
-- existing order is backfilled: an order without a purchase has UNRESOLVED profile provenance and
-- is never read as NATIVE_NO_REFERRAL ("no prior right").
--
--   purchase            one economic purchase: purchase_ref, lifecycle profile and payment owner,
--                       fixed when it is created. There is no BOUND, partner or attribution field.
--   purchase_revision   append-only accepted terms: document order, departure revision, seats (the
--                       revision's seat allocation), price, accepted document/consent digests,
--                       accepted/effective times, participant refs, and a hash chained to its
--                       predecessor. Accepted bytes stay in the document order (orders/order_document).
--   purchase_revision_participant  tourist links without personal data: participant_ref is the
--                       participant's identity within the purchase, carried to a later revision only
--                       for the same identity document; the link points to the order_passenger row
--                       holding the data. Retention erases that row; the link stays.
--
-- The only writer is fn_open_native_purchase, for an order created in the same transaction (a
-- creation provenance stamped by the database) before anything could resolve, quote, attribute or
-- pay it. Every committed purchase has its revisions complete and its current revision last.
--
-- Trust boundary: these guarantees hold for DML by every login, the owner's included (UPDATE,
-- DELETE and TRUNCATE are refused). DDL that drops or disables triggers, or a superuser's
-- session_replication_role, is outside them: such changes reach production only as reviewed,
-- append-only, attested migrations (ART-317/318) run by the trusted owner.

-- Creation provenance of every order from now on: the creating transaction's id and start time,
-- set by the database and immutable. Orders that existed before 0017 have none.
ALTER TABLE orders ADD COLUMN created_xact_id xid8, ADD COLUMN created_xact_at timestamptz,
  -- When a purchase document order's closure was recorded, by the database clock (fn_purchase_order_guard).
  ADD COLUMN closed_recorded_at timestamptz;
CREATE FUNCTION fn_order_creation_provenance() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_xact_id := pg_current_xact_id();
    NEW.created_xact_at := transaction_timestamp();
  ELSIF ROW(NEW.created_xact_id, NEW.created_xact_at) IS DISTINCT FROM ROW(OLD.created_xact_id, OLD.created_xact_at) THEN
    RAISE EXCEPTION 'ORDER_CREATION_PROVENANCE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_creation_provenance BEFORE INSERT OR UPDATE OF created_xact_id, created_xact_at ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_creation_provenance();

CREATE TABLE purchase (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_ref      text NOT NULL UNIQUE CHECK (purchase_ref ~ '^mp-[0-9a-f]{20}$'),
  lifecycle_profile text NOT NULL CHECK (lifecycle_profile IN ('NATIVE_NO_REFERRAL')),
  payment_owner     text NOT NULL CHECK (payment_owner IN ('MIKLUHA_NATIVE')),
  origin_order_id   uuid NOT NULL UNIQUE REFERENCES orders(id),
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  current_revision  int NOT NULL DEFAULT 1 CHECK (current_revision >= 1)
);

CREATE TABLE purchase_revision (
  purchase_id              uuid NOT NULL REFERENCES purchase(id),
  revision                 int  NOT NULL CHECK (revision >= 1),
  basis                    text NOT NULL CHECK (basis IN ('INITIAL', 'QUOTE_REPLACEMENT')),
  document_order_id        uuid NOT NULL UNIQUE REFERENCES orders(id),
  departure_id             uuid NOT NULL,
  departure_version        int  NOT NULL,
  seats                    int  NOT NULL CHECK (seats BETWEEN 1 AND 6),
  unit_price_kopecks       bigint NOT NULL CHECK (unit_price_kopecks > 0),
  total_kopecks            bigint NOT NULL CHECK (total_kopecks = unit_price_kopecks * seats),
  participant_refs         uuid[] NOT NULL CHECK (cardinality(participant_refs) = seats AND array_position(participant_refs, NULL) IS NULL),
  contract_snapshot_sha256 text NOT NULL CHECK (contract_snapshot_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  legal_release_ref        text NOT NULL CHECK (length(btrim(legal_release_ref)) > 0),
  legal_release_hash       text NOT NULL CHECK (legal_release_hash ~ '^sha256:[0-9a-f]{64}$'),
  pd_consent_ref           text NOT NULL CHECK (length(btrim(pd_consent_ref)) > 0),
  pd_consent_hash          text NOT NULL CHECK (pd_consent_hash ~ '^sha256:[0-9a-f]{64}$'),
  accepted_at              timestamptz NOT NULL,
  effective_at             timestamptz NOT NULL,
  recorded_at              timestamptz NOT NULL,
  predecessor_hash         text CHECK (predecessor_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision_hash            text NOT NULL CHECK (revision_hash ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (purchase_id, revision),
  FOREIGN KEY (departure_id, departure_version) REFERENCES departure_revision(departure_id, version),
  CHECK ((basis = 'INITIAL') = (revision = 1)),
  CHECK ((revision = 1) = (predecessor_hash IS NULL)),
  CHECK (effective_at >= accepted_at)
);

CREATE TABLE purchase_revision_participant (
  purchase_id     uuid NOT NULL,
  revision        int  NOT NULL,
  position        int  NOT NULL CHECK (position BETWEEN 1 AND 6),
  participant_ref uuid NOT NULL,
  source_order_id uuid NOT NULL REFERENCES orders(id),
  source_position int  NOT NULL CHECK (source_position BETWEEN 1 AND 6),
  PRIMARY KEY (purchase_id, revision, position),
  UNIQUE (purchase_id, revision, participant_ref),
  FOREIGN KEY (purchase_id, revision) REFERENCES purchase_revision(purchase_id, revision)
);
CREATE INDEX purchase_revision_participant_ref ON purchase_revision_participant (participant_ref);

-- The hash commits to the document order, the economic content, the participants and the
-- predecessor. Participant links are (document_order_id, position) by construction
-- (fn_purchase_participant_on_insert), so they are covered too; no personal data is hashed.
-- Timestamps are rendered in UTC so the session TimeZone cannot change it. Recomputable from the row.
CREATE FUNCTION fn_purchase_revision_hash(p_purchase_ref text, r purchase_revision) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to(jsonb_build_object(
    'purchaseRef', p_purchase_ref, 'revision', r.revision, 'basis', r.basis, 'predecessor', r.predecessor_hash,
    'documentOrderId', r.document_order_id,
    'departureId', r.departure_id, 'departureVersion', r.departure_version, 'seats', r.seats,
    'unitPriceKopecks', r.unit_price_kopecks, 'totalKopecks', r.total_kopecks, 'participants', to_jsonb(r.participant_refs),
    'contractSnapshotSha256', r.contract_snapshot_sha256,
    'legalRelease', jsonb_build_object('ref', r.legal_release_ref, 'hash', r.legal_release_hash),
    'pdConsent', jsonb_build_object('ref', r.pd_consent_ref, 'hash', r.pd_consent_hash),
    'acceptedAt', to_char(r.accepted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'effectiveAt', to_char(r.effective_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))::text, 'UTF8')), 'hex')
$fn$ LANGUAGE sql;

-- An order this transaction created (its database-stamped provenance, not a row version that any
-- UPDATE renews), that nothing has resolved, quoted, attributed, documented or paid. Orders from
-- before 0017 have no provenance, so legacy orders and their genuine owner/profile stay outside.
CREATE FUNCTION fn_purchase_document_order_fresh(p_order_id uuid) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN 'PURCHASE_ORDER_UNKNOWN'; END IF;
  IF o.created_xact_id IS DISTINCT FROM pg_current_xact_id() OR o.created_xact_at IS DISTINCT FROM transaction_timestamp() THEN
    RETURN 'PURCHASE_ORDER_NOT_NEW';
  END IF;
  IF o.status <> 'RESERVED' OR o.state_hash IS NOT NULL OR o.referral_resolution_id IS NOT NULL
     OR o.terms_version_id IS NOT NULL OR o.attribution_source IS NOT NULL OR o.discount_kopecks IS NOT NULL
     OR o.quote_issued_at IS NOT NULL OR o.snapshot IS NOT NULL OR o.payment_pending_since IS NOT NULL
     OR o.checkout_attempt_id IS NOT NULL OR o.payment_id IS NOT NULL OR o.resolution_operation_id IS NOT NULL
     OR o.attempt_creation_state <> 'NOT_STARTED'
     OR o.contract_snapshot IS NULL OR o.departure_id IS NULL OR o.accepted_departure_version IS NULL
     OR EXISTS (SELECT 1 FROM order_document WHERE order_id = p_order_id) THEN
    RETURN 'PURCHASE_ORDER_NOT_PRISTINE';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_purchase_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE refusal text := fn_purchase_document_order_fresh(NEW.origin_order_id);
BEGIN
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  IF NEW.current_revision <> 1 THEN RAISE EXCEPTION 'PURCHASE_REVISION_SEQUENCE' USING ERRCODE = '55000'; END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_on_insert BEFORE INSERT ON purchase
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_on_insert();

-- Identity, profile and payment owner are fixed at creation. The current revision only advances,
-- one step at a time, to a revision that exists.
CREATE FUNCTION fn_purchase_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PURCHASE_HISTORY_IMMUTABLE: purchase' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.lifecycle_profile, NEW.payment_owner) IS DISTINCT FROM ROW(OLD.lifecycle_profile, OLD.payment_owner) THEN
    RAISE EXCEPTION 'PURCHASE_PROFILE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.purchase_ref, NEW.origin_order_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.purchase_ref, OLD.origin_order_id, OLD.created_at) THEN
    RAISE EXCEPTION 'PURCHASE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.current_revision IS DISTINCT FROM OLD.current_revision AND (NEW.current_revision <> OLD.current_revision + 1
     OR NOT EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = NEW.id AND revision = NEW.current_revision)) THEN
    RAISE EXCEPTION 'PURCHASE_REVISION_SEQUENCE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_immutable BEFORE UPDATE OR DELETE ON purchase
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_immutable();

-- A revision is appended in sequence to the purchase it continues; its document order is fresh,
-- and the economic terms are the document order's own. The database derives recorded_at, the
-- predecessor and the hash, so no caller can supply them.
CREATE FUNCTION fn_purchase_revision_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE p purchase%ROWTYPE; o orders%ROWTYPE; prev purchase_revision%ROWTYPE; refusal text;
BEGIN
  SELECT * INTO p FROM purchase WHERE id = NEW.purchase_id FOR UPDATE;
  SELECT * INTO prev FROM purchase_revision WHERE purchase_id = NEW.purchase_id ORDER BY revision DESC LIMIT 1;
  IF NEW.revision IS DISTINCT FROM coalesce(prev.revision, 0) + 1 THEN RAISE EXCEPTION 'PURCHASE_REVISION_SEQUENCE' USING ERRCODE = '55000'; END IF;
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
  NEW.recorded_at := clock_timestamp();
  NEW.predecessor_hash := prev.revision_hash;
  NEW.revision_hash := fn_purchase_revision_hash(p.purchase_ref, NEW);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_revision_on_insert BEFORE INSERT ON purchase_revision
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_revision_on_insert();

-- The same person, as far as the order can prove it: the identity document and date of birth.
CREATE FUNCTION fn_purchase_same_tourist(p_order_a uuid, p_position_a int, p_order_b uuid, p_position_b int) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM order_passenger a, order_passenger b
    WHERE a.order_id = p_order_a AND a.position = p_position_a AND b.order_id = p_order_b AND b.position = p_position_b
      AND a.document_type IS NOT NULL AND a.document_number IS NOT NULL
      AND ROW(a.document_type, a.document_series, a.document_number, a.citizenship, a.date_of_birth)
          IS NOT DISTINCT FROM ROW(b.document_type, b.document_series, b.document_number, b.citizenship, b.date_of_birth))
$fn$ LANGUAGE sql;

-- A link points at its own revision's document order and position. Its participant_ref is either
-- new, or carried from the predecessor revision of the same purchase for the same tourist (both
-- tourist rows present and the same identity document). A position is never proof of identity.
CREATE FUNCTION fn_purchase_participant_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE r purchase_revision%ROWTYPE; carried purchase_revision_participant%ROWTYPE;
BEGIN
  SELECT * INTO r FROM purchase_revision WHERE purchase_id = NEW.purchase_id AND revision = NEW.revision;
  IF NEW.position > r.seats OR r.participant_refs[NEW.position] IS DISTINCT FROM NEW.participant_ref
     OR NEW.source_order_id <> r.document_order_id OR NEW.source_position <> NEW.position
     OR NOT EXISTS (SELECT 1 FROM order_passenger WHERE order_id = NEW.source_order_id AND position = NEW.source_position) THEN
    RAISE EXCEPTION 'PURCHASE_PARTICIPANT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_revision_participant WHERE participant_ref = NEW.participant_ref AND purchase_id <> NEW.purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_PARTICIPANT_CONTINUITY' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO carried FROM purchase_revision_participant
    WHERE purchase_id = NEW.purchase_id AND revision = NEW.revision - 1 AND participant_ref = NEW.participant_ref;
  IF FOUND THEN
    IF NOT fn_purchase_same_tourist(carried.source_order_id, carried.source_position, NEW.source_order_id, NEW.source_position) THEN
      RAISE EXCEPTION 'PURCHASE_PARTICIPANT_CONTINUITY' USING ERRCODE = '55000';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM purchase_revision_participant WHERE purchase_id = NEW.purchase_id
                AND revision < NEW.revision AND participant_ref = NEW.participant_ref) THEN
    -- A participant who left the purchase does not come back under an old ref.
    RAISE EXCEPTION 'PURCHASE_PARTICIPANT_CONTINUITY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_participant_on_insert BEFORE INSERT ON purchase_revision_participant
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_participant_on_insert();

-- Append-only for every login's DML, TRUNCATE included (statement triggers: TRUNCATE skips row ones).
CREATE FUNCTION fn_purchase_history_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION 'PURCHASE_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_revision_immutable BEFORE UPDATE OR DELETE ON purchase_revision
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_participant_immutable BEFORE UPDATE OR DELETE ON purchase_revision_participant
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_no_truncate BEFORE TRUNCATE ON purchase
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_revision_no_truncate BEFORE TRUNCATE ON purchase_revision
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_participant_no_truncate BEFORE TRUNCATE ON purchase_revision_participant
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- At commit, a purchase is whole: revision 1 exists, revisions are contiguous, the current revision
-- is the last one, and every revision has all of its participant links.
CREATE FUNCTION fn_purchase_complete() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid;
BEGIN
  IF TG_TABLE_NAME = 'purchase' THEN v_purchase := NEW.id; ELSE v_purchase := NEW.purchase_id; END IF;
  IF NOT EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = v_purchase AND revision = 1)
     OR (SELECT current_revision FROM purchase WHERE id = v_purchase)
        IS DISTINCT FROM (SELECT max(revision) FROM purchase_revision WHERE purchase_id = v_purchase)
     OR (SELECT count(*) FROM purchase_revision WHERE purchase_id = v_purchase)
        <> (SELECT max(revision) FROM purchase_revision WHERE purchase_id = v_purchase)
     OR EXISTS (SELECT 1 FROM purchase_revision r WHERE r.purchase_id = v_purchase
        AND (SELECT count(*) FROM purchase_revision_participant x WHERE x.purchase_id = r.purchase_id AND x.revision = r.revision) <> r.seats) THEN
    RAISE EXCEPTION 'PURCHASE_INCOMPLETE' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_purchase_complete AFTER INSERT ON purchase
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_purchase_complete();
CREATE CONSTRAINT TRIGGER trg_purchase_revision_complete AFTER INSERT ON purchase_revision
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_purchase_complete();

-- A purchase document order is never handed to Refref and its accepted terms never change:
--   NATIVE_PURCHASE_NO_REFERRAL      Refref resolution or attribution
--   NATIVE_PURCHASE_PAYMENT_OWNER    Refref checkout attempt, frozen snapshot or payment
--   NATIVE_PURCHASE_TERMS_IMMUTABLE  identity, departure, seats, price, documents and their bytes,
--                                    consent, and the closure/retention markers once recorded
-- Unconditional, whatever the order's state, so neither a client, a worker nor a migration can bind
-- it retroactively or make its seats disagree with the revision.
CREATE FUNCTION fn_purchase_order_guard() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = NEW.id) THEN RETURN NEW; END IF;
  IF ROW(NEW.referral_resolution_id, NEW.terms_version_id, NEW.attribution_source, NEW.resolution_expires_at,
         NEW.discount_kopecks, NEW.payable_kopecks, NEW.resolution_operation_id, NEW.resolution_started_at)
     IS DISTINCT FROM
     ROW(OLD.referral_resolution_id, OLD.terms_version_id, OLD.attribution_source, OLD.resolution_expires_at,
         OLD.discount_kopecks, OLD.payable_kopecks, OLD.resolution_operation_id, OLD.resolution_started_at) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_NO_REFERRAL' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.snapshot, NEW.snapshot_hash, NEW.payment_pending_since, NEW.checkout_attempt_id, NEW.payment_id,
         NEW.paid_at, NEW.attempt_creation_state, NEW.last_session)
     IS DISTINCT FROM
     ROW(OLD.snapshot, OLD.snapshot_hash, OLD.payment_pending_since, OLD.checkout_attempt_id, OLD.payment_id,
         OLD.paid_at, OLD.attempt_creation_state, OLD.last_session) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_PAYMENT_OWNER' USING ERRCODE = '55000';
  END IF;
  IF ROW(NEW.id, NEW.order_ref, NEW.departure_slug, NEW.departure_id, NEW.accepted_departure_version, NEW.trip_starts_on,
         NEW.trip_ends_on, NEW.seats, NEW.unit_price_kopecks, NEW.amount_kopecks, NEW.contract_snapshot_sha256,
         NEW.legal_release_ref, NEW.legal_release_hash, NEW.pd_consent_ref, NEW.pd_consent_hash, NEW.pd_consent_accepted_at,
         NEW.adults_only_confirmed, NEW.created_at, NEW.replaces_order_id)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.order_ref, OLD.departure_slug, OLD.departure_id, OLD.accepted_departure_version, OLD.trip_starts_on,
         OLD.trip_ends_on, OLD.seats, OLD.unit_price_kopecks, OLD.amount_kopecks, OLD.contract_snapshot_sha256,
         OLD.legal_release_ref, OLD.legal_release_hash, OLD.pd_consent_ref, OLD.pd_consent_hash, OLD.pd_consent_accepted_at,
         OLD.adults_only_confirmed, OLD.created_at, OLD.replaces_order_id) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- The accepted bytes themselves, not only their digests.
  IF ROW(NEW.legal_release_content, NEW.pd_consent_content) IS DISTINCT FROM ROW(OLD.legal_release_content, OLD.pd_consent_content) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  -- Closure and the retention marker are recorded once. Retention eligibility reads the database's
  -- own closure stamp, never the caller-supplied closed_at, so a backdated closure erases nothing early.
  IF (OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at)
     OR (OLD.pd_erased_at IS NOT NULL AND NEW.pd_erased_at IS DISTINCT FROM OLD.pd_erased_at) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL THEN
    NEW.closed_recorded_at := clock_timestamp();
  ELSIF NEW.closed_recorded_at IS DISTINCT FROM OLD.closed_recorded_at THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_order_guard BEFORE UPDATE OF referral_resolution_id, terms_version_id, attribution_source,
  resolution_expires_at, discount_kopecks, payable_kopecks, resolution_operation_id, resolution_started_at, snapshot,
  snapshot_hash, payment_pending_since, checkout_attempt_id, payment_id, paid_at, attempt_creation_state, last_session,
  id, order_ref, departure_slug, departure_id, accepted_departure_version, trip_starts_on, trip_ends_on, seats,
  unit_price_kopecks, amount_kopecks, contract_snapshot_sha256, legal_release_ref, legal_release_hash, pd_consent_ref,
  pd_consent_hash, pd_consent_accepted_at, adults_only_confirmed, created_at, replaces_order_id,
  legal_release_content, pd_consent_content, closed_at, pd_erased_at, closed_recorded_at
  ON orders FOR EACH ROW EXECUTE FUNCTION fn_purchase_order_guard();

-- Whether retention may erase this order's tourists now, by the database clock. Always true for an
-- order outside any purchase (its rules are maintain()'s alone). For a purchase document order: no
-- legal hold, and 24 hours since the database recorded its unpaid closure, or 90 days after the trip
-- once its money is settled (orders.ts UNPAID_PD_RETENTION_HOURS, TRIP_PD_RETENTION_DAYS). maintain()
-- selects only orders for which this holds, so an early one is skipped, not a failed batch.
CREATE FUNCTION fn_purchase_pd_retention_due(p_order_id uuid) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = o.id)
      OR (NOT o.legal_hold
          AND ((o.status IN ('EXPIRED','CANCELLED') AND o.closed_recorded_at <= clock_timestamp() - interval '24 hours')
            OR (o.status IN ('PAID','FULFILLED','REFUNDED') AND o.trip_ends_on + 90 < (clock_timestamp() AT TIME ZONE 'UTC')::date)))
    FROM orders o WHERE o.id = p_order_id
$fn$ LANGUAGE sql;

-- The tourists of a revision are fixed when it is opened: no tourist is added, edited or moved
-- (changing a tourist is a new revision). Their rows may only be deleted by qualified retention, as
-- maintain() does it: the order is marked pd_erased_at first and fn_purchase_pd_retention_due holds.
-- Otherwise continuity could be carried to, or erased from, the wrong person.
CREATE FUNCTION fn_purchase_passenger_guard() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = OLD.order_id)
       AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = OLD.order_id AND o.pd_erased_at IS NOT NULL
         AND fn_purchase_pd_retention_due(o.id)) THEN
      RAISE EXCEPTION 'NATIVE_PURCHASE_PD_RETENTION_ONLY' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = NEW.order_id)
     OR (TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = OLD.order_id)) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_TERMS_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_passenger_guard BEFORE INSERT OR UPDATE OR DELETE ON order_passenger
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_passenger_guard();
-- TRUNCATE skips row triggers: refused while any purchase links to tourist rows.
CREATE FUNCTION fn_purchase_passenger_no_truncate() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM purchase_revision_participant) THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_PD_RETENTION_ONLY' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_passenger_no_truncate BEFORE TRUNCATE ON order_passenger
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_passenger_no_truncate();

-- A replacement of a purchase document order continues that purchase in the same transaction;
-- it never leaves the purchase for a legacy (Refref-attributable) order.
CREATE FUNCTION fn_purchase_continuation_required() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid;
BEGIN
  SELECT purchase_id INTO v_purchase FROM purchase_revision WHERE document_order_id = NEW.replaces_order_id;
  IF v_purchase IS NOT NULL AND NOT EXISTS (SELECT 1 FROM purchase_revision
      WHERE document_order_id = NEW.id AND purchase_id = v_purchase AND basis = 'QUOTE_REPLACEMENT') THEN
    RAISE EXCEPTION 'NATIVE_PURCHASE_CONTINUATION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_purchase_continuation_required AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.replaces_order_id IS NOT NULL)
  EXECUTE FUNCTION fn_purchase_continuation_required();

-- The one entry point. The profile and payment owner are constants here, not arguments: no
-- request, promo/query field or configuration value can choose them. A replacement order of the
-- purchase's current document order appends a QUOTE_REPLACEMENT revision under the same
-- purchase_ref; replacing an order without a purchase is refused (its provenance stays unresolved).
-- A participant keeps its ref only when exactly one tourist of the predecessor and exactly one of
-- the new order carry the same identity document; anyone else is a new participant.
CREATE FUNCTION fn_open_native_purchase(p_order_id uuid) RETURNS TABLE (purchase_ref text, revision int)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE o orders%ROWTYPE; p purchase%ROWTYPE; v_rev int := 1; v_basis text := 'INITIAL'; v_prev uuid; v_refs uuid[]; refusal text;
BEGIN
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'PURCHASE_ORDER_UNKNOWN' USING ERRCODE = '22023'; END IF;
  refusal := fn_purchase_document_order_fresh(p_order_id);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF o.replaces_order_id IS NOT NULL THEN
    SELECT pu.* INTO p FROM purchase pu JOIN purchase_revision r ON r.purchase_id = pu.id
      WHERE r.document_order_id = o.replaces_order_id AND r.revision = pu.current_revision FOR UPDATE OF pu;
    IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_REPLACES_UNRESOLVED_ORDER' USING ERRCODE = '55000'; END IF;
    v_rev := p.current_revision + 1;
    v_basis := 'QUOTE_REPLACEMENT';
    v_prev := o.replaces_order_id;
  ELSE
    INSERT INTO purchase (purchase_ref, lifecycle_profile, payment_owner, origin_order_id)
      VALUES ('mp-' || left(md5(gen_random_uuid()::text), 20), 'NATIVE_NO_REFERRAL', 'MIKLUHA_NATIVE', o.id)
      RETURNING * INTO p;
  END IF;
  SELECT array_agg(coalesce(m.ref, gen_random_uuid()) ORDER BY n.position) INTO v_refs
    FROM generate_series(1, o.seats) n(position)
    LEFT JOIN LATERAL (
      SELECT x.participant_ref AS ref FROM purchase_revision_participant x
       WHERE x.purchase_id = p.id AND x.revision = v_rev - 1
         AND fn_purchase_same_tourist(x.source_order_id, x.source_position, o.id, n.position)
         AND (SELECT count(*) FROM purchase_revision_participant y WHERE y.purchase_id = p.id AND y.revision = v_rev - 1
              AND fn_purchase_same_tourist(y.source_order_id, y.source_position, o.id, n.position)) = 1
         AND (SELECT count(*) FROM generate_series(1, o.seats) k
              WHERE fn_purchase_same_tourist(x.source_order_id, x.source_position, o.id, k)) = 1) m ON v_prev IS NOT NULL;
  INSERT INTO purchase_revision (purchase_id, revision, basis, document_order_id, departure_id, departure_version, seats,
      unit_price_kopecks, total_kopecks, participant_refs, contract_snapshot_sha256, legal_release_ref, legal_release_hash,
      pd_consent_ref, pd_consent_hash, accepted_at, effective_at, recorded_at, revision_hash)
    VALUES (p.id, v_rev, v_basis, o.id, o.departure_id, o.accepted_departure_version, o.seats, o.unit_price_kopecks,
      o.amount_kopecks, v_refs, o.contract_snapshot_sha256, o.legal_release_ref, o.legal_release_hash,
      o.pd_consent_ref, o.pd_consent_hash, o.pd_consent_accepted_at, o.pd_consent_accepted_at, clock_timestamp(),
      'sha256:' || repeat('0', 64));
  INSERT INTO purchase_revision_participant (purchase_id, revision, position, participant_ref, source_order_id, source_position)
    SELECT p.id, v_rev, i, v_refs[i], o.id, i FROM generate_series(1, o.seats) i;
  IF v_rev > 1 THEN UPDATE purchase SET current_revision = v_rev WHERE id = p.id; END IF;
  INSERT INTO order_event (order_id, event, detail) VALUES (o.id, 'PURCHASE_REVISION', 'revision:' || v_rev);
  RETURN QUERY SELECT p.purchase_ref, v_rev;
END $fn$ LANGUAGE plpgsql;

-- Shared capacity contract (ART-366 / TOUR-65, TOUR-79): seats taken on a departure as of p_now.
-- The caller holds the departure transaction lock (fn_lock_checkout_departure, or the editorial
-- row + advisory order) and rereads after locking. A purchase document order counts its accepted
-- revision's seats (its own seats are frozen equal to them); a lapsed RESERVED hold with no started
-- payment no longer counts.
CREATE FUNCTION fn_departure_taken_seats(p_slug text, p_now timestamptz) RETURNS bigint
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT coalesce(sum(coalesce(r.seats, o.seats)), 0) FROM orders o
    LEFT JOIN purchase_revision r ON r.document_order_id = o.id
   WHERE o.departure_slug = p_slug AND o.status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD')
     AND NOT (o.status = 'RESERVED' AND o.reserved_until <= p_now AND o.snapshot IS NULL AND o.checkout_attempt_id IS NULL
              AND o.payment_pending_since IS NULL AND o.resolution_operation_id IS NULL)
$fn$ LANGUAGE sql;

-- Current projection: one row per purchase, at its current revision. No personal data.
CREATE VIEW purchase_current AS
  SELECT p.purchase_ref, p.lifecycle_profile, p.payment_owner, p.created_at, r.revision, r.basis, r.revision_hash,
         o.order_ref AS document_order_ref, o.status AS document_order_status, d.slug AS departure_slug,
         r.departure_id, r.departure_version, r.seats, r.unit_price_kopecks, r.total_kopecks, r.accepted_at, r.effective_at
    FROM purchase p
    JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN orders o ON o.id = r.document_order_id
    JOIN departure d ON d.id = r.departure_id;

-- Every order's profile provenance. Without a purchase it is UNRESOLVED, profile NULL: legacy rights
-- and unknowns are kept as they are, never classified as NATIVE_NO_REFERRAL.
CREATE VIEW order_purchase_profile AS
  SELECT o.order_ref, p.purchase_ref, r.revision, p.lifecycle_profile, p.payment_owner,
         CASE WHEN p.id IS NULL THEN 'UNRESOLVED' ELSE 'PURCHASE' END AS provenance
    FROM orders o
    LEFT JOIN purchase_revision r ON r.document_order_id = o.id
    LEFT JOIN purchase p ON p.id = r.purchase_id;

REVOKE ALL ON purchase, purchase_revision, purchase_revision_participant, purchase_current, order_purchase_profile FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_order_creation_provenance(), fn_purchase_revision_hash(text, purchase_revision),
  fn_purchase_document_order_fresh(uuid), fn_purchase_on_insert(), fn_purchase_immutable(), fn_purchase_revision_on_insert(),
  fn_purchase_same_tourist(uuid, int, uuid, int), fn_purchase_participant_on_insert(), fn_purchase_history_immutable(),
  fn_purchase_complete(), fn_purchase_order_guard(), fn_purchase_pd_retention_due(uuid), fn_purchase_passenger_guard(), fn_purchase_passenger_no_truncate(),
  fn_purchase_continuation_required(),
  fn_open_native_purchase(uuid), fn_departure_taken_seats(text, timestamptz) FROM PUBLIC;
GRANT SELECT ON purchase, purchase_revision, purchase_revision_participant, purchase_current, order_purchase_profile TO commerce_app;
GRANT EXECUTE ON FUNCTION fn_open_native_purchase(uuid), fn_departure_taken_seats(text, timestamptz), fn_purchase_pd_retention_due(uuid) TO commerce_app;
