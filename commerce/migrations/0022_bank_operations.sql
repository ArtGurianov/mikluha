-- Track A / A2b-1 for TOUR-77: the merchant-native bank operation registry
-- (docs/plans/2026-11-04-track-a-schema-roles-contract.md §9, §14; OWNER v1.9.1 §2 п.3–5, G-LATE-CLOSED).
--
-- Forward-only after 0021; 0001–0021 keep their bytes. Nothing is backfilled: 0021 has not been
-- installed on any working database, and its synthetic attempt references stay valid history (the new
-- foreign keys are NOT VALID: they bind every new row, not rows written before this migration).
--
--   * one bank_operation per payment cycle (COLLECTION) or per staff-ordered refund (REFUND); its
--     reference is the database's, and it is the attempt the cycle is fenced with (0021 attempt_ref);
--   * the service no longer calls 0021's fence and outcome functions directly: it opens an operation
--     and records the bank's evidence; the database matches provider, merchant account, provider
--     operation, amount and currency, moves the operation's status and only then applies the outcome
--     to the seats through 0021's functions;
--   * every piece of evidence is kept, once (a repeated callback or read-back is the same row and
--     changes nothing); money the bank confirmed is a fact even when no seat may change
--     (NEWER_CYCLE_EXISTS, PURCHASE_CLOSED_LATE_PAYMENT) or none is free (PAID_NO_SEAT): those open one
--     settlement case each for TOUR-27, never a second case for the same operation and reason;
--   * UNKNOWN or an operation in flight keeps its seats and blocks a new cycle and the purchase's
--     closure; a seat application that failed unexpectedly stays due and is retried by maintain();
--   * refunds are opened only by staff with refund.execute (OWNER, decision 4A) and never exceed the
--     money collected minus refunds not proven failed. A refund the bank confirmed settles an obligation
--     only through an allocation (bank_refund_allocation) of that obligation's whole amount: a no-seat
--     seat's frozen price, or the collection a settlement case is about; one refund's allocations never
--     exceed its amount, so one refund cannot settle more than it returned (review of PR #87).
--
-- The provider transport (Alfa registration, signed callbacks, read-back) is TOUR-77's and TOUR-83's;
-- whether a callback is authentic is decided by the service before it records the evidence. Until
-- TOUR-83 qualifies the provider, nothing here is qualified for real money.

-- ---------------------------------------------------------------------------------------------
-- 1. Operations, evidence, seat applications and settlement cases.

CREATE TABLE bank_operation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_operation_ref    text NOT NULL UNIQUE CHECK (bank_operation_ref ~ '^bo-[0-9a-f]{20}$'),
  kind                  text NOT NULL CHECK (kind IN ('COLLECTION', 'REFUND')),
  purchase_id           uuid NOT NULL REFERENCES purchase(id),
  -- COLLECTION: the payment cycle it fences, one operation per cycle.
  seat_hold_id          uuid UNIQUE REFERENCES seat_hold(id),
  -- REFUND: the collection whose money it returns.
  refunds_operation_id  uuid REFERENCES bank_operation(id),
  provider              text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{1,30}$'),
  merchant_account      text NOT NULL CHECK (merchant_account ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  amount_kopecks        bigint NOT NULL CHECK (amount_kopecks > 0),
  currency              text NOT NULL CHECK (currency = 'RUB'),
  status                text NOT NULL CHECK (status IN ('INTENDED', 'REGISTERED', 'UNKNOWN', 'SUCCEEDED', 'FAILED')),
  provider_operation_id text CHECK (provider_operation_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  created_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_by            text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 120),
  reason                text CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  registered_at         timestamptz,
  -- The bank's window of a registered attempt (TOUR-91: 1800 seconds from the registration).
  bank_expires_at       timestamptz,
  outcome_at            timestamptz,
  -- The bank reported a failure, then a success of the same operation (v1.9.1 §2 п.4).
  contradicted_at       timestamptz,
  -- The outcome still to be applied to the seats, and the last unexpected error doing so.
  application_due       text CHECK (application_due IN ('SUCCEEDED', 'FAILED')),
  application_error     text,
  UNIQUE (provider, provider_operation_id),
  CHECK ((kind = 'COLLECTION') = (seat_hold_id IS NOT NULL)),
  CHECK ((kind = 'REFUND') = (refunds_operation_id IS NOT NULL)),
  CHECK ((kind = 'REFUND') = (reason IS NOT NULL)),
  CHECK ((registered_at IS NULL) = (bank_expires_at IS NULL)),
  CHECK ((status IN ('SUCCEEDED', 'FAILED')) = (outcome_at IS NOT NULL)),
  CHECK (contradicted_at IS NULL OR status = 'SUCCEEDED'),
  CHECK (kind = 'COLLECTION' OR application_due IS NULL)
);
CREATE INDEX bank_operation_purchase ON bank_operation (purchase_id);
CREATE INDEX bank_operation_refunds ON bank_operation (refunds_operation_id) WHERE refunds_operation_id IS NOT NULL;
CREATE INDEX bank_operation_due ON bank_operation (id) WHERE application_due IS NOT NULL;

-- Every answer the service received about an operation, authenticated by the service (TOUR-77), as
-- reported, whether or not it matched. The payload hash is the evidence's identity: the same callback
-- or read-back recorded twice is one row.
CREATE TABLE bank_operation_evidence (
  id                    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_operation_id     uuid NOT NULL REFERENCES bank_operation(id),
  received_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  source                text NOT NULL CHECK (source IN ('REGISTRATION_RESPONSE', 'CALLBACK', 'READ_BACK', 'DISPATCH_ERROR')),
  observed              text NOT NULL CHECK (observed IN ('REGISTERED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  provider              text CHECK (length(provider) BETWEEN 1 AND 100),
  merchant_account      text CHECK (length(merchant_account) BETWEEN 1 AND 100),
  provider_operation_id text CHECK (length(provider_operation_id) BETWEEN 1 AND 100),
  amount_kopecks        bigint,
  currency              text CHECK (length(currency) BETWEEN 1 AND 10),
  provider_event_id     text CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  payload_sha256        text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  matches               boolean NOT NULL,
  status_before         text NOT NULL,
  status_after          text NOT NULL,
  effect                text NOT NULL CHECK (effect IN ('STATUS_CHANGED', 'NO_CHANGE', 'EVIDENCE_MISMATCH', 'CONTRADICTORY')),
  UNIQUE (bank_operation_id, payload_sha256)
);

-- TOUR-27's manual settlement queue: money or evidence the seats could not absorb. One case per
-- operation and reason; resolved once, by refund or an OWNER decision.
CREATE TABLE bank_settlement_case (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref            text NOT NULL UNIQUE CHECK (case_ref ~ '^bc-[0-9a-f]{20}$'),
  bank_operation_id   uuid NOT NULL REFERENCES bank_operation(id),
  purchase_id         uuid NOT NULL REFERENCES purchase(id),
  reason              text NOT NULL CHECK (reason IN ('PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS', 'PAID_NO_SEAT',
                                                     'EVIDENCE_MISMATCH', 'CONTRADICTORY_EVIDENCE')),
  opened_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at         timestamptz,
  resolved_by         text CHECK (length(resolved_by) BETWEEN 1 AND 120),
  resolution          text CHECK (resolution IN ('REFUNDED', 'OWNER_DECISION')),
  resolution_reason   text CHECK (length(btrim(resolution_reason)) BETWEEN 1 AND 500),
  refund_operation_id uuid REFERENCES bank_operation(id),
  UNIQUE (bank_operation_id, reason),
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL) AND (resolved_at IS NULL) = (resolution IS NULL)
         AND (resolved_at IS NULL) = (resolution_reason IS NULL)),
  CHECK ((resolution = 'REFUNDED') = (refund_operation_id IS NOT NULL))
);
CREATE INDEX bank_settlement_case_open ON bank_settlement_case (purchase_id) WHERE resolved_at IS NULL;

-- What an outcome did to the seats, once per operation and outcome (a late success after a failure is
-- a second, different application).
CREATE TABLE bank_operation_application (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_operation_id  uuid NOT NULL REFERENCES bank_operation(id),
  outcome            text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'FAILED')),
  applied_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  seat_effect        text NOT NULL CHECK (seat_effect IN ('SEATS_CONFIRMED', 'SEATS_RELEASED', 'LATE_CONFIRMED', 'PAID_NO_SEAT',
                                                          'PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS', 'NONE')),
  confirmed          int NOT NULL CHECK (confirmed >= 0),
  no_seat            int NOT NULL CHECK (no_seat >= 0),
  settlement_case_id uuid REFERENCES bank_settlement_case(id),
  UNIQUE (bank_operation_id, outcome)
);

