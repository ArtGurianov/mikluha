-- ART-47 slice 3d: manual ЕИС «Электронная путёвка» filing evidence.
-- Commerce never claims it filed anything. A paid contract creates EIS_PENDING automatically;
-- only a separate operator login can record what was submitted in the ЕИС personal account.

CREATE TABLE order_eis (
  order_id                         uuid PRIMARY KEY REFERENCES orders(id),
  status                           text NOT NULL CHECK (status IN ('EIS_PENDING','EIS_SUBMITTED','EIS_NEEDS_UPDATE')),
  electronic_voucher_number       text CHECK (electronic_voucher_number IS NULL OR
                                      (length(electronic_voucher_number) BETWEEN 1 AND 100
                                       AND electronic_voucher_number !~ '[[:cntrl:]]')),
  submitted_at                     timestamptz,
  submitted_by                     text CHECK (submitted_by IS NULL OR
                                      (length(submitted_by) BETWEEN 1 AND 100 AND submitted_by !~ '[[:cntrl:]]')),
  submitted_login_role             text,
  last_marked_needs_update_at      timestamptz,
  needs_update_reason              text CHECK (needs_update_reason IS NULL OR
                                      (length(needs_update_reason) BETWEEN 1 AND 500
                                       AND needs_update_reason !~ '[[:cntrl:]]')),
  material_revision                bigint NOT NULL DEFAULT 0 CHECK (material_revision >= 0),
  submitted_revision               bigint CHECK (submitted_revision IS NULL OR submitted_revision >= 0),
  created_at                       timestamptz NOT NULL,
  updated_at                       timestamptz NOT NULL,
  CHECK (
    (status = 'EIS_PENDING'
      AND electronic_voucher_number IS NULL AND submitted_at IS NULL AND submitted_by IS NULL
      AND submitted_login_role IS NULL AND last_marked_needs_update_at IS NULL
      AND needs_update_reason IS NULL AND submitted_revision IS NULL)
    OR
    (status = 'EIS_SUBMITTED'
      AND electronic_voucher_number IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_login_role IS NOT NULL AND needs_update_reason IS NULL
      AND submitted_revision = material_revision)
    OR
    (status = 'EIS_NEEDS_UPDATE'
      AND electronic_voucher_number IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by IS NOT NULL
      AND submitted_login_role IS NOT NULL AND last_marked_needs_update_at IS NOT NULL
      AND needs_update_reason IS NOT NULL AND submitted_revision IS NOT NULL
      AND submitted_revision <= material_revision)
  )
);

CREATE TABLE order_eis_event (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id                   uuid NOT NULL REFERENCES orders(id),
  at                         timestamptz NOT NULL,
  from_status                text CHECK (from_status IS NULL OR
                                from_status IN ('EIS_PENDING','EIS_SUBMITTED','EIS_NEEDS_UPDATE')),
  to_status                  text NOT NULL CHECK (to_status IN ('EIS_PENDING','EIS_SUBMITTED','EIS_NEEDS_UPDATE')),
  electronic_voucher_number text,
  changed_by                 text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 100),
  login_role                 text NOT NULL,
  reason                     text CHECK (reason IS NULL OR
                                (length(reason) BETWEEN 1 AND 500 AND reason !~ '[[:cntrl:]]'))
);

