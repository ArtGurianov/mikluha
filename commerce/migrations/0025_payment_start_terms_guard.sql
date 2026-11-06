-- Track A / A2b (OWNER decision on A2b-10 of 06.11.2026, conditions 1–2 of the final review): no payment
-- starts under terms that have been replaced since the buyer accepted them
-- (docs/decisions/2026-11-06-owner-decision-a2b-10-reacceptance.md; contract §17).
--
-- Forward-only after 0024; 0001–0024 keep their bytes (0021–0024 are merged and are not edited).
--
--   * the attempt starts when its hold is created (v1.9.1 §12) only for the 24-hour window. Whether the
--     terms are still the accepted ones is checked again before anything is registered with the bank:
--     a new bank operation on a live, unfenced hold is refused once the departure has a new published
--     revision (DEPARTURE_CHANGED) or the offer or PD consent has a new release (LEGAL_TERMS_CHANGED);
--   * an operation already registered is never refused: the replay of its identity comes first, under
--     the same locks, and it completes on the terms it was registered under (v1.9.1 §4 п.2);
--   * the legal releases are compared with the purchase's CURRENT revision, not its first document
--     order, so a future re-acceptance (A2b-10) is not refused falsely; the departure version already is;
--   * the same check moves into the database for a new payment cycle: the service passes the current
--     offer and consent releases (code-owned until TOUR-59) and no service path skips the comparison
--     (G-RETRY-03 at the database);
--   * a hold whose terms changed may be released at once by a separate, idempotent command (only an
--     unfenced hold, no bank operation, serialized with the registration), so the buyer need not wait
--     out the five minutes; it closes LAPSED with the event reason TERMS_CHANGED.
--
-- Lock order as every payment path: departure, document order, cycle, seats.

-- ---------------------------------------------------------------------------------------------
-- 1. Whether the purchase's current revision still matches what is published now.

CREATE FUNCTION fn_purchase_terms_refusal(p_purchase uuid, p_legal_release_ref text, p_legal_release_hash text,
  p_pd_consent_ref text, p_pd_consent_hash text) RETURNS text
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE r purchase_revision%ROWTYPE; v_published int;
BEGIN
  SELECT rv.* INTO r FROM purchase p JOIN purchase_revision rv ON rv.purchase_id = p.id AND rv.revision = p.current_revision
   WHERE p.id = p_purchase;
  SELECT published_version INTO v_published FROM departure WHERE id = r.departure_id;
  IF v_published IS DISTINCT FROM r.departure_version THEN RETURN 'DEPARTURE_CHANGED'; END IF;
  IF p_legal_release_ref IS NULL OR p_legal_release_hash IS NULL OR p_pd_consent_ref IS NULL OR p_pd_consent_hash IS NULL
     OR ROW(r.legal_release_ref, r.legal_release_hash, r.pd_consent_ref, r.pd_consent_hash)
        IS DISTINCT FROM ROW(p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash) THEN
    RETURN 'LEGAL_TERMS_CHANGED';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 2. Registering a payment: replay first, then the terms, then the operation.

CREATE FUNCTION fn_bank_operation_open_current(p_purchase_ref text, p_session_token_sha256 text, p_provider text,
  p_merchant_account text, p_legal_release_ref text, p_legal_release_hash text, p_pd_consent_ref text, p_pd_consent_hash text)