-- Which obligation a confirmed refund settles, and for how much (TOUR-27). One obligation, one
-- allocation; the allocations of one refund never exceed its amount. The general money ledger of
-- payments and refunds per seat is A2b-2 (TOUR-78); until then a refund settles only whole obligations.
CREATE TABLE bank_refund_allocation (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  refund_operation_id uuid NOT NULL REFERENCES bank_operation(id),
  seat_slot_id        uuid UNIQUE REFERENCES seat_slot(id),
  settlement_case_id  uuid UNIQUE REFERENCES bank_settlement_case(id),
  amount_kopecks      bigint NOT NULL CHECK (amount_kopecks > 0),
  allocated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  allocated_by        text NOT NULL CHECK (length(allocated_by) BETWEEN 1 AND 120),
  CHECK ((seat_slot_id IS NULL) <> (settlement_case_id IS NULL))
);
CREATE INDEX bank_refund_allocation_refund ON bank_refund_allocation (refund_operation_id);

-- 0021's attempt references and seat events now name bank operations (A2b-1). NOT VALID: binding for
-- every new row; rows written before this migration were synthetic and are not rewritten.
ALTER TABLE seat_hold ADD CONSTRAINT seat_hold_attempt_bank_operation
  FOREIGN KEY (attempt_ref) REFERENCES bank_operation(bank_operation_ref) NOT VALID;
