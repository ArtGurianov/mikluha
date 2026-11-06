-- Track A / A2b-11 and A2b-12 for TOUR-28/99: idempotent ordinary checkout and resuming a purchase
-- (docs/plans/2026-11-04-track-a-schema-roles-contract.md §9, §15; OWNER v1.9.1 §9, G-IDEMP-01,
-- G-RESUME-01, G-RESUME-02).
--
-- Forward-only after 0022; 0001–0022 keep their bytes. Nothing is backfilled (0021/0022 are not
-- installed on any working database); the new commit-time rule binds purchases created from now on.
--
--   * a browser checkout session (cookie __Host-…, HttpOnly) is opened before the purchase request;
--     only the SHA-256 of its token is stored. It proves the earlier browser session, not the buyer;
--   * an ordinary checkout needs a server-issued checkout intent of that session: a stable key (stored
--     as SHA-256), consumed once by the purchase it created. The intent's row lock serializes a double
--     click or a lost-response repeat: the second request waits, then answers with the same purchase,
--     or IDEMPOTENCY_CONFLICT when the request or the buyer differs;
--   * at commit, every new PRICED_SLOTS purchase is bound to the session that created it, and an
--     ordinary (not staff-linked) one has consumed its intent: no service path creates a purchase
--     around these rules;
--   * knowing a purchaseRef is not enough: a new payment cycle and a bank operation start only for a
--     session bound to the purchase; on another device, a one-time code sent to the buyer's email binds
--     the new session. A six-digit code is low-entropy: it is stored only as HMAC-SHA256 under a server
--     key that PostgreSQL never sees (a read of this database cannot brute-force it offline); five
--     attempts, fifteen minutes, three per hour (review of PR #88);
--   * the resume view answers from server state only (hold active, payment in progress, released,
--     closed, paid), with no personal data; the return dialog is offered once per session.
--
-- No cookie is set and no route is wired here: connecting the public checkout is TOUR-28's, after the
-- acceptance in the contract; email delivery of the code is TOUR-99's OTP mechanics.

-- ---------------------------------------------------------------------------------------------
-- 1. Sessions, intents, bindings and email codes. No personal data.

CREATE TABLE checkout_session (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_ref  text NOT NULL UNIQUE CHECK (session_ref ~ '^cs-[0-9a-f]{20}$'),
  token_sha256 text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at   timestamptz NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE TABLE checkout_intent (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_intent_ref text NOT NULL UNIQUE CHECK (checkout_intent_ref ~ '^ci-[0-9a-f]{20}$'),
  session_id          uuid NOT NULL REFERENCES checkout_session(id),
  key_sha256          text NOT NULL UNIQUE CHECK (key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at          timestamptz NOT NULL,
  consumed_at         timestamptz,
  purchase_id         uuid UNIQUE REFERENCES purchase(id),
  -- Fingerprint of the accepted request (departure, tickets, terms; no personal data).
  request_sha256      text CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK ((consumed_at IS NULL) = (purchase_id IS NULL) AND (consumed_at IS NULL) = (request_sha256 IS NULL))
);
CREATE INDEX checkout_intent_session ON checkout_intent (session_id);

-- A session's link to a purchase. «Forget on this device» ends a link for good (history stays); a
-- later authorized binding (a one-time email code) of the same session adds a new link, so at most one
-- live link per purchase and session (review of PR #88).
CREATE TABLE purchase_session_binding (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id  uuid NOT NULL REFERENCES purchase(id),
  session_id   uuid NOT NULL REFERENCES checkout_session(id),
  bound_via    text NOT NULL CHECK (bound_via IN ('CHECKOUT', 'EMAIL_CODE')),
  bound_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- The return dialog was offered in this session (once, v1.9.1 §9 п.4).
  prompted_at  timestamptz,
  -- «Забыть на этом устройстве»: only this session's link ends; the purchase is not cancelled.
  forgotten_at timestamptz
);
CREATE UNIQUE INDEX purchase_session_binding_live ON purchase_session_binding (purchase_id, session_id) WHERE forgotten_at IS NULL;
CREATE INDEX purchase_session_binding_session ON purchase_session_binding (session_id);

CREATE TABLE purchase_resume_code (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id         uuid NOT NULL REFERENCES purchase(id),
  code_hmac         text NOT NULL CHECK (code_hmac ~ '^[0-9a-f]{64}$'),
  issued_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at          timestamptz NOT NULL,
  failed_attempts     int NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  superseded_at       timestamptz,
  consumed_at         timestamptz,
  consumed_session_id uuid REFERENCES checkout_session(id),
  CHECK ((consumed_at IS NULL) = (consumed_session_id IS NULL))
);
CREATE INDEX purchase_resume_code_purchase ON purchase_resume_code (purchase_id, issued_at);

-- Guards for every login's DML: identities and hashes never change; consumption, prompting,
-- forgetting and superseding happen once; nothing is deleted.
CREATE FUNCTION fn_checkout_identity_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000'; END IF;
  IF TG_TABLE_NAME = 'checkout_session' THEN
    IF ROW(NEW.id, NEW.session_ref, NEW.token_sha256, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.session_ref, OLD.token_sha256, OLD.created_at, OLD.expires_at) THEN
      RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'checkout_intent' THEN
    IF ROW(NEW.id, NEW.checkout_intent_ref, NEW.session_id, NEW.key_sha256, NEW.created_at, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.checkout_intent_ref, OLD.session_id, OLD.key_sha256, OLD.created_at, OLD.expires_at)
       OR OLD.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
  ELSIF TG_TABLE_NAME = 'purchase_session_binding' THEN
    IF ROW(NEW.id, NEW.purchase_id, NEW.session_id, NEW.bound_via, NEW.bound_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.purchase_id, OLD.session_id, OLD.bound_via, OLD.bound_at)
       OR (OLD.prompted_at IS NOT NULL AND NEW.prompted_at IS DISTINCT FROM OLD.prompted_at)
       OR (OLD.forgotten_at IS NOT NULL AND NEW.forgotten_at IS DISTINCT FROM OLD.forgotten_at) THEN
      RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
  ELSE
    IF ROW(NEW.id, NEW.purchase_id, NEW.code_hmac, NEW.issued_at, NEW.expires_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.purchase_id, OLD.code_hmac, OLD.issued_at, OLD.expires_at)
       OR NEW.failed_attempts < OLD.failed_attempts
       OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
       OR (OLD.consumed_at IS NOT NULL AND ROW(NEW.consumed_at, NEW.consumed_session_id) IS DISTINCT FROM ROW(OLD.consumed_at, OLD.consumed_session_id)) THEN
      RAISE EXCEPTION 'CHECKOUT_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_checkout_session_guard BEFORE UPDATE OR DELETE ON checkout_session
  FOR EACH ROW EXECUTE FUNCTION fn_checkout_identity_guard();
CREATE TRIGGER trg_checkout_intent_guard BEFORE UPDATE OR DELETE ON checkout_intent
  FOR EACH ROW EXECUTE FUNCTION fn_checkout_identity_guard();
CREATE TRIGGER trg_purchase_session_binding_guard BEFORE UPDATE OR DELETE ON purchase_session_binding
  FOR EACH ROW EXECUTE FUNCTION fn_checkout_identity_guard();
CREATE TRIGGER trg_purchase_resume_code_guard BEFORE UPDATE OR DELETE ON purchase_resume_code
  FOR EACH ROW EXECUTE FUNCTION fn_checkout_identity_guard();
CREATE TRIGGER trg_checkout_session_no_truncate BEFORE TRUNCATE ON checkout_session
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_checkout_intent_no_truncate BEFORE TRUNCATE ON checkout_intent
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_session_binding_no_truncate BEFORE TRUNCATE ON purchase_session_binding
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_resume_code_no_truncate BEFORE TRUNCATE ON purchase_resume_code
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- ---------------------------------------------------------------------------------------------
-- 2. Sessions and intents. Lifetimes by the database clock: a session 30 days, an unconsumed
--    intent 24 hours (a consumed one answers its replay for as long as it exists).

CREATE FUNCTION fn_sha256_arg(p_value text, p_code text) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_value IS NULL OR p_value !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION '%', p_code USING ERRCODE = '22023'; END IF;
  RETURN p_value;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_checkout_session_open(p_token_sha256 text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_ref text := fn_new_ref('cs');
BEGIN
  INSERT INTO checkout_session (session_ref, token_sha256, expires_at)
    VALUES (v_ref, fn_sha256_arg(p_token_sha256, 'CHECKOUT_SESSION_INVALID'), clock_timestamp() + interval '30 days');
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- The live session of a cookie token, or CHECKOUT_SESSION_INVALID.
CREATE FUNCTION fn_checkout_session_live(p_token_sha256 text) RETURNS uuid
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM checkout_session WHERE token_sha256 = p_token_sha256 AND expires_at > clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'CHECKOUT_SESSION_INVALID' USING ERRCODE = '55000'; END IF;
  RETURN v;
END $fn$ LANGUAGE plpgsql;

-- Issued before the checkout request, for one session. The same key again in the same session returns
-- the same intent; at most 20 unconsumed live intents per session (anti-abuse, not a product limit).
CREATE FUNCTION fn_checkout_intent_issue(p_session_token_sha256 text, p_key_sha256 text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_session uuid := fn_checkout_session_live(p_session_token_sha256); i checkout_intent%ROWTYPE;
  v_key text := fn_sha256_arg(p_key_sha256, 'CHECKOUT_INTENT_INVALID');
BEGIN
  -- Serializes the anti-abuse count per session.
  PERFORM 1 FROM checkout_session WHERE id = v_session FOR UPDATE;
  SELECT * INTO i FROM checkout_intent WHERE key_sha256 = v_key;
  IF FOUND THEN
    IF i.session_id <> v_session THEN RAISE EXCEPTION 'CHECKOUT_INTENT_INVALID' USING ERRCODE = '55000'; END IF;
    RETURN i.checkout_intent_ref;
  END IF;
  IF (SELECT count(*) FROM checkout_intent WHERE session_id = v_session AND consumed_at IS NULL AND expires_at > clock_timestamp()) >= 20 THEN
    RAISE EXCEPTION 'CHECKOUT_INTENT_LIMIT' USING ERRCODE = '55000';
  END IF;
  INSERT INTO checkout_intent (checkout_intent_ref, session_id, key_sha256, expires_at)
    VALUES (fn_new_ref('ci'), v_session, v_key, clock_timestamp() + interval '24 hours') RETURNING * INTO i;
  RETURN i.checkout_intent_ref;
END $fn$ LANGUAGE plpgsql;

-- First step of the checkout transaction: locks the intent (a concurrent repeat waits here) and
-- returns what it already created, if anything. Only the intent's own session may use it.
CREATE FUNCTION fn_checkout_intent_claim(p_key_sha256 text, p_session_token_sha256 text)
RETURNS TABLE (checkout_intent_ref text, purchase_ref text, document_order_ref text, request_sha256 text)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_session uuid := fn_checkout_session_live(p_session_token_sha256); i checkout_intent%ROWTYPE;
BEGIN
  SELECT * INTO i FROM checkout_intent WHERE key_sha256 = p_key_sha256 FOR UPDATE;
  IF NOT FOUND OR i.session_id <> v_session OR (i.consumed_at IS NULL AND i.expires_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'CHECKOUT_INTENT_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY SELECT i.checkout_intent_ref, p.purchase_ref, o.order_ref, i.request_sha256
    FROM (SELECT 1) x LEFT JOIN purchase p ON p.id = i.purchase_id LEFT JOIN orders o ON o.id = p.origin_order_id;
END $fn$ LANGUAGE plpgsql;

-- In the same transaction, after fn_open_slotted_purchase: the purchase it created consumes the intent
-- (locked by fn_checkout_intent_claim) and is bound to the session.
CREATE FUNCTION fn_checkout_intent_consume(p_key_sha256 text, p_purchase_ref text, p_request_sha256 text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE i checkout_intent%ROWTYPE; v_purchase uuid;
BEGIN
  SELECT id INTO v_purchase FROM purchase WHERE purchase_ref = p_purchase_ref;
  SELECT * INTO i FROM checkout_intent WHERE key_sha256 = p_key_sha256 FOR UPDATE;
  IF NOT FOUND OR i.consumed_at IS NOT NULL OR i.expires_at <= clock_timestamp() OR v_purchase IS NULL
     OR NOT fn_purchase_in_creation(v_purchase) THEN
    RAISE EXCEPTION 'CHECKOUT_INTENT_INVALID' USING ERRCODE = '55000';
  END IF;
  UPDATE checkout_intent SET consumed_at = clock_timestamp(), purchase_id = v_purchase,
      request_sha256 = fn_sha256_arg(p_request_sha256, 'CHECKOUT_INTENT_INVALID')
    WHERE id = i.id;
  INSERT INTO purchase_session_binding (purchase_id, session_id, bound_via) VALUES (v_purchase, i.session_id, 'CHECKOUT');
END $fn$ LANGUAGE plpgsql;

-- A purchase through a staff group link (it has its own one-time key) is bound to the creating session.
CREATE FUNCTION fn_purchase_session_bind_new(p_purchase_ref text, p_session_token_sha256 text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_session uuid := fn_checkout_session_live(p_session_token_sha256); v_purchase uuid;
BEGIN
  SELECT id INTO v_purchase FROM purchase WHERE purchase_ref = p_purchase_ref;
  IF v_purchase IS NULL OR NOT fn_purchase_in_creation(v_purchase) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_IN_CREATION' USING ERRCODE = '55000';
  END IF;
  INSERT INTO purchase_session_binding (purchase_id, session_id, bound_via) VALUES (v_purchase, v_session, 'CHECKOUT')
    ON CONFLICT (purchase_id, session_id) WHERE forgotten_at IS NULL DO NOTHING;
END $fn$ LANGUAGE plpgsql;

-- At commit (G-IDEMP-01, G-RESUME-02): a new PRICED_SLOTS purchase is bound to its creating session,
-- and an ordinary one consumed a checkout intent. Whatever a service login calls, no purchase commits
-- without them.
CREATE FUNCTION fn_purchase_checkout_identity() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM purchase_session_binding WHERE purchase_id = NEW.purchase_id AND bound_via = 'CHECKOUT') THEN
    RAISE EXCEPTION 'CHECKOUT_SESSION_REQUIRED' USING ERRCODE = '55000';
  END IF;
  IF NEW.joined_via = 'ORIGIN' AND NOT EXISTS (SELECT 1 FROM checkout_intent WHERE purchase_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'CHECKOUT_INTENT_REQUIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_purchase_checkout_identity AFTER INSERT ON purchase_group_member
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fn_purchase_checkout_identity();

-- ---------------------------------------------------------------------------------------------
-- 3. Ownership: a session bound to the purchase (and not told to forget it). Every buyer-facing
--    command on an existing purchase checks it in the database; a purchaseRef alone is not enough.

CREATE FUNCTION fn_purchase_session_owns(p_purchase_ref text, p_session_token_sha256 text) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM purchase p JOIN purchase_session_binding b ON b.purchase_id = p.id
                   JOIN checkout_session s ON s.id = b.session_id
                  WHERE p.purchase_ref = p_purchase_ref AND s.token_sha256 = p_session_token_sha256
                    AND s.expires_at > clock_timestamp() AND b.forgotten_at IS NULL)
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_purchase_require_owner(p_purchase_ref text, p_session_token_sha256 text) RETURNS void
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT coalesce(fn_purchase_session_owns(p_purchase_ref, p_session_token_sha256), false) THEN
    RAISE EXCEPTION 'PURCHASE_NOT_OWNED' USING ERRCODE = '42501';
  END IF;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_purchase_rehold_owned(p_purchase_ref text, p_session_token_sha256 text)
RETURNS TABLE (hold_ref text, expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  RETURN QUERY SELECT r.hold_ref, r.expires_at FROM fn_purchase_rehold(p_purchase_ref) r;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_bank_operation_open_owned(p_purchase_ref text, p_session_token_sha256 text, p_provider text, p_merchant_account text)
RETURNS TABLE (bank_operation_ref text, hold_ref text, amount_kopecks bigint, currency text, replayed boolean)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  RETURN QUERY SELECT * FROM fn_bank_operation_open(p_purchase_ref, p_provider, p_merchant_account);
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 4. The return dialog (v1.9.1 §9 п.4–5): server state only, no personal data.

CREATE FUNCTION fn_purchase_resume_view(p_purchase_ref text, p_session_token_sha256 text)
RETURNS TABLE (purchase_ref text, document_order_ref text, departure_slug text, adults int, teens int, children int,
               total_kopecks bigint, state text, hold_expires_at timestamptz, retry_until timestamptz, new_attempt_allowed boolean,
               prompt_due boolean)
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE p purchase%ROWTYPE; o orders%ROWTYPE; r purchase_revision%ROWTYPE; h seat_hold%ROWTYPE; v_state text; v_until timestamptz;
  v_prompt boolean; v_open boolean;
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  SELECT * INTO p FROM purchase WHERE purchase_ref = p_purchase_ref;
  SELECT * INTO o FROM orders WHERE id = p.origin_order_id;
  SELECT * INTO r FROM purchase_revision WHERE purchase_id = p.id AND revision = p.current_revision;
  SELECT * INTO h FROM seat_hold WHERE purchase_id = p.id AND closed_at IS NULL;
  v_until := least(p.created_at + interval '24 hours', fn_departure_cutoff(r.departure_id));
  v_open := o.status = 'RESERVED' AND o.closed_at IS NULL AND o.pd_erased_at IS NULL;
  -- What holds the seats now comes first (review of PR #88): a hold created just before the 24-hour
  -- limit still holds them for its five minutes, and an attempt in flight completes after it. Whether
  -- a new attempt may start is reported separately (new_attempt_allowed).
  v_state := CASE
    WHEN EXISTS (SELECT 1 FROM seat_slot WHERE purchase_id = p.id AND state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION', 'REFUND_SETTLED', 'CANCELLED'))
      THEN 'PAID'
    WHEN h.id IS NOT NULL AND h.fenced_at IS NOT NULL THEN 'PAYMENT_IN_PROGRESS'
    WHEN v_open AND h.id IS NOT NULL AND h.expires_at > clock_timestamp() THEN 'HOLD_ACTIVE'
    WHEN NOT v_open OR clock_timestamp() >= v_until THEN 'CLOSED'
    ELSE 'RELEASED' END;
  SELECT b.prompted_at IS NULL INTO v_prompt FROM purchase_session_binding b JOIN checkout_session s ON s.id = b.session_id
   WHERE b.purchase_id = p.id AND s.token_sha256 = p_session_token_sha256 AND b.forgotten_at IS NULL;
  RETURN QUERY SELECT p.purchase_ref, o.order_ref, d.slug,
      (SELECT count(*)::int FROM seat_slot_current c WHERE c.purchase_id = p.id AND c.ticket_type = 'AGE_18_PLUS'),
      (SELECT count(*)::int FROM seat_slot_current c WHERE c.purchase_id = p.id AND c.ticket_type = 'AGE_14_17'),
      (SELECT count(*)::int FROM seat_slot_current c WHERE c.purchase_id = p.id AND c.ticket_type = 'AGE_0_13'),
      r.total_kopecks, v_state, CASE WHEN v_state = 'HOLD_ACTIVE' THEN h.expires_at END, v_until,
      v_open AND v_state NOT IN ('PAID', 'CLOSED') AND clock_timestamp() < v_until, v_prompt
    FROM departure d WHERE d.id = r.departure_id;
END $fn$ LANGUAGE plpgsql;

-- The purchases this browser session may return to (not forgotten), newest first.
CREATE FUNCTION fn_checkout_session_purchases(p_session_token_sha256 text)
RETURNS TABLE (purchase_ref text, prompt_due boolean, bound_at timestamptz)
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.purchase_ref, b.prompted_at IS NULL, b.bound_at FROM checkout_session s
    JOIN purchase_session_binding b ON b.session_id = s.id JOIN purchase p ON p.id = b.purchase_id
   WHERE s.token_sha256 = p_session_token_sha256 AND s.expires_at > clock_timestamp() AND b.forgotten_at IS NULL
   ORDER BY b.bound_at DESC
$fn$ LANGUAGE sql;

-- The dialog was shown («Продолжить» / «Не сейчас»): true only the first time. «Не сейчас» cancels nothing.
CREATE FUNCTION fn_purchase_resume_prompted(p_purchase_ref text, p_session_token_sha256 text) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_n int;
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  UPDATE purchase_session_binding b SET prompted_at = clock_timestamp() FROM purchase p, checkout_session s
   WHERE p.purchase_ref = p_purchase_ref AND b.purchase_id = p.id AND s.id = b.session_id AND s.token_sha256 = p_session_token_sha256
     AND b.forgotten_at IS NULL AND b.prompted_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END $fn$ LANGUAGE plpgsql;

-- «Забыть на этом устройстве»: ends this session's link only.
CREATE FUNCTION fn_purchase_session_forget(p_purchase_ref text, p_session_token_sha256 text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_purchase_require_owner(p_purchase_ref, p_session_token_sha256);
  UPDATE purchase_session_binding b SET forgotten_at = clock_timestamp() FROM purchase p, checkout_session s
   WHERE p.purchase_ref = p_purchase_ref AND b.purchase_id = p.id AND s.id = b.session_id AND s.token_sha256 = p_session_token_sha256
     AND b.forgotten_at IS NULL;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 5. Another device: a one-time code to the buyer's email (v1.9.1 §9 п.3). The caller never learns
--    whether the email has purchases; the code arrives as HMAC-SHA256 under the server's key
--    (src/checkout-session.ts), never as the code or a plain hash. The resume window is not extended.

-- Issues the same code for each purchase of this buyer email whose contact still exists, superseding
-- its earlier codes; skips a purchase that already had three codes in the last hour. Returns the
-- document orders to send the code to (TOUR-99 delivery).
CREATE FUNCTION fn_purchase_resume_code_issue(p_email text, p_code_hmac text) RETURNS TABLE (order_id uuid)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_code text := fn_sha256_arg(p_code_hmac, 'RESUME_CODE_INVALID'); v record;
BEGIN
  FOR v IN SELECT p.id AS purchase_id, o.id AS order_id FROM order_contact c JOIN orders o ON o.id = c.order_id
             JOIN purchase p ON p.origin_order_id = o.id
            WHERE c.email = p_email AND o.seat_model = 'PRICED_SLOTS' AND o.pd_erased_at IS NULL
            ORDER BY p.id FOR UPDATE OF p LOOP
    CONTINUE WHEN (SELECT count(*) FROM purchase_resume_code k WHERE k.purchase_id = v.purchase_id
                    AND k.issued_at > clock_timestamp() - interval '1 hour') >= 3;
    UPDATE purchase_resume_code SET superseded_at = clock_timestamp()
     WHERE purchase_id = v.purchase_id AND consumed_at IS NULL AND superseded_at IS NULL;
    INSERT INTO purchase_resume_code (purchase_id, code_hmac, expires_at)
      VALUES (v.purchase_id, v_code, clock_timestamp() + interval '15 minutes');
    order_id := v.order_id;
    RETURN NEXT;
  END LOOP;
END $fn$ LANGUAGE plpgsql;

-- Binds the session to every purchase of this email whose live code matches; a wrong code counts an
-- attempt against each live code of the email (five, then the code is dead). Returns the purchases.
CREATE FUNCTION fn_purchase_resume_code_verify(p_email text, p_code_hmac text, p_session_token_sha256 text)
RETURNS TABLE (purchase_ref text)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_session uuid := fn_checkout_session_live(p_session_token_sha256); k record; v_any boolean := false;
BEGIN
  FOR k IN SELECT r.id, r.purchase_id, r.code_hmac, p.purchase_ref FROM purchase_resume_code r
             JOIN purchase p ON p.id = r.purchase_id JOIN orders o ON o.id = p.origin_order_id
             JOIN order_contact c ON c.order_id = o.id
            WHERE c.email = p_email AND r.consumed_at IS NULL AND r.superseded_at IS NULL AND r.failed_attempts < 5
              AND r.expires_at > clock_timestamp()
            ORDER BY r.id FOR UPDATE OF r LOOP
    IF k.code_hmac = p_code_hmac THEN
      UPDATE purchase_resume_code SET consumed_at = clock_timestamp(), consumed_session_id = v_session WHERE id = k.id;
      -- A new live link even if this session once forgot the purchase: the code is the authorization.
      INSERT INTO purchase_session_binding (purchase_id, session_id, bound_via) VALUES (k.purchase_id, v_session, 'EMAIL_CODE')
        ON CONFLICT (purchase_id, session_id) WHERE forgotten_at IS NULL DO NOTHING;
      v_any := true;
      purchase_ref := k.purchase_ref;
      RETURN NEXT;
    ELSE
      UPDATE purchase_resume_code SET failed_attempts = failed_attempts + 1 WHERE id = k.id;
    END IF;
  END LOOP;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 6. Privileges. The raw retry and bank-open commands are no longer the service's entry points.

REVOKE ALL ON checkout_session, checkout_intent, purchase_session_binding, purchase_resume_code FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_checkout_identity_guard(), fn_sha256_arg(text, text), fn_checkout_session_open(text),
  fn_checkout_session_live(text), fn_checkout_intent_issue(text, text), fn_checkout_intent_claim(text, text),
  fn_checkout_intent_consume(text, text, text), fn_purchase_session_bind_new(text, text), fn_purchase_checkout_identity(),
  fn_purchase_session_owns(text, text), fn_purchase_require_owner(text, text), fn_purchase_rehold_owned(text, text),
  fn_bank_operation_open_owned(text, text, text, text), fn_purchase_resume_view(text, text), fn_checkout_session_purchases(text),
  fn_purchase_resume_prompted(text, text), fn_purchase_session_forget(text, text), fn_purchase_resume_code_issue(text, text),
  fn_purchase_resume_code_verify(text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION fn_purchase_rehold(text), fn_bank_operation_open(text, text, text) FROM commerce_app;

GRANT SELECT (id, checkout_intent_ref, session_id, created_at, expires_at, consumed_at, purchase_id) ON checkout_intent TO commerce_app;
GRANT EXECUTE ON FUNCTION fn_checkout_session_open(text), fn_checkout_intent_issue(text, text), fn_checkout_intent_claim(text, text),
  fn_checkout_intent_consume(text, text, text), fn_purchase_session_bind_new(text, text), fn_purchase_session_owns(text, text),
  fn_purchase_rehold_owned(text, text), fn_bank_operation_open_owned(text, text, text, text), fn_purchase_resume_view(text, text),
  fn_checkout_session_purchases(text), fn_purchase_resume_prompted(text, text), fn_purchase_session_forget(text, text),
  fn_purchase_resume_code_issue(text, text), fn_purchase_resume_code_verify(text, text, text) TO commerce_app;
