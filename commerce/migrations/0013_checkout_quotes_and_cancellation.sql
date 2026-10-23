-- ART-362 / ADR v2.3 §3, §5. Forward-only; historical orders are never backfilled.
ALTER TABLE orders
  ADD COLUMN accepted_departure_version int,
  ADD CONSTRAINT orders_accepted_departure_revision FOREIGN KEY(departure_id, accepted_departure_version)
    REFERENCES departure_revision(departure_id, version),
  ADD COLUMN quote_issued_at timestamptz,
  ADD COLUMN quote_expires_at timestamptz,
  ADD CONSTRAINT orders_quote_whole CHECK ((quote_issued_at IS NULL) = (quote_expires_at IS NULL)),
  ADD CONSTRAINT orders_quote_window CHECK (quote_expires_at > quote_issued_at
    AND quote_expires_at <= quote_issued_at + interval '15 minutes'
    AND quote_expires_at <= reserved_until AND quote_expires_at <= resolution_expires_at);

CREATE FUNCTION fn_order_quote_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.accepted_departure_version IS DISTINCT FROM OLD.accepted_departure_version THEN
    RAISE EXCEPTION 'ORDER_ACCEPTED_REVISION_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.quote_issued_at IS NOT NULL AND
    ROW(NEW.quote_issued_at, NEW.quote_expires_at, NEW.referral_resolution_id, NEW.terms_version_id,
        NEW.attribution_source, NEW.resolution_expires_at, NEW.discount_kopecks, NEW.payable_kopecks)
    IS DISTINCT FROM
    ROW(OLD.quote_issued_at, OLD.quote_expires_at, OLD.referral_resolution_id, OLD.terms_version_id,
        OLD.attribution_source, OLD.resolution_expires_at, OLD.discount_kopecks, OLD.payable_kopecks) THEN
    RAISE EXCEPTION 'ORDER_QUOTE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_quote_immutable BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_quote_immutable();

-- The application can hold a departure row's share lock without acquiring UPDATE privileges.
-- Same order as editorial writers: row first, then departure advisory lock, then order row.
CREATE FUNCTION fn_lock_checkout_departure(p_slug text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO v_id FROM departure WHERE slug = p_slug FOR SHARE;
  IF v_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || p_slug, 0));
  END IF;
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION fn_lock_checkout_departure(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_lock_checkout_departure(text) TO commerce_app;

-- An ordinary close leaves issued quotes payable. A cancellation request invalidates initiation
-- immediately, but cannot declare cancellation complete while any obligation/seat is unresolved.
ALTER TABLE departure ADD COLUMN cancellation_requested_at timestamptz;
CREATE FUNCTION fn_departure_cancellation_guard() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || OLD.slug, 0));
  IF OLD.cancellation_requested_at IS NOT NULL AND NEW.cancellation_requested_at IS DISTINCT FROM OLD.cancellation_requested_at THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_IRREVERSIBLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.cancellation_requested_at IS NOT NULL AND NEW.booking_status = 'OPEN' THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_REQUESTED' USING ERRCODE = '55000';
  END IF;
  IF NEW.booking_status = 'CANCELLED' AND EXISTS (SELECT 1 FROM orders WHERE departure_slug = OLD.slug
      AND (status IN ('PAYMENT_PENDING','HELD','PAID','FULFILLED')
        OR (status = 'RESERVED' AND (reserved_until > clock_timestamp() OR snapshot IS NOT NULL OR checkout_attempt_id IS NOT NULL OR payment_pending_since IS NOT NULL)))) THEN
    RAISE EXCEPTION 'DEPARTURE_CANCELLATION_UNFINISHED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_cancellation_guard BEFORE UPDATE OF booking_status, cancellation_requested_at ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_departure_cancellation_guard();

CREATE FUNCTION fn_request_departure_cancellation(p_slug text, p_by text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'CANCELLATION_SERVICE_LOGIN' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
     OR p_by IS NULL OR p_reason IS NULL THEN RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED'; END IF;
  UPDATE departure SET booking_status = 'CLOSED', cancellation_requested_at = coalesce(cancellation_requested_at, clock_timestamp())
    WHERE slug = p_slug AND booking_status <> 'CANCELLED';
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN_OR_CANCELLED'; END IF;
  INSERT INTO departure_cancellation_event(departure_slug, actor, reason, login_role) VALUES (p_slug, p_by, p_reason, session_user);
END $fn$ LANGUAGE plpgsql;
CREATE TABLE departure_cancellation_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  departure_slug text NOT NULL REFERENCES departure(slug), at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor text NOT NULL, reason text NOT NULL, login_role text NOT NULL
);
REVOKE ALL ON departure_cancellation_event FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_request_departure_cancellation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_request_departure_cancellation(text, text, text) TO commerce_operator;
GRANT SELECT ON departure_cancellation_event TO commerce_operator;

-- Write once, even before payment. Retention may erase content, retaining the original digest.
CREATE OR REPLACE FUNCTION fn_order_document_frozen() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF ROW(NEW.order_id, NEW.kind, NEW.sha256, NEW.created_at) IS DISTINCT FROM ROW(OLD.order_id, OLD.kind, OLD.sha256, OLD.created_at)
     OR (NEW.content IS DISTINCT FROM OLD.content AND NEW.content IS NOT NULL) THEN
    RAISE EXCEPTION 'ORDER_DOCUMENT_FROZEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_complete_departure_cancellation(p_slug text, p_by text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'CANCELLATION_SERVICE_LOGIN' USING ERRCODE = '42501';
  END IF;
  IF length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
     OR p_by IS NULL OR p_reason IS NULL THEN RAISE EXCEPTION 'CANCELLATION_REASON_REQUIRED'; END IF;
  UPDATE departure SET booking_status = 'CANCELLED'
    WHERE slug = p_slug AND cancellation_requested_at IS NOT NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_CANCELLATION_NOT_REQUESTED'; END IF;
  INSERT INTO departure_cancellation_event(departure_slug, actor, reason, login_role) VALUES (p_slug, p_by, p_reason, session_user);
END $fn$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION fn_complete_departure_cancellation(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_complete_departure_cancellation(text, text, text) TO commerce_operator;
REVOKE ALL ON FUNCTION fn_order_quote_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_cancellation_guard() FROM PUBLIC;

-- Cancellation evidence is append-only, including for direct owner credentials.
CREATE TRIGGER trg_departure_cancellation_event_immutable BEFORE UPDATE OR DELETE ON departure_cancellation_event
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_departure_cancellation_event_no_truncate BEFORE TRUNCATE ON departure_cancellation_event
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