ALTER TABLE seat_slot_event ADD CONSTRAINT seat_slot_event_bank_operation
  FOREIGN KEY (bank_operation_ref) REFERENCES bank_operation(bank_operation_ref) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 2. Guards: for every login's DML, identities never change, the status moves only forward
--    (a failure may still be contradicted by a success, never the reverse), history is append-only.

CREATE FUNCTION fn_bank_operation_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BANK_OPERATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INTENDED' OR NEW.provider_operation_id IS NOT NULL OR NEW.registered_at IS NOT NULL
       OR NEW.contradicted_at IS NOT NULL OR NEW.application_due IS NOT NULL THEN
      RAISE EXCEPTION 'BANK_OPERATION_TRANSITION_INVALID' USING ERRCODE = '55000';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.bank_operation_ref, NEW.kind, NEW.purchase_id, NEW.seat_hold_id, NEW.refunds_operation_id, NEW.provider,
         NEW.merchant_account, NEW.amount_kopecks, NEW.currency, NEW.created_at, NEW.created_by, NEW.reason)
     IS DISTINCT FROM ROW(OLD.id, OLD.bank_operation_ref, OLD.kind, OLD.purchase_id, OLD.seat_hold_id, OLD.refunds_operation_id,
         OLD.provider, OLD.merchant_account, OLD.amount_kopecks, OLD.currency, OLD.created_at, OLD.created_by, OLD.reason)
     OR (OLD.provider_operation_id IS NOT NULL AND NEW.provider_operation_id IS DISTINCT FROM OLD.provider_operation_id)
     OR (OLD.registered_at IS NOT NULL AND ROW(NEW.registered_at, NEW.bank_expires_at) IS DISTINCT FROM ROW(OLD.registered_at, OLD.bank_expires_at))
     OR (OLD.contradicted_at IS NOT NULL AND NEW.contradicted_at IS DISTINCT FROM OLD.contradicted_at)
     OR (OLD.outcome_at IS NOT NULL AND NEW.status = OLD.status AND NEW.outcome_at IS DISTINCT FROM OLD.outcome_at) THEN
    RAISE EXCEPTION 'BANK_OPERATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'INTENDED' AND NEW.status IN ('REGISTERED', 'UNKNOWN', 'SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'REGISTERED' AND NEW.status IN ('UNKNOWN', 'SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'UNKNOWN' AND NEW.status IN ('REGISTERED', 'SUCCEEDED', 'FAILED'))
    OR (OLD.status = 'FAILED' AND NEW.status = 'SUCCEEDED' AND NEW.contradicted_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'BANK_OPERATION_TRANSITION_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_operation
  FOR EACH ROW EXECUTE FUNCTION fn_bank_operation_guard();

CREATE FUNCTION fn_bank_settlement_case_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
    NEW.opened_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.case_ref, NEW.bank_operation_id, NEW.purchase_id, NEW.reason, NEW.opened_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.case_ref, OLD.bank_operation_id, OLD.purchase_id, OLD.reason, OLD.opened_at)
     OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_SETTLEMENT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_settlement_case_guard BEFORE INSERT OR UPDATE OR DELETE ON bank_settlement_case
  FOR EACH ROW EXECUTE FUNCTION fn_bank_settlement_case_guard();

CREATE TRIGGER trg_bank_operation_evidence_immutable BEFORE UPDATE OR DELETE ON bank_operation_evidence
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_operation_application_immutable BEFORE UPDATE OR DELETE ON bank_operation_application
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_operation_no_truncate BEFORE TRUNCATE ON bank_operation
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_operation_evidence_no_truncate BEFORE TRUNCATE ON bank_operation_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_settlement_case_no_truncate BEFORE TRUNCATE ON bank_settlement_case
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_operation_application_no_truncate BEFORE TRUNCATE ON bank_operation_application
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_refund_allocation_immutable BEFORE UPDATE OR DELETE ON bank_refund_allocation
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_bank_refund_allocation_no_truncate BEFORE TRUNCATE ON bank_refund_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- ---------------------------------------------------------------------------------------------
-- 3. Opening a collection: the operation is recorded and fences the open cycle in one transaction,
--    before anything is sent to the bank. Lock order as every payment path: departure, document
--    order row, cycle. Repeating the call for the same open cycle returns the same operation, so a
--    crash between recording and dispatch never creates a second identity for the same money.

CREATE FUNCTION fn_bank_operation_open(p_purchase_ref text, p_provider text, p_merchant_account text)
RETURNS TABLE (bank_operation_ref text, hold_ref text, amount_kopecks bigint, currency text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_purchase uuid := fn_purchase_id(p_purchase_ref); h seat_hold%ROWTYPE; o orders%ROWTYPE; op bank_operation%ROWTYPE;
  v_amount bigint;
BEGIN
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_-]{1,30}$'
     OR p_merchant_account IS NULL OR p_merchant_account !~ '^[A-Za-z0-9_.:-]{1,100}$' THEN
    RAISE EXCEPTION 'BANK_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM fn_purchase_lock_departure(v_purchase);
  SELECT o2.* INTO o FROM purchase p JOIN orders o2 ON o2.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o2;
  IF o.status <> 'RESERVED' OR o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_CLOSED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO h FROM seat_hold WHERE purchase_id = v_purchase AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOLD_NOT_OPEN' USING ERRCODE = '55000'; END IF;
  IF h.fenced_at IS NOT NULL THEN
    SELECT * INTO op FROM bank_operation b WHERE b.seat_hold_id = h.id;
    IF FOUND AND op.provider = p_provider AND op.merchant_account = p_merchant_account THEN
      RETURN QUERY SELECT op.bank_operation_ref, h.hold_ref, op.amount_kopecks, op.currency, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'HOLD_ALREADY_FENCED' USING ERRCODE = '55000';
  END IF;
  -- The whole purchase at its frozen prices (v1.8.2 §2.2 п.2); a deposit schedule is TOUR-78's (A2b-2).
  SELECT r.total_kopecks INTO v_amount FROM purchase_revision r JOIN purchase p ON p.id = r.purchase_id AND r.revision = p.current_revision
   WHERE p.id = v_purchase;
  INSERT INTO bank_operation (bank_operation_ref, kind, purchase_id, seat_hold_id, provider, merchant_account, amount_kopecks,
      currency, status, created_by)
    VALUES (fn_new_ref('bo'), 'COLLECTION', v_purchase, h.id, p_provider, p_merchant_account, v_amount, 'RUB', 'INTENDED', 'payment')
    RETURNING * INTO op;
  -- 0021's fence: refused once the hold lapsed by the database clock (HOLD_EXPIRED), so an operation
  -- is never recorded for a hold that no longer protects its seats.
  PERFORM fn_purchase_hold_fence(p_purchase_ref, op.bank_operation_ref);
  RETURN QUERY SELECT op.bank_operation_ref, h.hold_ref, op.amount_kopecks, op.currency, false;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 4. Applying an outcome to the seats (internal). Called with the departure, order and operation
--    locked. The operation's status is already final; whatever the seats can or cannot do, the money
--    fact stays. Expected refusals of 0021 open a settlement case; an unexpected error leaves the
--    outcome due (application_error) for maintain() to retry, never rolling the evidence back.

CREATE FUNCTION fn_bank_settlement_open(p_operation uuid, p_reason text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v uuid; v_purchase uuid;
BEGIN
  SELECT purchase_id INTO v_purchase FROM bank_operation WHERE id = p_operation;
  INSERT INTO bank_settlement_case (case_ref, bank_operation_id, purchase_id, reason)
    VALUES (fn_new_ref('bc'), p_operation, v_purchase, p_reason) ON CONFLICT (bank_operation_id, reason) DO NOTHING;
  SELECT id INTO v FROM bank_settlement_case WHERE bank_operation_id = p_operation AND reason = p_reason;
  RETURN v;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_bank_operation_apply_locked(p_operation uuid) RETURNS void
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
  SELECT purchase_ref INTO v_purchase_ref FROM purchase WHERE id = op.purchase_id;
  SELECT * INTO h FROM seat_hold WHERE id = op.seat_hold_id;
  v_was_open := h.closed_at IS NULL;
  BEGIN
    IF op.application_due = 'SUCCEEDED' THEN
      BEGIN
        SELECT c.confirmed, c.no_seat INTO v_confirmed, v_no_seat FROM fn_purchase_payment_confirmed(v_purchase_ref, op.bank_operation_ref) c;
        v_effect := CASE WHEN v_was_open THEN 'SEATS_CONFIRMED' WHEN v_no_seat > 0 THEN 'PAID_NO_SEAT' ELSE 'LATE_CONFIRMED' END;
        IF v_no_seat > 0 THEN v_case := fn_bank_settlement_open(op.id, 'PAID_NO_SEAT'); END IF;
      EXCEPTION WHEN object_not_in_prerequisite_state THEN
        IF SQLERRM NOT IN ('PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS') THEN RAISE; END IF;
        -- The money is the bank's fact (the operation is SUCCEEDED); no seat changes; manual settlement.
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

-- Locks in the payment order (departure, document order, operation) and applies a due outcome.
CREATE FUNCTION fn_bank_operation_lock(p_ref text) RETURNS bank_operation
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE op bank_operation%ROWTYPE;
BEGIN
  SELECT * INTO op FROM bank_operation WHERE bank_operation_ref = p_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_OPERATION_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM fn_purchase_lock_departure(op.purchase_id);
  PERFORM 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id WHERE p.id = op.purchase_id FOR UPDATE OF o;
  SELECT * INTO op FROM bank_operation WHERE id = op.id FOR UPDATE;
  RETURN op;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 5. Recording the bank's evidence. The service has authenticated it (signature, TLS read-back);
--    the database checks that it is about this operation: provider, merchant account, provider
--    operation, amount and currency. Mismatching evidence changes nothing and opens a case.

CREATE FUNCTION fn_bank_operation_record(p_ref text, p_source text, p_observed text, p_provider text, p_merchant_account text,
  p_provider_operation_id text, p_amount_kopecks bigint, p_currency text, p_provider_event_id text, p_payload_sha256 text)
RETURNS TABLE (status text, effect text, seat_effect text, confirmed int, no_seat int, settlement_case_ref text, replayed boolean,
               application_pending boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE op bank_operation%ROWTYPE; e bank_operation_evidence%ROWTYPE; v_matches boolean; v_next text; v_effect text;
  v_case uuid; v_now timestamptz := clock_timestamp(); a bank_operation_application%ROWTYPE; v_replayed boolean := false;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('REGISTRATION_RESPONSE', 'CALLBACK', 'READ_BACK', 'DISPATCH_ERROR')
     OR p_observed IS NULL OR p_observed NOT IN ('REGISTERED', 'SUCCEEDED', 'FAILED', 'UNKNOWN')
     OR p_payload_sha256 IS NULL OR p_payload_sha256 !~ '^[0-9a-f]{64}$'
     -- A final outcome is the bank's own answer: a callback or a read-back (or a definite refusal of
     -- the registration); a transport error proves nothing but UNKNOWN.
     OR (p_observed = 'SUCCEEDED' AND p_source NOT IN ('CALLBACK', 'READ_BACK'))
     OR (p_observed = 'FAILED' AND p_source NOT IN ('REGISTRATION_RESPONSE', 'CALLBACK', 'READ_BACK'))
     OR (p_observed = 'REGISTERED' AND p_source NOT IN ('REGISTRATION_RESPONSE', 'READ_BACK'))
     OR (p_source = 'DISPATCH_ERROR' AND p_observed <> 'UNKNOWN') THEN
    RAISE EXCEPTION 'BANK_EVIDENCE_INVALID' USING ERRCODE = '22023';
  END IF;
  op := fn_bank_operation_lock(p_ref);

  SELECT * INTO e FROM bank_operation_evidence WHERE bank_operation_id = op.id AND payload_sha256 = p_payload_sha256;
  IF FOUND THEN
    -- The same evidence again (a repeated callback): nothing new; a due application is retried.
    v_replayed := true;
    v_effect := e.effect;
  ELSE
    v_matches := (p_provider IS NULL OR p_provider = op.provider)
      AND (p_merchant_account IS NULL OR p_merchant_account = op.merchant_account)
      AND (p_provider_operation_id IS NULL OR op.provider_operation_id IS NULL OR p_provider_operation_id = op.provider_operation_id)
      AND (p_amount_kopecks IS NULL OR p_amount_kopecks = op.amount_kopecks)
      AND (p_currency IS NULL OR p_currency = op.currency);
    -- A final outcome and a registration must name the operation completely.
    IF p_observed IN ('SUCCEEDED', 'REGISTERED') AND (p_provider IS NULL OR p_merchant_account IS NULL OR p_provider_operation_id IS NULL) THEN
      v_matches := false;
    END IF;
    IF p_observed = 'SUCCEEDED' AND (p_amount_kopecks IS NULL OR p_currency IS NULL) THEN v_matches := false; END IF;
    IF p_observed = 'FAILED' AND (p_provider IS NULL OR p_merchant_account IS NULL) THEN v_matches := false; END IF;
    IF p_provider_operation_id IS NOT NULL AND op.provider_operation_id IS NULL AND EXISTS (SELECT 1 FROM bank_operation b
         WHERE b.provider = op.provider AND b.provider_operation_id = p_provider_operation_id AND b.id <> op.id) THEN
      v_matches := false;
    END IF;

    v_next := op.status;
    IF NOT v_matches THEN
      v_effect := 'EVIDENCE_MISMATCH';
    ELSIF op.status = 'SUCCEEDED' AND p_observed = 'FAILED' THEN
      v_effect := 'CONTRADICTORY';
    ELSIF op.status = 'SUCCEEDED' OR (op.status = 'FAILED' AND p_observed <> 'SUCCEEDED') OR op.status = p_observed THEN
      v_effect := 'NO_CHANGE';
    ELSE
      v_next := p_observed;
      v_effect := 'STATUS_CHANGED';
    END IF;

    IF v_effect = 'STATUS_CHANGED' THEN
      UPDATE bank_operation SET status = v_next,
          provider_operation_id = coalesce(provider_operation_id, p_provider_operation_id),
          registered_at = CASE WHEN registered_at IS NULL AND v_next = 'REGISTERED' THEN v_now ELSE registered_at END,
          bank_expires_at = CASE WHEN registered_at IS NULL AND v_next = 'REGISTERED' THEN v_now + interval '1800 seconds' ELSE bank_expires_at END,
          outcome_at = CASE WHEN v_next IN ('SUCCEEDED', 'FAILED') THEN v_now ELSE outcome_at END,
          contradicted_at = CASE WHEN op.status = 'FAILED' AND v_next = 'SUCCEEDED' THEN v_now ELSE contradicted_at END,
          application_due = CASE WHEN kind = 'COLLECTION' AND v_next IN ('SUCCEEDED', 'FAILED') THEN v_next ELSE application_due END
        WHERE id = op.id;
    ELSIF v_matches AND op.provider_operation_id IS NULL AND p_provider_operation_id IS NOT NULL THEN
      UPDATE bank_operation SET provider_operation_id = p_provider_operation_id WHERE id = op.id;
    END IF;
    INSERT INTO bank_operation_evidence (bank_operation_id, source, observed, provider, merchant_account, provider_operation_id,
        amount_kopecks, currency, provider_event_id, payload_sha256, matches, status_before, status_after, effect)
      VALUES (op.id, p_source, p_observed, p_provider, p_merchant_account, p_provider_operation_id, p_amount_kopecks, p_currency,
        p_provider_event_id, p_payload_sha256, v_matches, op.status, v_next, v_effect);
    IF v_effect = 'EVIDENCE_MISMATCH' AND p_observed IN ('SUCCEEDED', 'FAILED') THEN
      PERFORM fn_bank_settlement_open(op.id, 'EVIDENCE_MISMATCH');
    ELSIF v_effect = 'CONTRADICTORY' THEN
      PERFORM fn_bank_settlement_open(op.id, 'CONTRADICTORY_EVIDENCE');
    END IF;
  END IF;

  PERFORM fn_bank_operation_apply_locked(op.id);
  SELECT * INTO op FROM bank_operation WHERE id = op.id;
  SELECT * INTO a FROM bank_operation_application WHERE bank_operation_id = op.id ORDER BY id DESC LIMIT 1;
  SELECT c.id INTO v_case FROM bank_settlement_case c WHERE c.bank_operation_id = op.id ORDER BY c.opened_at DESC, c.id LIMIT 1;
  RETURN QUERY SELECT op.status, v_effect, a.seat_effect, coalesce(a.confirmed, 0), coalesce(a.no_seat, 0),
    (SELECT case_ref FROM bank_settlement_case WHERE id = v_case), v_replayed, op.application_due IS NOT NULL;
END $fn$ LANGUAGE plpgsql;

-- maintain(): retries outcomes whose seat application failed unexpectedly, one operation at a time
-- under the payment lock order. Returns how many were applied.
CREATE FUNCTION fn_bank_operations_apply_due() RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_ref text; v_n int := 0; op bank_operation%ROWTYPE;
BEGIN
  FOR v_ref IN SELECT bank_operation_ref FROM bank_operation WHERE application_due IS NOT NULL ORDER BY created_at LOOP
    op := fn_bank_operation_lock(v_ref);
    CONTINUE WHEN op.application_due IS NULL;
    PERFORM fn_bank_operation_apply_locked(op.id);
    IF (SELECT application_due FROM bank_operation WHERE id = op.id) IS NULL THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 6. Refunds and settlement (TOUR-27): staff with refund.execute only (OWNER, decision 4A).

CREATE FUNCTION fn_bank_refund_open(p_admin_id uuid, p_collection_ref text, p_amount_kopecks bigint, p_reason text)
RETURNS text SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  c bank_operation%ROWTYPE; v_refunded bigint; v_ref text := fn_new_ref('bo');
BEGIN
  SELECT * INTO c FROM bank_operation WHERE bank_operation_ref = p_collection_ref FOR UPDATE;
  IF NOT FOUND OR c.kind <> 'COLLECTION' OR c.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'REFUND_SOURCE_INVALID' USING ERRCODE = '55000';
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

-- Allocates part of a refund the bank confirmed to one obligation, under the refund's row lock: the
-- refund's allocations never exceed its amount, and an obligation is allocated once (UNIQUE).
CREATE FUNCTION fn_bank_refund_allocate(p_refund uuid, p_amount bigint, p_slot uuid, p_case uuid, p_by text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r bank_operation%ROWTYPE; v_allocated bigint;
BEGIN
  SELECT * INTO r FROM bank_operation WHERE id = p_refund FOR UPDATE;
  IF NOT FOUND OR r.kind <> 'REFUND' OR r.status <> 'SUCCEEDED' THEN RAISE EXCEPTION 'REFUND_NOT_CONFIRMED' USING ERRCODE = '55000'; END IF;
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_allocated FROM bank_refund_allocation WHERE refund_operation_id = r.id;
  IF p_amount IS NULL OR p_amount <= 0 OR v_allocated + p_amount > r.amount_kopecks THEN
    RAISE EXCEPTION 'REFUND_INSUFFICIENT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO bank_refund_allocation (refund_operation_id, seat_slot_id, settlement_case_id, amount_kopecks, allocated_by)
    VALUES (r.id, p_slot, p_case, p_amount, p_by);
END $fn$ LANGUAGE plpgsql;

-- REFUNDED: a refund the bank confirmed for this case's collection, allocated for the whole money the
-- case is about (the collection's amount). A PAID_NO_SEAT case is about its seats: it is REFUNDED once
-- every seat that operation left without a place has been settled by its own allocation. Anything
-- else (a partial refund, a seat assigned after all, money kept) is an OWNER_DECISION with a reason.
CREATE FUNCTION fn_bank_settlement_resolve(p_admin_id uuid, p_case_ref text, p_resolution text, p_refund_ref text, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'refund.execute'); v_reason text := fn_staff_reason(p_reason);
  k bank_settlement_case%ROWTYPE; r bank_operation%ROWTYPE; c bank_operation%ROWTYPE;
BEGIN
  SELECT * INTO k FROM bank_settlement_case WHERE case_ref = p_case_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SETTLEMENT_CASE_UNKNOWN' USING ERRCODE = '55000'; END IF;
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

-- 0021's no-seat refund settlement, same signature: the refund is a bank operation the bank confirmed,
-- returning the very collection that left this seat without a place, and the seat's frozen price is
-- allocated from it (once per seat, never beyond the refund's amount).
CREATE OR REPLACE FUNCTION fn_seat_slot_refund_settled(p_slot_ref text, p_refund_ref text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s seat_slot%ROWTYPE; r bank_operation%ROWTYPE; v_price bigint; v_paid_by text;
BEGIN
  SELECT * INTO s FROM seat_slot WHERE seat_slot_ref = p_slot_ref FOR UPDATE;
  IF NOT FOUND OR s.state <> 'PAID_NO_SEAT_EXCEPTION' THEN RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID' USING ERRCODE = '55000'; END IF;
  SELECT e.bank_operation_ref INTO v_paid_by FROM seat_slot_event e
   WHERE e.seat_slot_id = s.id AND e.to_state = 'PAID_NO_SEAT_EXCEPTION' ORDER BY e.id DESC LIMIT 1;
  SELECT * INTO r FROM bank_operation WHERE bank_operation_ref = p_refund_ref;
  IF NOT FOUND OR r.kind <> 'REFUND' OR r.status <> 'SUCCEEDED' OR r.purchase_id <> s.purchase_id
     OR r.refunds_operation_id IS DISTINCT FROM (SELECT id FROM bank_operation WHERE bank_operation_ref = v_paid_by) THEN
    RAISE EXCEPTION 'REFUND_NOT_CONFIRMED' USING ERRCODE = '55000';
  END IF;
  SELECT price_kopecks INTO v_price FROM seat_slot_current WHERE seat_slot_id = s.id;
  PERFORM fn_bank_refund_allocate(r.id, v_price, s.id, NULL, 'refund');
  UPDATE seat_slot SET state = 'REFUND_SETTLED' WHERE id = s.id;
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason, bank_operation_ref)
    VALUES (s.id, s.state, 'REFUND_SETTLED', 'refund', 'NO_SEAT_REFUNDED', r.bank_operation_ref);
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 7. Closure (OWNER 1A, 8B; v1.9.1 §2 п.5): a purchase with an operation in flight or UNKNOWN, or an
--    open settlement case (money the seats could not absorb), is never closed by the retry window.

CREATE OR REPLACE FUNCTION fn_priced_document_order_closable(p_order uuid) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM seat_slot s WHERE s.purchase_id = p.id AND s.state <> 'RELEASED')
     AND NOT EXISTS (SELECT 1 FROM seat_hold h WHERE h.purchase_id = p.id AND h.closed_at IS NULL)
     AND NOT EXISTS (SELECT 1 FROM bank_operation b WHERE b.purchase_id = p.id
                      AND (b.status NOT IN ('SUCCEEDED', 'FAILED') OR b.application_due IS NOT NULL))
     AND NOT EXISTS (SELECT 1 FROM bank_settlement_case k WHERE k.purchase_id = p.id AND k.resolved_at IS NULL)
     AND clock_timestamp() >= least(p.created_at + interval '24 hours',
           (SELECT fn_departure_cutoff(r.departure_id) FROM purchase_revision r WHERE r.purchase_id = p.id AND r.revision = p.current_revision))
    FROM purchase p WHERE p.origin_order_id = p_order
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- 8. Reconciliation views, no personal data: what the read-back worker must ask the bank about, and
--    the open settlement queue (Control Room, TOUR-27/64).

CREATE VIEW bank_operation_pending AS
  SELECT b.bank_operation_ref, b.kind, p.purchase_ref, b.provider, b.merchant_account, b.provider_operation_id, b.amount_kopecks,
         b.currency, b.status, b.created_at, b.registered_at, b.bank_expires_at, b.application_due, b.application_error,
         -- Past the bank's window or never answered: ask the bank (read-back), never charge again blindly.
         (b.status = 'UNKNOWN' OR b.application_due IS NOT NULL
          OR (b.status = 'REGISTERED' AND b.bank_expires_at <= now())
          OR (b.status = 'INTENDED' AND b.created_at <= now() - interval '1 minute')) AS read_back_due
    FROM bank_operation b JOIN purchase p ON p.id = b.purchase_id
   WHERE b.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') OR b.application_due IS NOT NULL;

CREATE VIEW bank_settlement_open AS
  SELECT k.case_ref, k.reason, k.opened_at, b.bank_operation_ref, b.kind, b.amount_kopecks, b.currency, b.status, b.contradicted_at,
         p.purchase_ref
    FROM bank_settlement_case k JOIN bank_operation b ON b.id = k.bank_operation_id JOIN purchase p ON p.id = k.purchase_id
   WHERE k.resolved_at IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 9. Privileges. The service records operations and evidence only through these functions; 0021's
--    fence and outcome functions are no longer its entry points (they run inside them).

REVOKE ALL ON bank_operation, bank_operation_evidence, bank_settlement_case, bank_operation_application,
  bank_refund_allocation, bank_operation_pending, bank_settlement_open FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_bank_operation_guard(), fn_bank_settlement_case_guard(), fn_bank_operation_open(text, text, text),
  fn_bank_settlement_open(uuid, text), fn_bank_operation_apply_locked(uuid), fn_bank_operation_lock(text),
  fn_bank_operation_record(text, text, text, text, text, text, bigint, text, text, text), fn_bank_operations_apply_due(),
  fn_bank_refund_open(uuid, text, bigint, text), fn_bank_settlement_resolve(uuid, text, text, text, text),
  fn_bank_refund_allocate(uuid, bigint, uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fn_purchase_hold_fence(text, text), fn_purchase_payment_failed(text, text),
  fn_purchase_payment_confirmed(text, text) FROM commerce_app;

GRANT SELECT ON bank_operation, bank_settlement_case, bank_operation_application, bank_refund_allocation, bank_operation_pending,
  bank_settlement_open TO commerce_app, admin_app;
GRANT SELECT ON bank_operation_evidence TO commerce_app;
GRANT EXECUTE ON FUNCTION fn_bank_operation_open(text, text, text),
  fn_bank_operation_record(text, text, text, text, text, text, bigint, text, text, text), fn_bank_operations_apply_due() TO commerce_app;
GRANT EXECUTE ON FUNCTION fn_bank_refund_open(uuid, text, bigint, text), fn_bank_settlement_resolve(uuid, text, text, text, text) TO admin_app;