RETURNS TABLE (bank_operation_ref text, hold_ref text, amount_kopecks bigint, currency text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_purchase uuid; h seat_hold%ROWTYPE; op bank_operation%ROWTYPE; refusal text;
BEGIN
  -- The arguments first, as fn_bank_operation_open (0022), before any lock.
  IF p_provider IS NULL OR p_provider !~ '^[a-z][a-z0-9_-]{1,30}$'
     OR p_merchant_account IS NULL OR p_merchant_account !~ '^[A-Za-z0-9_.:-]{1,100}$' THEN
    RAISE EXCEPTION 'BANK_OPERATION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_purchase_lock_departure(v_purchase);
  PERFORM 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o;
  SELECT * INTO h FROM seat_hold s WHERE s.purchase_id = v_purchase AND s.closed_at IS NULL FOR UPDATE;
  -- An operation already registered on this cycle: its identity is returned whatever was published since.
  IF FOUND AND h.fenced_at IS NOT NULL THEN
    SELECT * INTO op FROM bank_operation b WHERE b.seat_hold_id = h.id;
    IF FOUND AND op.provider = p_provider AND op.merchant_account = p_merchant_account THEN
      RETURN QUERY SELECT op.bank_operation_ref, h.hold_ref, op.amount_kopecks, op.currency, true;
      RETURN;
    END IF;
    RAISE EXCEPTION 'HOLD_ALREADY_FENCED' USING ERRCODE = '55000';
  END IF;
  refusal := fn_purchase_terms_refusal(v_purchase, p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  RETURN QUERY SELECT * FROM fn_bank_operation_open(p_purchase_ref, p_provider, p_merchant_account);
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 3. A new payment cycle: the terms in the database too (0021 already checks the departure version).

CREATE FUNCTION fn_purchase_rehold_current(p_purchase_ref text, p_session_token_sha256 text, p_legal_release_ref text,
  p_legal_release_hash text, p_pd_consent_ref text, p_pd_consent_hash text)
RETURNS TABLE (hold_ref text, expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid; refusal text;
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_purchase_lock_departure(v_purchase);
  PERFORM 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o;
  refusal := fn_purchase_terms_refusal(v_purchase, p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash);
  -- 0021's order of refusals is kept for the departure (fn_purchase_rehold says DEPARTURE_CHANGED after
  -- its own admission checks); the legal releases are refused here, before any new hold.
  IF refusal = 'LEGAL_TERMS_CHANGED' THEN RAISE EXCEPTION 'LEGAL_TERMS_CHANGED' USING ERRCODE = '55000'; END IF;
  RETURN QUERY SELECT r.hold_ref, r.expires_at FROM fn_purchase_rehold_owned(p_purchase_ref, p_session_token_sha256) r;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 4. Releasing a hold whose terms changed, before its five minutes are up. Separate and committed on its
--    own (an exception would roll a release back); idempotent: false when there is nothing to release.

CREATE FUNCTION fn_purchase_hold_release_stale(p_purchase_ref text, p_session_token_sha256 text, p_legal_release_ref text,
  p_legal_release_hash text, p_pd_consent_ref text, p_pd_consent_hash text) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid; h seat_hold%ROWTYPE;
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  v_purchase := fn_purchase_id(p_purchase_ref);
  PERFORM fn_purchase_lock_departure(v_purchase);
  PERFORM 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o;
  SELECT * INTO h FROM seat_hold s WHERE s.purchase_id = v_purchase AND s.closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR h.fenced_at IS NOT NULL OR EXISTS (SELECT 1 FROM bank_operation b WHERE b.seat_hold_id = h.id)
     OR fn_purchase_terms_refusal(v_purchase, p_legal_release_ref, p_legal_release_hash, p_pd_consent_ref, p_pd_consent_hash) IS NULL THEN
    RETURN false;
  END IF;
  UPDATE seat_hold SET closed_at = clock_timestamp(), outcome = 'LAPSED' WHERE id = h.id;
  WITH r AS (UPDATE seat_slot SET state = 'RELEASED' WHERE purchase_id = v_purchase AND state = 'HELD' RETURNING id)
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason)
    SELECT id, 'HELD', 'RELEASED', h.id, 'checkout', 'TERMS_CHANGED' FROM r;
  RETURN true;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 5. Privileges: the terms-checking commands replace the 0023 entry points for the service.

REVOKE ALL ON FUNCTION fn_purchase_terms_refusal(uuid, text, text, text, text),
  fn_bank_operation_open_current(text, text, text, text, text, text, text, text),
  fn_purchase_rehold_current(text, text, text, text, text, text),
  fn_purchase_hold_release_stale(text, text, text, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fn_bank_operation_open_owned(text, text, text, text), fn_purchase_rehold_owned(text, text) FROM commerce_app;
GRANT EXECUTE ON FUNCTION fn_bank_operation_open_current(text, text, text, text, text, text, text, text),
  fn_purchase_rehold_current(text, text, text, text, text, text),
  fn_purchase_hold_release_stale(text, text, text, text, text, text) TO commerce_app;
