-- PR #46 round 3: no broad departure locks during remote reads/resolution.
ALTER TABLE orders ADD COLUMN resolution_operation_id uuid,
  ADD COLUMN replaces_order_id uuid UNIQUE REFERENCES orders(id);
CREATE FUNCTION fn_replacement_identity_immutable() RETURNS trigger SET search_path=pg_catalog,public AS $fn$
BEGIN
  IF NEW.replaces_order_id IS DISTINCT FROM OLD.replaces_order_id THEN
    RAISE EXCEPTION 'ORDER_REPLACEMENT_IDENTITY_IMMUTABLE' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_replacement_identity_immutable BEFORE UPDATE OF replaces_order_id ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_replacement_identity_immutable();
REVOKE ALL ON FUNCTION fn_replacement_identity_immutable() FROM PUBLIC;

-- Shared by initiations, exclusive only for cancellation. It takes no departure row lock and
-- no ordinary departure advisory lock, so reserve/publish can proceed during a bounded POST.
CREATE FUNCTION fn_lock_departure_initiation(p_slug text) RETURNS void
SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT pg_advisory_xact_lock_shared(hashtextextended('departure-initiation:' || p_slug,0))
$fn$ LANGUAGE sql;
REVOKE ALL ON FUNCTION fn_lock_departure_initiation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lock_departure_initiation(text) TO commerce_app;

CREATE OR REPLACE FUNCTION fn_departure_has_active_orders(p_id uuid,p_slug text) RETURNS boolean
STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $fn$
  SELECT EXISTS(SELECT 1 FROM orders WHERE (departure_id=p_id OR (departure_id IS NULL AND departure_slug=p_slug))
    AND (status IN ('PAYMENT_PENDING','HELD','PAID','FULFILLED') OR (status='RESERVED' AND
      (reserved_until>now() OR resolution_operation_id IS NOT NULL OR snapshot IS NOT NULL
        OR checkout_attempt_id IS NOT NULL OR payment_pending_since IS NOT NULL))))
$fn$ LANGUAGE sql;

CREATE OR REPLACE FUNCTION fn_departure_cancellation_guard() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.cancellation_requested_at IS NOT NULL OR NEW.booking_status = 'CANCELLED' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('departure-initiation:' || OLD.slug, 0));
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || OLD.slug, 0));
  IF OLD.cancellation_requested_at IS NOT NULL AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_IRREVERSIBLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.cancellation_requested_at IS NOT NULL AND NEW.booking_status = 'OPEN' THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_REQUESTED' USING ERRCODE = '55000';
  END IF;
  IF NEW.booking_status = 'CANCELLED' AND EXISTS (SELECT 1 FROM orders WHERE departure_slug = OLD.slug
      AND (status IN ('PAYMENT_PENDING','HELD','PAID','FULFILLED')
        OR (status = 'RESERVED' AND (reserved_until > clock_timestamp() OR snapshot IS NOT NULL OR checkout_attempt_id IS NOT NULL OR payment_pending_since IS NOT NULL OR resolution_operation_id IS NOT NULL)))) THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_UNFINISHED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
