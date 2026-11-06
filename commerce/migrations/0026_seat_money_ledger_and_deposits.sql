-- Track A / A2b-2 for TOUR-78: the per-seat money ledger, deposits and the remaining balance
-- (docs/plans/2026-11-04-track-a-schema-roles-contract.md §9, §18; OWNER MK-C01 of 29.10.2026 in
-- docs/refref-v10/06-mk-policy-v2.4.md §1, confirmed unchanged by OWNER 06.11.2026).
--
-- Forward-only after 0025; 0001–0025 keep their bytes. Nothing is backfilled: payments of 0022 before this
-- migration (synthetic only) have no allocations and their operations no purpose (read as FULL).
--
--   * MK-C01: the departure carries a nominal deposit per tourist in whole roubles, default 5 000 ₽, set
--     only by its publication (`paymentTerms.depositRub`); a seat's deposit is min(nominal, the seat's
--     frozen price), never rounded up; the pricing basis freezes the nominal with the price;
--   * a payment has a purpose: FULL (the whole purchase, on its payment cycle), DEPOSIT (the sum of the
--     seats' deposits, on its cycle, only before T−72 and only when it is less than the whole price) or
--     BALANCE (what is still owed on confirmed seats, without a hold, by the buyer's session before T−24,
--     one in flight at a time). A deposit confirms the seats like a full payment (v1.8.2 §2.2 п.2);
--   * every confirmed collection is allocated to the seats it paid for, once (a repeated callback
--     allocates nothing again): FULL — each seat's price, DEPOSIT — each seat's deposit, BALANCE — each
--     confirmed seat's remainder. A seat never receives more than its price; money no seat can take opens
--     an UNALLOCATED_MONEY settlement case for TOUR-27;
--   * a BALANCE in flight is replayed first; a NEW one is never opened while money already confirmed for
--     the purchase is not in the ledger (applied first by fn_purchase_apply_due in its own committed
--     statement) or an open settlement case may concern the same debt (no second collection);
--   * a no-seat refund settles the money actually allocated to that seat (a deposit, not the full price);
--   * views: per seat and per purchase — price, deposit, paid, refunded, balance due, deadlines.
--
-- The deposit terms are frozen in the pricing basis; including them in the accepted contract text is the
-- offer's (TOUR-28/35) and is not changed here. Overdue balances cancel nothing (MK-C03).

-- ---------------------------------------------------------------------------------------------
-- 1. The nominal deposit of a departure, written only by its publication (as A2b-8's minor terms).

ALTER TABLE departure ADD COLUMN deposit_nominal_kopecks bigint NOT NULL DEFAULT 500000
  CHECK (deposit_nominal_kopecks > 0 AND deposit_nominal_kopecks % 100 = 0);

CREATE FUNCTION fn_departure_payment_terms_valid(t jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(t, ARRAY['depositRub']) AND fn_json_int(t->'depositRub', 1) AND (t->>'depositRub')::numeric < 10000000000
$fn$ LANGUAGE sql;

-- 0024's validator, same signature, plus the optional paymentTerms key.
CREATE OR REPLACE FUNCTION fn_departure_document_valid(doc jsonb) RETURNS boolean STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(doc - 'organizers' - 'minorTerms' - 'paymentTerms', ARRAY['slug', 'startsOn', 'endsOn', 'departureTime', 'returnTime',
                                                'timezone', 'priceKopecks', 'contract', 'content'])
    AND (NOT doc ? 'minorTerms' OR coalesce(fn_departure_minor_terms_valid(doc->'minorTerms'), false))
    AND (NOT doc ? 'paymentTerms' OR coalesce(fn_departure_payment_terms_valid(doc->'paymentTerms'), false))
    AND CASE WHEN NOT doc ? 'organizers' THEN true
             WHEN jsonb_typeof(doc->'organizers') = 'array' THEN
               (SELECT coalesce(bool_and(jsonb_typeof(o) = 'string' AND (o #>> '{}') ~ '^[a-z0-9][a-z0-9-]{0,99}$'), true)
                       AND count(DISTINCT o) = count(*)
                  FROM jsonb_array_elements(doc->'organizers') o)
             ELSE false END
    AND coalesce(doc->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false)
    AND fn_json_date(doc->'startsOn') IS NOT NULL AND fn_json_date(doc->'endsOn') IS NOT NULL
    AND fn_json_date(doc->'endsOn') >= fn_json_date(doc->'startsOn')
    AND coalesce(doc->>'departureTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false)
    AND coalesce(doc->>'returnTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false)
    AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = doc->>'timezone')
    AND CASE jsonb_typeof(doc->'priceKopecks') WHEN 'null' THEN true
             WHEN 'number' THEN fn_json_int(doc->'priceKopecks', 1) AND (doc->>'priceKopecks')::numeric < 1000000000000
             ELSE false END
    AND (jsonb_typeof(doc->'contract') = 'null' OR fn_departure_contract_shape(doc->'contract'))
    AND jsonb_typeof(doc->'content') = 'object'
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_departure_deposit_guard() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_doc jsonb;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.deposit_nominal_kopecks <> 500000 THEN RAISE EXCEPTION 'DEPARTURE_PAYMENT_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.published_version IS DISTINCT FROM OLD.published_version AND NEW.published_version IS NOT NULL THEN
    SELECT document INTO v_doc FROM departure_revision WHERE departure_id = NEW.id AND version = NEW.published_version;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_PAYMENT_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000'; END IF;
    -- No paymentTerms: the default nominal of MK-C01, 5 000 ₽.
    NEW.deposit_nominal_kopecks := CASE WHEN v_doc ? 'paymentTerms' THEN (v_doc #>> '{paymentTerms,depositRub}')::bigint * 100 ELSE 500000 END;
    RETURN NEW;
  END IF;
  IF NEW.deposit_nominal_kopecks IS DISTINCT FROM OLD.deposit_nominal_kopecks THEN
    RAISE EXCEPTION 'DEPARTURE_PAYMENT_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_deposit_guard BEFORE INSERT OR UPDATE ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_departure_deposit_guard();

-- T−72 (MK-C01): a deposit may be started only before it, by the database clock.
CREATE FUNCTION fn_departure_deposit_cutoff(p_departure uuid) RETURNS timestamptz
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT ((d.starts_on + d.departure_time::time) AT TIME ZONE d.timezone) - interval '72 hours' FROM departure d WHERE d.id = p_departure
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- 2. The pricing basis freezes the nominal with the prices (set at insert from the departure, under the
--    checkout's departure lock; the basis stays immutable afterwards).

ALTER TABLE pricing_basis ADD COLUMN deposit_nominal_kopecks bigint CHECK (deposit_nominal_kopecks > 0);
CREATE FUNCTION fn_pricing_basis_deposit_on_insert() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.deposit_nominal_kopecks := (SELECT deposit_nominal_kopecks FROM departure WHERE id = NEW.departure_id);
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pricing_basis_deposit_on_insert BEFORE INSERT ON pricing_basis
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_basis_deposit_on_insert();

-- A seat's deposit (MK-C01): min(nominal, its price at the purchase's current revision); no nominal
-- frozen (a basis before 0026) means no deposit, full payment only.
CREATE FUNCTION fn_seat_deposit_kopecks(p_slot uuid) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN b.deposit_nominal_kopecks IS NULL THEN c.price_kopecks ELSE least(b.deposit_nominal_kopecks, c.price_kopecks) END
    FROM seat_slot_current c JOIN pricing_basis b ON b.id = c.pricing_basis_id WHERE c.seat_slot_id = p_slot
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- 3. The purpose of a collection; a BALANCE payment has no payment cycle.

ALTER TABLE bank_operation ADD COLUMN purpose text CHECK (purpose IN ('FULL', 'DEPOSIT', 'BALANCE'));
ALTER TABLE bank_operation ADD CONSTRAINT bank_operation_purpose_kind CHECK (kind = 'COLLECTION' OR purpose IS NULL) NOT VALID;
ALTER TABLE bank_operation DROP CONSTRAINT bank_operation_check,
  ADD CONSTRAINT bank_operation_cycle CHECK ((kind = 'COLLECTION' AND purpose IS DISTINCT FROM 'BALANCE') = (seat_hold_id IS NOT NULL));
-- At most one BALANCE payment whose money is not settled in the ledger yet: in flight, or confirmed by the
-- bank with its application still due (review of PR #91: a second collection of the same balance).
CREATE UNIQUE INDEX bank_operation_balance_in_flight ON bank_operation (purchase_id)
  WHERE purpose = 'BALANCE' AND (status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') OR application_due IS NOT NULL);

CREATE FUNCTION fn_bank_operation_purpose_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.purpose IS DISTINCT FROM OLD.purpose THEN RAISE EXCEPTION 'BANK_OPERATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_operation_purpose_immutable BEFORE UPDATE OF purpose ON bank_operation
  FOR EACH ROW EXECUTE FUNCTION fn_bank_operation_purpose_immutable();

ALTER TABLE bank_settlement_case DROP CONSTRAINT bank_settlement_case_reason_check,
  ADD CONSTRAINT bank_settlement_case_reason_check CHECK (reason IN ('PURCHASE_CLOSED_LATE_PAYMENT', 'NEWER_CYCLE_EXISTS', 'PAID_NO_SEAT',
    'EVIDENCE_MISMATCH', 'CONTRADICTORY_EVIDENCE', 'UNALLOCATED_MONEY'));

-- ---------------------------------------------------------------------------------------------
-- 4. The ledger: which seat a confirmed collection paid for, and how much. Append-only for every
--    login; one row per operation and seat; a seat's collected money never exceeds its price.

CREATE TABLE seat_money_allocation (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  bank_operation_id uuid NOT NULL REFERENCES bank_operation(id),
  seat_slot_id      uuid NOT NULL REFERENCES seat_slot(id),
  amount_kopecks    bigint NOT NULL CHECK (amount_kopecks > 0),
  allocated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bank_operation_id, seat_slot_id)
);
CREATE INDEX seat_money_allocation_seat ON seat_money_allocation (seat_slot_id);

CREATE FUNCTION fn_seat_money_allocation_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE op bank_operation%ROWTYPE; v_price bigint; v_paid bigint;
BEGIN
  SELECT * INTO op FROM bank_operation WHERE id = NEW.bank_operation_id;
  IF op.kind <> 'COLLECTION' OR op.status <> 'SUCCEEDED'
     OR op.purchase_id IS DISTINCT FROM (SELECT purchase_id FROM seat_slot WHERE id = NEW.seat_slot_id) THEN
    RAISE EXCEPTION 'SEAT_MONEY_ALLOCATION_INVALID' USING ERRCODE = '55000';
  END IF;
  SELECT price_kopecks INTO v_price FROM seat_slot_current WHERE seat_slot_id = NEW.seat_slot_id;
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_paid FROM seat_money_allocation WHERE seat_slot_id = NEW.seat_slot_id;
  IF v_paid + NEW.amount_kopecks > v_price
     OR (SELECT coalesce(sum(amount_kopecks), 0) FROM seat_money_allocation WHERE bank_operation_id = op.id) + NEW.amount_kopecks > op.amount_kopecks THEN
    RAISE EXCEPTION 'SEAT_MONEY_ALLOCATION_EXCEEDS' USING ERRCODE = '55000';
  END IF;
  NEW.allocated_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_money_allocation_guard BEFORE INSERT ON seat_money_allocation
  FOR EACH ROW EXECUTE FUNCTION fn_seat_money_allocation_guard();
CREATE TRIGGER trg_seat_money_allocation_immutable BEFORE UPDATE OR DELETE ON seat_money_allocation
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_money_allocation_no_truncate BEFORE TRUNCATE ON seat_money_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- The money of one seat: collected, refunded (0022 allocations to the seat), and still owed.
CREATE VIEW seat_money AS
  SELECT c.seat_slot_id, c.seat_slot_ref, c.purchase_id, c.purchase_ref, c.state, c.ticket_type, c.price_kopecks,
         fn_seat_deposit_kopecks(c.seat_slot_id) AS deposit_kopecks,
         coalesce((SELECT sum(a.amount_kopecks) FROM seat_money_allocation a WHERE a.seat_slot_id = c.seat_slot_id), 0) AS paid_kopecks,
         coalesce((SELECT sum(r.amount_kopecks) FROM bank_refund_allocation r WHERE r.seat_slot_id = c.seat_slot_id), 0) AS refunded_kopecks,
         CASE WHEN c.state = 'CONFIRMED'
              THEN c.price_kopecks - coalesce((SELECT sum(a.amount_kopecks) FROM seat_money_allocation a WHERE a.seat_slot_id = c.seat_slot_id), 0)
              ELSE 0 END AS balance_due_kopecks
    FROM seat_slot_current c;

-- The money of one purchase, its deadlines (MK-C01: deposit before T−72, balance due at T−24) and
-- whether a deposit is offered at all (it is not when the deposits add up to the whole price).
CREATE VIEW purchase_money AS
  SELECT p.purchase_ref, sum(m.price_kopecks) AS total_kopecks, sum(m.deposit_kopecks) AS deposit_total_kopecks,
         sum(m.paid_kopecks) AS paid_kopecks, sum(m.refunded_kopecks) AS refunded_kopecks,
         sum(m.balance_due_kopecks) AS balance_due_kopecks,
         fn_departure_deposit_cutoff(r.departure_id) AS deposit_until, fn_departure_cutoff(r.departure_id) AS balance_due_at,
         sum(m.deposit_kopecks) < sum(m.price_kopecks) AS deposit_offered
    FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN seat_money m ON m.purchase_id = p.id
   GROUP BY p.id, p.purchase_ref, r.departure_id;

-- ---------------------------------------------------------------------------------------------
-- 5. Opening a payment with a purpose. FULL and DEPOSIT fence the open cycle (as 0022/0025: replay
--    first, then the terms); BALANCE needs no cycle: the terms were frozen by the first payment (MK-C01),
--    so they are not re-checked, and one BALANCE operation is in flight at a time.

CREATE FUNCTION fn_bank_operation_open_payment(p_purchase_ref text, p_session_token_sha256 text, p_provider text,
  p_merchant_account text, p_legal_release_ref text, p_legal_release_hash text, p_pd_consent_ref text, p_pd_consent_hash text,
  p_purpose text)
RETURNS TABLE (bank_operation_ref text, hold_ref text, amount_kopecks bigint, currency text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_purchase uuid; h seat_hold%ROWTYPE; op bank_operation%ROWTYPE; refusal text; o orders%ROWTYPE; v_departure uuid;
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
  SELECT r.departure_id INTO v_departure FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
   WHERE p.id = v_purchase;

  IF p_purpose = 'BALANCE' THEN
    -- 1. The replay of a BALANCE operation already in flight comes first: returning its identity starts
    --    no new collection (the bank sees the same order number), whatever was found since (review 2 of #91).
    SELECT * INTO op FROM bank_operation b WHERE b.purchase_id = v_purchase AND b.purpose = 'BALANCE'
       AND b.status IN ('INTENDED', 'REGISTERED', 'UNKNOWN') FOR UPDATE;
    IF FOUND THEN
      IF op.provider = p_provider AND op.merchant_account = p_merchant_account THEN
        RETURN QUERY SELECT op.bank_operation_ref, NULL::text, op.amount_kopecks, op.currency, true;
        RETURN;
      END IF;
      RAISE EXCEPTION 'BALANCE_PAYMENT_IN_FLIGHT' USING ERRCODE = '55000';
    END IF;
    -- 2. A NEW collection only once all money the bank confirmed for this purchase is in the ledger: an
    --    application still due means the debt shown is not the debt owed (review of PR #91). Applying it
    --    is fn_purchase_apply_due's, in its own committed statement (an exception here would roll an
    --    application back), which openCollection calls first.
    IF EXISTS (SELECT 1 FROM bank_operation b WHERE b.purchase_id = v_purchase AND b.application_due IS NOT NULL) THEN
      RAISE EXCEPTION 'BALANCE_APPLICATION_PENDING' USING ERRCODE = '55000';
    END IF;
    -- 3. Unsettled money of this purchase that may cover the same debt (all cases but PAID_NO_SEAT, whose
    --    money is already allocated to its own seats) stops a new collection until TOUR-27 resolves it.
    IF EXISTS (SELECT 1 FROM bank_settlement_case k WHERE k.purchase_id = v_purchase AND k.resolved_at IS NULL
                AND k.reason <> 'PAID_NO_SEAT') THEN
      RAISE EXCEPTION 'BALANCE_SETTLEMENT_PENDING' USING ERRCODE = '55000';
    END IF;
    IF clock_timestamp() >= fn_departure_cutoff(v_departure) THEN RAISE EXCEPTION 'BALANCE_WINDOW_CLOSED' USING ERRCODE = '55000'; END IF;
    -- Seats are locked so that the amount owed is the one allocated when the bank confirms it.
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
  IF o.status <> 'RESERVED' OR o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_CLOSED' USING ERRCODE = '55000';
  END IF;
  refusal := fn_purchase_terms_refusal(v_purchase, p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT sum(m.price_kopecks), sum(m.deposit_kopecks) INTO v_total, v_deposit FROM seat_money m WHERE m.purchase_id = v_purchase;
  IF p_purpose = 'DEPOSIT' THEN
    IF clock_timestamp() >= fn_departure_deposit_cutoff(v_departure) THEN RAISE EXCEPTION 'DEPOSIT_WINDOW_CLOSED' USING ERRCODE = '55000'; END IF;
    -- Every seat would be paid in full by its deposit: there is no deposit to offer, only the full payment.
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

-- Applies the due outcomes of one purchase now, each under the payment lock order; its own statement, so
-- what it applies is committed even when the open that follows refuses. Returns how many it applied.
CREATE FUNCTION fn_purchase_apply_due(p_purchase_ref text) RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_ref text; v_n int := 0; op bank_operation%ROWTYPE;
BEGIN
  FOR v_ref IN SELECT b.bank_operation_ref FROM bank_operation b JOIN purchase p ON p.id = b.purchase_id
                WHERE p.purchase_ref = p_purchase_ref AND b.application_due IS NOT NULL ORDER BY b.created_at LOOP
    op := fn_bank_operation_lock(v_ref);
    CONTINUE WHEN op.application_due IS NULL;
    PERFORM fn_bank_operation_apply_locked(op.id);
    IF (SELECT application_due FROM bank_operation WHERE id = op.id) IS NULL THEN v_n := v_n + 1; END IF;
  END LOOP;
  RETURN v_n;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 6. Applying a confirmed collection to the ledger (0022's application, same signature, plus the
--    allocation). Seats an operation confirmed or left without a place receive its money: FULL the
--    price, DEPOSIT the deposit; BALANCE each confirmed seat's remainder. Whatever cannot be allocated
--    opens UNALLOCATED_MONEY; nothing is allocated twice.

CREATE FUNCTION fn_bank_operation_allocate(p_operation uuid) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE op bank_operation%ROWTYPE; s record; v_amount bigint; v_allocated bigint := 0;
BEGIN
  SELECT * INTO op FROM bank_operation WHERE id = p_operation;
  IF op.kind <> 'COLLECTION' OR op.status <> 'SUCCEEDED' OR EXISTS (SELECT 1 FROM seat_money_allocation WHERE bank_operation_id = op.id) THEN
    RETURN NULL;
  END IF;
  IF op.purpose = 'BALANCE' THEN
    FOR s IN SELECT m.seat_slot_id, m.balance_due_kopecks FROM seat_money m JOIN seat_slot x ON x.id = m.seat_slot_id
              WHERE m.purchase_id = op.purchase_id AND m.balance_due_kopecks > 0 ORDER BY x.position LOOP
      v_amount := least(s.balance_due_kopecks, op.amount_kopecks - v_allocated);
      EXIT WHEN v_amount <= 0;
      INSERT INTO seat_money_allocation (bank_operation_id, seat_slot_id, amount_kopecks) VALUES (op.id, s.seat_slot_id, v_amount);
      v_allocated := v_allocated + v_amount;
    END LOOP;
  ELSE
    FOR s IN SELECT DISTINCT e.seat_slot_id, x.position FROM seat_slot_event e JOIN seat_slot x ON x.id = e.seat_slot_id
              WHERE e.bank_operation_ref = op.bank_operation_ref AND e.to_state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION')
              ORDER BY x.position LOOP
      v_amount := CASE WHEN op.purpose = 'DEPOSIT' THEN fn_seat_deposit_kopecks(s.seat_slot_id)
                       ELSE (SELECT price_kopecks FROM seat_slot_current WHERE seat_slot_id = s.seat_slot_id) END;
      v_amount := least(v_amount, op.amount_kopecks - v_allocated,
        (SELECT price_kopecks FROM seat_slot_current WHERE seat_slot_id = s.seat_slot_id)
        - coalesce((SELECT sum(amount_kopecks) FROM seat_money_allocation WHERE seat_slot_id = s.seat_slot_id), 0));
      CONTINUE WHEN v_amount <= 0;
      INSERT INTO seat_money_allocation (bank_operation_id, seat_slot_id, amount_kopecks) VALUES (op.id, s.seat_slot_id, v_amount);
      v_allocated := v_allocated + v_amount;
    END LOOP;
  END IF;
  IF v_allocated < op.amount_kopecks THEN RETURN fn_bank_settlement_open(op.id, 'UNALLOCATED_MONEY'); END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

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
  SELECT purchase_ref INTO v_purchase_ref FROM purchase WHERE id = op.purchase_id;
  SELECT * INTO h FROM seat_hold WHERE id = op.seat_hold_id;
  v_was_open := h.closed_at IS NULL;
  BEGIN
    IF op.purpose = 'BALANCE' THEN
      -- No seat changes state: the seats are confirmed already; the money goes to the ledger.
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

-- ---------------------------------------------------------------------------------------------
-- 7. A no-seat refund settles the money that seat actually received (its deposit or its price), from
--    the collection that paid it (0022's signature; the allocation rule replaces "the seat's price").

CREATE OR REPLACE FUNCTION fn_seat_slot_refund_settled(p_slot_ref text, p_refund_ref text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s seat_slot%ROWTYPE; r bank_operation%ROWTYPE; v_paid bigint; v_paid_by text;
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
  -- The money the seat received; a collection paid before this ledger existed counts as the seat's price.
  SELECT coalesce(sum(amount_kopecks), 0) INTO v_paid FROM seat_money_allocation WHERE seat_slot_id = s.id;
  IF v_paid = 0 THEN SELECT price_kopecks INTO v_paid FROM seat_slot_current WHERE seat_slot_id = s.id; END IF;
  PERFORM fn_bank_refund_allocate(r.id, v_paid, s.id, NULL, 'refund');
  UPDATE seat_slot SET state = 'REFUND_SETTLED' WHERE id = s.id;
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason, bank_operation_ref)
    VALUES (s.id, s.state, 'REFUND_SETTLED', 'refund', 'NO_SEAT_REFUNDED', r.bank_operation_ref);
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 8. The public projection shows the nominal deposit; privileges.

CREATE OR REPLACE VIEW public_departure WITH (security_barrier) AS
  SELECT d.slug, t.slug AS tour_slug, t.title AS tour_title, d.starts_on, d.ends_on, d.departure_time, d.return_time,
         d.timezone, d.price_kopecks, d.capacity, d.contract, d.contract_complete, d.content, d.booking_status, d.is_demo,
         d.published_version, d.minors_allowed, d.minor_min_age, d.child_price_kopecks, d.minor_sales_paused,
         d.deposit_nominal_kopecks
    FROM departure d JOIN tour t ON t.id = d.tour_id
   WHERE d.published_at IS NOT NULL AND d.is_listed AND t.published_at IS NOT NULL AND t.is_listed
     AND NOT EXISTS (
       SELECT 1 FROM departure_organizer x LEFT JOIN content_item o ON o.id = x.organizer_id
        WHERE x.departure_id = d.id
          AND (o.id IS NULL OR o.kind <> 'organizer' OR o.published_at IS NULL OR NOT o.is_listed)
     );

REVOKE ALL ON seat_money_allocation, seat_money, purchase_money FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_deposit_guard(), fn_pricing_basis_deposit_on_insert(), fn_bank_operation_purpose_immutable(),
  fn_seat_money_allocation_guard(), fn_bank_operation_allocate(uuid),
  fn_bank_operation_open_payment(text, text, text, text, text, text, text, text, text), fn_purchase_apply_due(text) FROM PUBLIC;
-- The open with a purpose replaces 0025's for the service (FULL is its former behaviour).
REVOKE EXECUTE ON FUNCTION fn_bank_operation_open_current(text, text, text, text, text, text, text, text) FROM commerce_app;
GRANT SELECT (deposit_nominal_kopecks) ON departure TO commerce_app, admin_app;
GRANT SELECT ON seat_money_allocation, seat_money, purchase_money TO commerce_app, admin_app;
GRANT EXECUTE ON FUNCTION fn_bank_operation_open_payment(text, text, text, text, text, text, text, text, text),
  fn_purchase_apply_due(text) TO commerce_app;
-- Functions inside views run with the reader's EXECUTE privilege.
GRANT EXECUTE ON FUNCTION fn_seat_deposit_kopecks(uuid), fn_departure_deposit_cutoff(uuid), fn_departure_cutoff(uuid) TO commerce_app, admin_app;