-- Internal helper used by material-change triggers. Only a previously submitted filing can become
-- stale; a still-pending filing simply remains pending. Reasons are fixed non-personal codes.
CREATE FUNCTION fn_eis_needs_update_for_order(p_order_id uuid, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_old_status text;
  v_number text;
  v_revision bigint;
BEGIN
  SELECT status, electronic_voucher_number, material_revision INTO v_old_status, v_number, v_revision
    FROM order_eis WHERE order_id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF v_old_status = 'EIS_PENDING' THEN
    UPDATE order_eis SET material_revision = v_revision + 1, updated_at = now()
      WHERE order_id = p_order_id;
  ELSE
    UPDATE order_eis SET status = 'EIS_NEEDS_UPDATE', material_revision = v_revision + 1,
      last_marked_needs_update_at = now(), needs_update_reason = p_reason, updated_at = now()
      WHERE order_id = p_order_id;
    INSERT INTO order_eis_event (order_id, at, from_status, to_status, electronic_voucher_number,
                                 changed_by, login_role, reason)
      VALUES (p_order_id, now(), v_old_status, 'EIS_NEEDS_UPDATE', v_number,
              'system:material-change', session_user, p_reason);
  END IF;
END $fn$ LANGUAGE plpgsql;

-- The first read-back-proven payment creates the filing obligation in the same transaction.
CREATE FUNCTION fn_eis_on_paid_order() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.status IN ('PAID','FULFILLED','REFUNDED') AND OLD.status NOT IN ('PAID','FULFILLED','REFUNDED') THEN
    INSERT INTO order_eis (order_id, status, created_at, updated_at)
      VALUES (NEW.id, 'EIS_PENDING', now(), now()) ON CONFLICT (order_id) DO NOTHING;
    IF FOUND THEN
      INSERT INTO order_eis_event (order_id, at, from_status, to_status, changed_by, login_role, reason)
        VALUES (NEW.id, now(), NULL, 'EIS_PENDING', 'system:payment', session_user, 'PAYMENT_CONFIRMED');
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_eis_on_paid_order AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_eis_on_paid_order();

-- Material contract facts held directly on the order. FULFILLED is only an internal acknowledgement;
-- REFUNDED changes the contract and therefore invalidates an already-submitted filing.
CREATE FUNCTION fn_eis_order_material_change() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.departure_slug IS DISTINCT FROM OLD.departure_slug
     OR NEW.trip_starts_on IS DISTINCT FROM OLD.trip_starts_on
     OR NEW.trip_ends_on IS DISTINCT FROM OLD.trip_ends_on
     OR NEW.seats IS DISTINCT FROM OLD.seats
     OR NEW.unit_price_kopecks IS DISTINCT FROM OLD.unit_price_kopecks
     OR NEW.amount_kopecks IS DISTINCT FROM OLD.amount_kopecks
     OR NEW.discount_kopecks IS DISTINCT FROM OLD.discount_kopecks
     OR NEW.payable_kopecks IS DISTINCT FROM OLD.payable_kopecks
     OR NEW.legal_release_ref IS DISTINCT FROM OLD.legal_release_ref
     OR NEW.legal_release_hash IS DISTINCT FROM OLD.legal_release_hash
     OR NEW.legal_release_content IS DISTINCT FROM OLD.legal_release_content
     OR (NEW.status = 'REFUNDED' AND OLD.status <> 'REFUNDED') THEN
    PERFORM fn_eis_needs_update_for_order(NEW.id, 'CONTRACT_DATA_CHANGED');
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_eis_order_material_change
  AFTER UPDATE OF departure_slug, trip_starts_on, trip_ends_on, seats, unit_price_kopecks,
                  amount_kopecks, discount_kopecks, payable_kopecks, legal_release_ref,
                  legal_release_hash, legal_release_content, status ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_eis_order_material_change();

CREATE FUNCTION fn_eis_passenger_material_change() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_erased_at timestamptz;
BEGIN
  SELECT pd_erased_at INTO v_erased_at FROM orders WHERE id = v_order_id;
  IF v_erased_at IS NULL THEN
    PERFORM fn_eis_needs_update_for_order(v_order_id, 'TOURIST_DATA_CHANGED');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_eis_passenger_material_change
  AFTER INSERT OR UPDATE OR DELETE ON order_passenger
  FOR EACH ROW EXECUTE FUNCTION fn_eis_passenger_material_change();

CREATE FUNCTION fn_eis_contact_material_change() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_order_id uuid := COALESCE(NEW.order_id, OLD.order_id);
  v_erased_at timestamptz;
BEGIN
  SELECT pd_erased_at INTO v_erased_at FROM orders WHERE id = v_order_id;
  IF v_erased_at IS NULL THEN
    PERFORM fn_eis_needs_update_for_order(v_order_id, 'CONTACT_DATA_CHANGED');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_eis_contact_material_change
  AFTER INSERT OR UPDATE OR DELETE ON order_contact
  FOR EACH ROW EXECUTE FUNCTION fn_eis_contact_material_change();

CREATE FUNCTION fn_eis_document_material_change() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  -- Retention erases content but deliberately retains the evidence hash; that is not a factual
  -- contract correction and must not create a filing task years after the trip.
  IF NOT (TG_OP = 'UPDATE' AND NEW.content IS NULL AND NEW.sha256 = OLD.sha256
          AND NEW.created_at = OLD.created_at) THEN
    PERFORM fn_eis_needs_update_for_order(COALESCE(NEW.order_id, OLD.order_id), 'CONTRACT_DOCUMENT_CHANGED');
  END IF;
  RETURN COALESCE(NEW, OLD);
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_eis_document_material_change
  AFTER INSERT OR UPDATE OR DELETE ON order_document
  FOR EACH ROW EXECUTE FUNCTION fn_eis_document_material_change();

CREATE FUNCTION fn_eis_record_submitted(p_order_ref text, p_number text, p_by text, p_expected_revision bigint)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_order_id uuid;
  v_old_status text;
  v_revision bigint;
BEGIN
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'EIS_SERVICE_LOGIN: % belongs to commerce_app', session_user USING ERRCODE = '42501';
  END IF;
  IF p_number IS NULL OR length(btrim(p_number)) NOT BETWEEN 1 AND 100 OR p_number ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EIS_VOUCHER_NUMBER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR p_by ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EIS_OPERATOR_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT e.order_id, e.status, e.material_revision INTO v_order_id, v_old_status, v_revision
    FROM order_eis e JOIN orders o ON o.id = e.order_id
    WHERE o.order_ref = p_order_ref FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIS_ORDER_NOT_PENDING' USING ERRCODE = '55000'; END IF;
  IF v_old_status NOT IN ('EIS_PENDING','EIS_NEEDS_UPDATE') THEN
    RAISE EXCEPTION 'EIS_ALREADY_SUBMITTED' USING ERRCODE = '55000';
  END IF;
  IF p_expected_revision IS NULL OR p_expected_revision <> v_revision THEN
    RAISE EXCEPTION 'EIS_PACKET_STALE: expected %, current %', p_expected_revision, v_revision USING ERRCODE = '55000';
  END IF;

  UPDATE order_eis SET status = 'EIS_SUBMITTED', electronic_voucher_number = btrim(p_number),
    submitted_at = now(), submitted_by = btrim(p_by), submitted_login_role = session_user,
    submitted_revision = v_revision, needs_update_reason = NULL, updated_at = now()
    WHERE order_id = v_order_id;
  INSERT INTO order_eis_event (order_id, at, from_status, to_status, electronic_voucher_number,
                               changed_by, login_role, reason)
    VALUES (v_order_id, now(), v_old_status, 'EIS_SUBMITTED', btrim(p_number),
            btrim(p_by), session_user, 'RECORDED_AFTER_EIS_LK_SUBMISSION');
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_eis_mark_needs_update(p_order_ref text, p_by text, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_order_id uuid;
  v_number text;
BEGIN
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'EIS_SERVICE_LOGIN: % belongs to commerce_app', session_user USING ERRCODE = '42501';
  END IF;
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR p_by ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EIS_OPERATOR_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EIS_REASON_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT e.order_id, e.electronic_voucher_number INTO v_order_id, v_number
    FROM order_eis e JOIN orders o ON o.id = e.order_id
    WHERE o.order_ref = p_order_ref AND e.status = 'EIS_SUBMITTED' FOR UPDATE OF e;
  IF NOT FOUND THEN RAISE EXCEPTION 'EIS_NOT_SUBMITTED' USING ERRCODE = '55000'; END IF;

  UPDATE order_eis SET status = 'EIS_NEEDS_UPDATE', last_marked_needs_update_at = now(),
    needs_update_reason = btrim(p_reason), updated_at = now() WHERE order_id = v_order_id;
  INSERT INTO order_eis_event (order_id, at, from_status, to_status, electronic_voucher_number,
                               changed_by, login_role, reason)
    VALUES (v_order_id, now(), 'EIS_SUBMITTED', 'EIS_NEEDS_UPDATE', v_number,
            btrim(p_by), session_user, btrim(p_reason));
END $fn$ LANGUAGE plpgsql;

-- Migration-time backfill for any paid rows. There should be none before launch, but schema
-- history must still preserve the invariant when applied to a populated staging database.
INSERT INTO order_eis (order_id, status, created_at, updated_at)
  SELECT id, 'EIS_PENDING', COALESCE(paid_at, now()), now() FROM orders
  WHERE status IN ('PAID','FULFILLED','REFUNDED') ON CONFLICT (order_id) DO NOTHING;
INSERT INTO order_eis_event (order_id, at, from_status, to_status, changed_by, login_role, reason)
  SELECT e.order_id, e.created_at, NULL, 'EIS_PENDING', 'system:migration', session_user, 'PAYMENT_CONFIRMED'
  FROM order_eis e WHERE NOT EXISTS (SELECT 1 FROM order_eis_event x WHERE x.order_id = e.order_id);

REVOKE ALL ON order_eis, order_eis_event FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_needs_update_for_order(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_on_paid_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_order_material_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_passenger_material_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_contact_material_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_document_material_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_record_submitted(text, text, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_eis_mark_needs_update(text, text, text) FROM PUBLIC;

GRANT SELECT ON order_eis, order_eis_event TO commerce_operator;
GRANT SELECT ON orders, order_contact, order_passenger, order_document TO commerce_operator;
GRANT EXECUTE ON FUNCTION fn_eis_record_submitted(text, text, text, bigint) TO commerce_operator;
GRANT EXECUTE ON FUNCTION fn_eis_mark_needs_update(text, text, text) TO commerce_operator;
