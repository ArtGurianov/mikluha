-- Track A / TOUR-76 Stage 2 (A2), foundations for TOUR-78/79: priced seat slots, purchase groups,
-- personalization identities and the Control Room role matrix
-- (docs/plans/2026-11-04-track-a-schema-roles-contract.md; OWNER contracts v1.8.2-RC + v1.9.0-RC).
--
-- Forward-only. 0001–0020 keep their bytes; constraints they declared are replaced here by name.
-- Existing orders and purchases stay seat_model/slot_model UNIFORM, their hashes recompute unchanged,
-- nothing is backfilled. No personal data of tourists is added by this migration.
--
--   * no product limit of six seats: 1..500 is a technical request bound only (G-13);
--   * a PRICED_SLOTS purchase buys N priced seats of three ticket types, without any tourist data;
--     each seat (seat_slot) has its own frozen pricing basis; the revision's lines carry the prices
--     and are committed to by the revision hash;
--   * a seat's identity is not its payment cycle: seat_hold is one hold of all the purchase's seats,
--     fenced by one recorded payment attempt and closed once by that attempt's outcome or by lapsing;
--     the database, not the caller, decides CONFIRMED vs PAID_NO_SEAT_EXCEPTION; after an unpaid
--     cycle the same purchase may hold again; no service login can cancel a confirmed seat (TOUR-79);
--   * admission (sales switch, departure open, T−24, quota) and time (a hold's five minutes, its lapse,
--     the retry window) are decided by the database and its clock, whoever calls the SQL;
--   * occupancy counts seats by the current revision's departure (fn_departure_taken_seats, replaced);
--   * every PRICED_SLOTS purchase belongs to one purchase group; a later purchase joins a group only
--     through a staff-issued one-time link (token stored as sha256);
--   * participants, companion assignments and invitations are identities without personal data;
--   * staff permissions: roles OWNER / MANAGER / EDITOR plus separately granted capabilities
--     MODERATOR_CABINET (documents.read, documents.verify) and LEGAL_HOLD (legal_hold.manage).
--
-- Trust boundary as in 0017: invariants hold for every login's DML; trigger-disabling DDL is outside.

-- ---------------------------------------------------------------------------------------------
-- 1. No limit of six (orders.ts MAX_SEATS_PER_ORDER, 0001/0017 CHECKs).

ALTER TABLE orders DROP CONSTRAINT orders_seats_check,
  ADD CONSTRAINT orders_seats_check CHECK (seats BETWEEN 1 AND 500);
ALTER TABLE order_passenger DROP CONSTRAINT order_passenger_position_check,
  ADD CONSTRAINT order_passenger_position_check CHECK (position BETWEEN 1 AND 500);
ALTER TABLE purchase_revision DROP CONSTRAINT purchase_revision_seats_check,
  ADD CONSTRAINT purchase_revision_seats_check CHECK (seats BETWEEN 1 AND 500);
ALTER TABLE purchase_revision_participant DROP CONSTRAINT purchase_revision_participant_position_check,
  ADD CONSTRAINT purchase_revision_participant_position_check CHECK (position BETWEEN 1 AND 500),
  DROP CONSTRAINT purchase_revision_participant_source_position_check,
  ADD CONSTRAINT purchase_revision_participant_source_position_check CHECK (source_position BETWEEN 1 AND 500);

-- ---------------------------------------------------------------------------------------------
-- 2. Seat model of the document order. UNIFORM: amount = unit × seats, adults only (0001–0020).
--    PRICED_SLOTS: unit price = the published adult price (the contract snapshot checks it), amount
--    = sum of the seat lines, no tourist rows, the buyer confirmed the departure's age terms.

ALTER TABLE orders ADD COLUMN seat_model text NOT NULL DEFAULT 'UNIFORM' CHECK (seat_model IN ('UNIFORM', 'PRICED_SLOTS')),
  ADD COLUMN age_terms_confirmed boolean;
ALTER TABLE orders DROP CONSTRAINT orders_check1,
  ADD CONSTRAINT orders_uniform_amount CHECK (seat_model <> 'UNIFORM' OR amount_kopecks = unit_price_kopecks * seats),
  ADD CONSTRAINT orders_amount_positive CHECK (amount_kopecks > 0);
ALTER TABLE orders DROP CONSTRAINT orders_adults_only_confirmed_check,
  ADD CONSTRAINT orders_age_terms CHECK (
    (seat_model = 'UNIFORM' AND adults_only_confirmed AND age_terms_confirmed IS NULL)
    OR (seat_model = 'PRICED_SLOTS' AND NOT adults_only_confirmed AND age_terms_confirmed IS TRUE));

CREATE FUNCTION fn_order_seat_model_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF ROW(NEW.seat_model, NEW.age_terms_confirmed) IS DISTINCT FROM ROW(OLD.seat_model, OLD.age_terms_confirmed) THEN
    RAISE EXCEPTION 'ORDER_SEAT_MODEL_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_seat_model_immutable BEFORE UPDATE OF seat_model, age_terms_confirmed ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_seat_model_immutable();

-- The buyer of a PRICED_SLOTS purchase enters no tourist: names, birth dates and documents arrive
-- later through invitations (TOUR-99/100), never as order_passenger rows.
CREATE FUNCTION fn_priced_slots_no_passenger() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM orders WHERE id = NEW.order_id AND seat_model = 'PRICED_SLOTS') THEN
    RAISE EXCEPTION 'PRICED_SLOTS_NO_TOURIST_DATA' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_priced_slots_no_passenger BEFORE INSERT OR UPDATE ON order_passenger
  FOR EACH ROW EXECUTE FUNCTION fn_priced_slots_no_passenger();

-- ---------------------------------------------------------------------------------------------
-- 3. Departure settings for minors (v1.8.2 §2.1 п.2, §4 п.6). The child price, permission and minimum
--    age are written by the departure's publication (A2b-8); the pause by its audited command (§10).

ALTER TABLE departure ADD COLUMN child_price_kopecks bigint CHECK (child_price_kopecks > 0),
  ADD COLUMN minors_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN minor_min_age int CHECK (minor_min_age BETWEEN 0 AND 17),
  ADD COLUMN minor_sales_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN minor_settings_version int NOT NULL DEFAULT 0 CHECK (minor_settings_version >= 0);

CREATE TABLE departure_minor_event (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  departure_id uuid NOT NULL REFERENCES departure(id),
  at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor        text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  action       text NOT NULL CHECK (action IN ('SETTINGS', 'PAUSE', 'RESUME')),
  reason       text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  version      int NOT NULL,
  details      jsonb NOT NULL CHECK (jsonb_typeof(details) = 'object')
);

-- ---------------------------------------------------------------------------------------------
-- 4. Staff roles and capabilities (contract §7).

ALTER TABLE admin_user DROP CONSTRAINT admin_user_role_check,
  ADD CONSTRAINT admin_user_role_check CHECK (role IN ('OWNER', 'MANAGER', 'EDITOR'));

CREATE TABLE admin_capability_grant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      uuid NOT NULL REFERENCES admin_user(id),
  capability    text NOT NULL CHECK (capability IN ('MODERATOR_CABINET', 'LEGAL_HOLD')),
  granted_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  granted_by    text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 120),
  grant_reason  text NOT NULL CHECK (length(btrim(grant_reason)) BETWEEN 1 AND 500),
  revoked_at    timestamptz,
  revoked_by    text CHECK (length(revoked_by) BETWEEN 1 AND 120),
  revoke_reason text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX admin_capability_grant_active ON admin_capability_grant (admin_id, capability) WHERE revoked_at IS NULL;

-- The role half of the matrix. commerce/src/admin/auth.ts PERMISSIONS must equal it (tested).
CREATE FUNCTION fn_staff_role_permits(p_role text, p_permission text) RETURNS boolean
IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE p_role
    WHEN 'OWNER' THEN p_permission = ANY (ARRAY['editorial.read', 'editorial.draft', 'editorial.publish', 'legal.publish',
      'departure.controls', 'audit.read', 'departure.quota.exception', 'departure.minor_settings', 'minor_sales.pause',
      'minor_sales.resume', 'departure.change.classify', 'transfer.discount', 'purchases.read', 'readiness.view',
      'participants.pd.read', 'participants.pd.correct', 'amendment.record', 'settlement.request', 'refund.execute',
      'paid_no_seat.resolve', 'group_link.issue', 'group_link.revoke', 'companion.assign', 'invitations.support_reissue',
      'insurance.export'])
    -- OWNER decisions 3A/4A (06.11.2026): a manager may pause minors' sales; resuming them, the quota
    -- exception, paid-no-seat resolution and refund execution stay the OWNER's.
    WHEN 'MANAGER' THEN p_permission = ANY (ARRAY['editorial.read', 'minor_sales.pause', 'purchases.read', 'readiness.view',
      'participants.pd.read', 'participants.pd.correct', 'amendment.record', 'settlement.request',
      'group_link.issue', 'group_link.revoke', 'companion.assign', 'invitations.support_reissue', 'insurance.export'])
    WHEN 'EDITOR' THEN p_permission = ANY (ARRAY['editorial.read', 'editorial.draft'])
    ELSE false END
$fn$ LANGUAGE sql;

-- The capability half: these permissions follow an active grant only, whatever the role.
CREATE FUNCTION fn_staff_permission_capability(p_permission text) RETURNS text
IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN p_permission IN ('documents.read', 'documents.verify') THEN 'MODERATOR_CABINET'
              WHEN p_permission = 'legal_hold.manage' THEN 'LEGAL_HOLD' END
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_staff_permission_known(p_permission text) RETURNS boolean
IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_staff_role_permits('OWNER', p_permission) OR fn_staff_permission_capability(p_permission) IS NOT NULL
$fn$ LANGUAGE sql;

-- Whether this account may do this now. Checked by the database inside every staff command, so a
-- revoked grant or a disabled account stops the very next request.
CREATE FUNCTION fn_staff_permitted(p_admin_id uuid, p_permission text) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE u admin_user%ROWTYPE; v_cap text := fn_staff_permission_capability(p_permission);
BEGIN
  IF NOT fn_staff_permission_known(p_permission) THEN
    RAISE EXCEPTION 'STAFF_PERMISSION_UNKNOWN: %', p_permission USING ERRCODE = '22023';
  END IF;
  SELECT * INTO u FROM admin_user WHERE id = p_admin_id;
  IF NOT FOUND OR u.disabled_at IS NOT NULL THEN RETURN false; END IF;
  IF v_cap IS NOT NULL THEN
    RETURN EXISTS (SELECT 1 FROM admin_capability_grant WHERE admin_id = u.id AND capability = v_cap AND revoked_at IS NULL);
  END IF;
  RETURN fn_staff_role_permits(u.role, p_permission);
END $fn$ LANGUAGE plpgsql;

-- Staff commands: refused to the public service's login whatever grants say, and to any account
-- without the permission. Returns the actor recorded in audit.
CREATE FUNCTION fn_staff_require(p_admin_id uuid, p_permission text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'STAFF_SERVICE_LOGIN: % belongs to commerce_app', session_user USING ERRCODE = '42501';
  END IF;
  -- The account row is share-locked for the rest of the command: a grant revocation or a disabling
  -- (they lock it FOR UPDATE) either commits before this check, which then sees it, or waits for the
  -- command to finish. No staff command commits under a permission already revoked.
  PERFORM 1 FROM admin_user WHERE id = p_admin_id FOR SHARE;
  IF NOT fn_staff_permitted(p_admin_id, p_permission) THEN
    RAISE EXCEPTION 'STAFF_FORBIDDEN: %', p_permission USING ERRCODE = '42501';
  END IF;
  RETURN 'staff:' || (SELECT login FROM admin_user WHERE id = p_admin_id);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_staff_reason(p_reason text) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'REASON_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_reason);
END $fn$ LANGUAGE plpgsql;

-- A grant is recorded once and revoked once; nothing else changes and nothing is deleted.
CREATE FUNCTION fn_capability_grant_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'STAFF_GRANT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.id, NEW.admin_id, NEW.capability, NEW.granted_at, NEW.granted_by, NEW.grant_reason)
     IS DISTINCT FROM ROW(OLD.id, OLD.admin_id, OLD.capability, OLD.granted_at, OLD.granted_by, OLD.grant_reason)
     OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'STAFF_GRANT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_capability_grant_guard BEFORE UPDATE OR DELETE ON admin_capability_grant
  FOR EACH ROW EXECUTE FUNCTION fn_capability_grant_guard();

-- Over SSH, by an admin operator, as fn_admin_set_disabled (0011).
CREATE FUNCTION fn_admin_grant_capability(p_login text, p_capability text, p_by text, p_reason text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_admin_operator_actor(p_by); v_reason text := fn_admin_operator_reason(p_reason);
  v_admin uuid := fn_admin_operator_user(p_login); v_id uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM admin_capability_grant WHERE admin_id = v_admin AND capability = p_capability AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'STAFF_GRANT_ACTIVE' USING ERRCODE = '55000';
  END IF;
  INSERT INTO admin_capability_grant (admin_id, capability, granted_by, grant_reason)
    VALUES (v_admin, p_capability, v_by, v_reason) RETURNING id INTO v_id;
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_admin, v_by, 'CAPABILITY.GRANTED', 'OK', 'admin_user', p_login,
            jsonb_build_object('capability', p_capability, 'reason', v_reason));
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_revoke_capability(p_login text, p_capability text, p_by text, p_reason text) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_admin_operator_actor(p_by); v_reason text := fn_admin_operator_reason(p_reason);
  v_admin uuid := fn_admin_operator_user(p_login); v_n int;
BEGIN
  UPDATE admin_capability_grant SET revoked_at = clock_timestamp(), revoked_by = v_by, revoke_reason = v_reason
    WHERE admin_id = v_admin AND capability = p_capability AND revoked_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_admin, v_by, 'CAPABILITY.REVOKED', CASE WHEN v_n > 0 THEN 'OK' ELSE 'NOOP' END, 'admin_user', p_login,
            jsonb_build_object('capability', p_capability, 'reason', v_reason));
  RETURN v_n > 0;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 5. Purchase groups, the frozen pricing basis, seat slots and revision lines.

CREATE TABLE purchase_group (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_group_ref text NOT NULL UNIQUE CHECK (purchase_group_ref ~ '^mg-[0-9a-f]{20}$'),
  departure_id       uuid NOT NULL REFERENCES departure(id),
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE purchase_group_link (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_link_ref       text NOT NULL UNIQUE CHECK (group_link_ref ~ '^gl-[0-9a-f]{20}$'),
  group_id             uuid NOT NULL REFERENCES purchase_group(id),
  token_sha256         text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_by_admin      uuid NOT NULL REFERENCES admin_user(id),
  issued_by            text NOT NULL,
  issued_at            timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at           timestamptz,
  revoked_by           text,
  revoke_reason        text,
  consumed_at          timestamptz,
  consumed_purchase_id uuid UNIQUE REFERENCES purchase(id),
  consumed_key_sha256  text CHECK (consumed_key_sha256 ~ '^[0-9a-f]{64}$'),
  -- Fingerprint of the accepted checkout request (departure, tickets, terms): a repeat of the same
  -- idempotency key with a different request is a conflict, not a replay.
  consumed_request_sha256 text CHECK (consumed_request_sha256 ~ '^[0-9a-f]{64}$'),
  -- The tickets the manager chose (v1.9.0 §2 п.1); the purchase must match them exactly.
  adults               int NOT NULL CHECK (adults >= 0),
  teens                int NOT NULL CHECK (teens >= 0),
  children             int NOT NULL CHECK (children >= 0),
  CHECK (adults + teens + children BETWEEN 1 AND 500),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL)),
  CHECK ((consumed_at IS NULL) = (consumed_purchase_id IS NULL) AND (consumed_at IS NULL) = (consumed_key_sha256 IS NULL)
         AND (consumed_at IS NULL) = (consumed_request_sha256 IS NULL)),
  CHECK (revoked_at IS NULL OR consumed_at IS NULL)
);

CREATE TABLE purchase_group_member (
  purchase_id uuid PRIMARY KEY REFERENCES purchase(id),
  group_id    uuid NOT NULL REFERENCES purchase_group(id),
  joined_via  text NOT NULL CHECK (joined_via IN ('ORIGIN', 'STAFF_LINK')),
  link_id     uuid UNIQUE REFERENCES purchase_group_link(id),
  joined_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((joined_via = 'STAFF_LINK') = (link_id IS NOT NULL))
);

CREATE TABLE pricing_basis (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pricing_basis_ref   text NOT NULL UNIQUE CHECK (pricing_basis_ref ~ '^pb-[0-9a-f]{20}$'),
  source              text NOT NULL CHECK (source IN ('PUBLISHED_GRID')),
  document_order_id   uuid NOT NULL REFERENCES orders(id),
  departure_id        uuid NOT NULL,
  departure_version   int  NOT NULL,
  adult_price_kopecks bigint NOT NULL CHECK (adult_price_kopecks > 0),
  child_price_kopecks bigint CHECK (child_price_kopecks > 0),
  -- The local start date the price was accepted for: age for price is checked on it (G-AGE-04).
  price_departure_on  date NOT NULL,
  timezone            text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
  -- The audited departure_minor_event version whose child price this basis froze.
  minor_settings_version int NOT NULL CHECK (minor_settings_version >= 0),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (departure_id, departure_version) REFERENCES departure_revision(departure_id, version)
);

CREATE FUNCTION fn_pricing_basis_price(p_basis uuid, p_ticket_type text) RETURNS bigint
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE p_ticket_type WHEN 'AGE_0_13' THEN coalesce(b.child_price_kopecks, b.adult_price_kopecks)
                            WHEN 'AGE_14_17' THEN b.adult_price_kopecks
                            WHEN 'AGE_18_PLUS' THEN b.adult_price_kopecks END
    FROM pricing_basis b WHERE b.id = p_basis
$fn$ LANGUAGE sql;

-- One payment cycle of a purchase (OWNER 2A, v1.9.0 §2 п.1, §4): a provisional hold of all its
-- seats until expires_at (at most five minutes until the bank registration); fenced when the payment
-- attempt is recorded before it lapses, and then kept until that attempt's outcome; closed once:
-- PAID / PAYMENT_FAILED for the fenced attempt, LAPSED for an unfenced hold past its time. After a
-- proven failure or a lapse the same purchase may open a new cycle (a new hold); seats, prices and
-- the earlier cycles stay. The seat's identity (seat_slot) is not the hold and not the attempt.
CREATE TABLE seat_hold (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hold_ref    text NOT NULL UNIQUE CHECK (hold_ref ~ '^sh-[0-9a-f]{20}$'),
  purchase_id uuid NOT NULL REFERENCES purchase(id),
  cycle       int  NOT NULL CHECK (cycle >= 1),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at  timestamptz NOT NULL,
  fenced_at   timestamptz,
  -- The payment attempt's identity (TOUR-77): one attempt, one hold.
  attempt_ref text UNIQUE CHECK (attempt_ref ~ '^[A-Za-z0-9_:.-]{1,100}$'),
  closed_at   timestamptz,
  outcome     text CHECK (outcome IN ('PAID', 'PAYMENT_FAILED', 'LAPSED')),
  UNIQUE (purchase_id, cycle),
  CHECK ((fenced_at IS NULL) = (attempt_ref IS NULL)),
  CHECK ((closed_at IS NULL) = (outcome IS NULL)),
  CHECK (outcome IS NULL OR (outcome = 'LAPSED') = (fenced_at IS NULL))
);
CREATE UNIQUE INDEX seat_hold_open ON seat_hold (purchase_id) WHERE closed_at IS NULL;

-- A cycle follows a closed, unpaid one; it is fenced once, before it lapses by the database clock,
-- and closed once. Nothing else changes and nothing is deleted.
CREATE FUNCTION fn_seat_hold_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE prev seat_hold%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SEAT_HOLD_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO prev FROM seat_hold WHERE purchase_id = NEW.purchase_id ORDER BY cycle DESC LIMIT 1;
    -- 2A by the database clock: a hold lasts at most five minutes from its creation.
    IF NEW.expires_at IS NULL OR NEW.expires_at <= clock_timestamp() OR NEW.expires_at > clock_timestamp() + interval '5 minutes' THEN
      RAISE EXCEPTION 'HOLD_WINDOW_INVALID' USING ERRCODE = '22023';
    END IF;
    IF NEW.cycle IS DISTINCT FROM coalesce(prev.cycle, 0) + 1 OR NEW.fenced_at IS NOT NULL OR NEW.closed_at IS NOT NULL
       OR (prev.id IS NULL AND NOT fn_purchase_in_creation(NEW.purchase_id))
       OR (prev.id IS NOT NULL AND prev.outcome IS DISTINCT FROM 'PAYMENT_FAILED' AND prev.outcome IS DISTINCT FROM 'LAPSED') THEN
      RAISE EXCEPTION 'SEAT_HOLD_SEQUENCE' USING ERRCODE = '55000';
    END IF;
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.id, NEW.hold_ref, NEW.purchase_id, NEW.cycle, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.hold_ref, OLD.purchase_id, OLD.cycle, OLD.created_at, OLD.expires_at)
     OR OLD.closed_at IS NOT NULL
     OR (OLD.fenced_at IS NOT NULL AND ROW(NEW.fenced_at, NEW.attempt_ref) IS DISTINCT FROM ROW(OLD.fenced_at, OLD.attempt_ref)) THEN
    RAISE EXCEPTION 'SEAT_HOLD_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF OLD.fenced_at IS NULL AND NEW.fenced_at IS NOT NULL AND (OLD.expires_at <= clock_timestamp() OR NEW.closed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'HOLD_EXPIRED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_hold_guard BEFORE INSERT OR UPDATE OR DELETE ON seat_hold
  FOR EACH ROW EXECUTE FUNCTION fn_seat_hold_guard();

-- HELD                    held by the purchase's open seat_hold
-- CONFIRMED               a permanent contractual seat (its hold closed PAID, or a later bank success
--                         that found a free seat)
-- RELEASED                the hold closed unpaid (PAYMENT_FAILED or LAPSED)
-- PAID_NO_SEAT_EXCEPTION  bank-confirmed money, no seat: never counted as occupancy (3A)
-- REFUND_SETTLED          the exception settled by refund (TOUR-27)
-- CANCELLED               a confirmed seat cancelled; only a TOUR-79 amendment revision may do it
--                         (contract A2b-3): no service function performs it in 0021
CREATE TABLE seat_slot (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_slot_ref    text NOT NULL UNIQUE CHECK (seat_slot_ref ~ '^ss-[0-9a-f]{20}$'),
  purchase_id      uuid NOT NULL REFERENCES purchase(id),
  position         int  NOT NULL CHECK (position BETWEEN 1 AND 500),
  pricing_basis_id uuid NOT NULL REFERENCES pricing_basis(id),
  state            text NOT NULL CHECK (state IN ('HELD', 'CONFIRMED', 'RELEASED', 'PAID_NO_SEAT_EXCEPTION',
                                                  'REFUND_SETTLED', 'CANCELLED')),
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (purchase_id, position)
);

CREATE TABLE seat_slot_event (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seat_slot_id       uuid NOT NULL REFERENCES seat_slot(id),
  at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  from_state         text,
  to_state           text NOT NULL,
  seat_hold_id       uuid REFERENCES seat_hold(id),
  actor              text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120),
  reason             text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  bank_operation_ref text CHECK (bank_operation_ref ~ '^[A-Za-z0-9_:.-]{1,100}$')
);
CREATE INDEX seat_slot_event_slot ON seat_slot_event (seat_slot_id);

CREATE TABLE purchase_revision_line (
  purchase_id      uuid NOT NULL,
  revision         int  NOT NULL,
  seat_slot_id     uuid NOT NULL REFERENCES seat_slot(id),
  ticket_type      text NOT NULL CHECK (ticket_type IN ('AGE_0_13', 'AGE_14_17', 'AGE_18_PLUS')),
  pricing_basis_id uuid NOT NULL REFERENCES pricing_basis(id),
  price_kopecks    bigint NOT NULL CHECK (price_kopecks > 0),
  PRIMARY KEY (purchase_id, revision, seat_slot_id),
  -- Lines precede their revision in the same transaction: the revision hash commits to them.
  FOREIGN KEY (purchase_id, revision) REFERENCES purchase_revision(purchase_id, revision) DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE purchase_revision ADD COLUMN slot_model text NOT NULL DEFAULT 'UNIFORM' CHECK (slot_model IN ('UNIFORM', 'PRICED_SLOTS')),
  ADD COLUMN lines_sha256 text CHECK (lines_sha256 ~ '^sha256:[0-9a-f]{64}$');
ALTER TABLE purchase_revision DROP CONSTRAINT purchase_revision_check,
  ADD CONSTRAINT purchase_revision_uniform_total CHECK (slot_model <> 'UNIFORM' OR total_kopecks = unit_price_kopecks * seats),
  ADD CONSTRAINT purchase_revision_total_positive CHECK (total_kopecks > 0);
-- Was cardinality(participant_refs) = seats: a paid seat now exists before its tourist.
ALTER TABLE purchase_revision DROP CONSTRAINT purchase_revision_check1,
  ADD CONSTRAINT purchase_revision_participants CHECK (array_position(participant_refs, NULL) IS NULL AND (
    (slot_model = 'UNIFORM' AND cardinality(participant_refs) = seats AND lines_sha256 IS NULL)
    OR (slot_model = 'PRICED_SLOTS' AND cardinality(participant_refs) = 0 AND lines_sha256 IS NOT NULL)));

-- Digest of a revision's lines, ordered by seat position. No personal data.
CREATE FUNCTION fn_purchase_lines_sha256(p_purchase uuid, p_revision int) RETURNS text
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_array(s.seat_slot_ref, l.ticket_type,
           l.price_kopecks, b.pricing_basis_ref) ORDER BY s.position), '[]'::jsonb)::text, 'UTF8')), 'hex')
    FROM purchase_revision_line l JOIN seat_slot s ON s.id = l.seat_slot_id JOIN pricing_basis b ON b.id = l.pricing_basis_id
   WHERE l.purchase_id = p_purchase AND l.revision = p_revision
$fn$ LANGUAGE sql;

-- Same JSON as 0017 for UNIFORM revisions (their hashes recompute unchanged); PRICED_SLOTS
-- revisions also commit to the seat model and the digest of their lines.
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
            THEN jsonb_build_object('slotModel', r.slot_model, 'linesSha256', r.lines_sha256) ELSE '{}'::jsonb END)::text,
    'UTF8')), 'hex')
$fn$ LANGUAGE sql;

-- A revision's seat model is its document order's; PRICED_SLOTS has no quote replacement.
CREATE FUNCTION fn_purchase_revision_slot_model() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.slot_model IS DISTINCT FROM (SELECT seat_model FROM orders WHERE id = NEW.document_order_id)
     OR (NEW.slot_model = 'PRICED_SLOTS' AND NEW.basis <> 'INITIAL') THEN
    RAISE EXCEPTION 'PURCHASE_REVISION_DOCUMENT_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_revision_slot_model BEFORE INSERT ON purchase_revision
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_revision_slot_model();

-- Rows of a purchase being created (its document order was created by this transaction).
CREATE FUNCTION fn_purchase_in_creation(p_purchase uuid) RETURNS boolean
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM purchase p JOIN orders o ON o.id = p.origin_order_id
    WHERE p.id = p_purchase AND o.created_xact_id = pg_current_xact_id() AND o.created_xact_at = transaction_timestamp())
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_pricing_basis_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE o orders%ROWTYPE;
BEGIN
  SELECT * INTO o FROM orders WHERE id = NEW.document_order_id;
  IF NOT FOUND OR o.seat_model <> 'PRICED_SLOTS' OR o.created_xact_id IS DISTINCT FROM pg_current_xact_id()
     OR o.created_xact_at IS DISTINCT FROM transaction_timestamp()
     OR ROW(NEW.departure_id, NEW.departure_version, NEW.adult_price_kopecks, NEW.price_departure_on, NEW.timezone)
        IS DISTINCT FROM ROW(o.departure_id, o.accepted_departure_version, o.unit_price_kopecks, o.trip_starts_on, o.trip_timezone)
     OR NOT EXISTS (SELECT 1 FROM departure d WHERE d.id = NEW.departure_id
          AND d.child_price_kopecks IS NOT DISTINCT FROM NEW.child_price_kopecks AND d.minor_settings_version = NEW.minor_settings_version) THEN
    RAISE EXCEPTION 'PRICING_BASIS_MISMATCH' USING ERRCODE = '55000';
  END IF;
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pricing_basis_on_insert BEFORE INSERT ON pricing_basis
  FOR EACH ROW EXECUTE FUNCTION fn_pricing_basis_on_insert();

CREATE FUNCTION fn_seat_slot_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT fn_purchase_in_creation(NEW.purchase_id) OR NEW.state <> 'HELD'
     OR NOT EXISTS (SELECT 1 FROM seat_hold WHERE purchase_id = NEW.purchase_id AND cycle = 1 AND closed_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM pricing_basis b JOIN purchase p ON p.origin_order_id = b.document_order_id
                    WHERE b.id = NEW.pricing_basis_id AND p.id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'SEAT_SLOT_CREATION_INVALID' USING ERRCODE = '55000';
  END IF;
  NEW.created_at := clock_timestamp();
  NEW.state_changed_at := NEW.created_at;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_slot_on_insert BEFORE INSERT ON seat_slot
  FOR EACH ROW EXECUTE FUNCTION fn_seat_slot_on_insert();

-- Identity is fixed; the state moves only along the contract's transitions, consistently with the
-- purchase's holds, for every login: a held seat is confirmed only when its hold closed PAID (so an
-- unprotected, lapsed hold is never confirmed); it is released only once its hold closed unpaid (a
-- fenced hold, i.e. an UNKNOWN attempt, keeps its seats until the attempt's outcome); a released
-- seat is held again only by a new open, unfenced, unexpired cycle.
CREATE FUNCTION fn_seat_slot_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE h seat_hold%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.id, NEW.seat_slot_ref, NEW.purchase_id, NEW.position, NEW.pricing_basis_id, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.seat_slot_ref, OLD.purchase_id, OLD.position, OLD.pricing_basis_id, OLD.created_at) THEN
    RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    SELECT * INTO h FROM seat_hold WHERE purchase_id = NEW.purchase_id ORDER BY cycle DESC LIMIT 1;
    -- IS NOT TRUE: a missing hold makes the condition NULL, which must refuse, not pass.
    IF ((OLD.state = 'HELD' AND NEW.state = 'CONFIRMED' AND h.outcome = 'PAID')
         OR (OLD.state = 'HELD' AND NEW.state = 'RELEASED' AND h.outcome IN ('PAYMENT_FAILED', 'LAPSED'))
         OR (OLD.state = 'RELEASED' AND NEW.state = 'HELD' AND h.closed_at IS NULL AND h.fenced_at IS NULL
             AND h.expires_at > clock_timestamp())
         OR (OLD.state = 'RELEASED' AND NEW.state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION') AND h.closed_at IS NOT NULL)
         OR (OLD.state = 'PAID_NO_SEAT_EXCEPTION' AND NEW.state IN ('CONFIRMED', 'REFUND_SETTLED'))
         OR (OLD.state = 'CONFIRMED' AND NEW.state = 'CANCELLED')) IS NOT TRUE THEN
      RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
    END IF;
    NEW.state_changed_at := clock_timestamp();
  ELSIF NEW.state_changed_at IS DISTINCT FROM OLD.state_changed_at THEN
    RAISE EXCEPTION 'SEAT_SLOT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_slot_guard BEFORE UPDATE OR DELETE ON seat_slot
  FOR EACH ROW EXECUTE FUNCTION fn_seat_slot_guard();

-- A line belongs to its purchase's slot, at the price its pricing basis gives the ticket type, and
-- is written before its revision exists (so the revision's hash covers every line).
CREATE FUNCTION fn_purchase_line_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM seat_slot WHERE id = NEW.seat_slot_id AND purchase_id = NEW.purchase_id
                   AND pricing_basis_id = NEW.pricing_basis_id)
     OR NEW.price_kopecks IS DISTINCT FROM fn_pricing_basis_price(NEW.pricing_basis_id, NEW.ticket_type)
     OR EXISTS (SELECT 1 FROM purchase_revision WHERE purchase_id = NEW.purchase_id AND revision = NEW.revision)
     OR NOT fn_purchase_in_creation(NEW.purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_LINE_INVALID' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_purchase_line_on_insert BEFORE INSERT ON purchase_revision_line
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_line_on_insert();

CREATE FUNCTION fn_group_member_on_insert() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT fn_purchase_in_creation(NEW.purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_GROUP_MEMBERSHIP_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.joined_via = 'STAFF_LINK' AND NOT EXISTS (SELECT 1 FROM purchase_group_link
       WHERE id = NEW.link_id AND group_id = NEW.group_id AND consumed_purchase_id = NEW.purchase_id) THEN
    RAISE EXCEPTION 'PURCHASE_GROUP_MEMBERSHIP_INVALID' USING ERRCODE = '55000';
  END IF;
  IF NEW.joined_via = 'ORIGIN' AND EXISTS (SELECT 1 FROM purchase_group_member WHERE group_id = NEW.group_id) THEN
    RAISE EXCEPTION 'PURCHASE_GROUP_MEMBERSHIP_INVALID' USING ERRCODE = '55000';
  END IF;
  NEW.joined_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_group_member_on_insert BEFORE INSERT ON purchase_group_member
  FOR EACH ROW EXECUTE FUNCTION fn_group_member_on_insert();

-- A link is issued once, then consumed once or revoked once.
CREATE FUNCTION fn_group_link_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'GROUP_LINK_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF ROW(NEW.id, NEW.group_link_ref, NEW.group_id, NEW.token_sha256, NEW.issued_by_admin, NEW.issued_by, NEW.issued_at,
         NEW.adults, NEW.teens, NEW.children)
     IS DISTINCT FROM ROW(OLD.id, OLD.group_link_ref, OLD.group_id, OLD.token_sha256, OLD.issued_by_admin, OLD.issued_by, OLD.issued_at,
         OLD.adults, OLD.teens, OLD.children)
     OR OLD.revoked_at IS NOT NULL OR OLD.consumed_at IS NOT NULL THEN
    RAISE EXCEPTION 'GROUP_LINK_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_group_link_guard BEFORE UPDATE OR DELETE ON purchase_group_link
  FOR EACH ROW EXECUTE FUNCTION fn_group_link_guard();

-- Append-only history, TRUNCATE included.
CREATE TRIGGER trg_pricing_basis_immutable BEFORE UPDATE OR DELETE ON pricing_basis
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_line_immutable BEFORE UPDATE OR DELETE ON purchase_revision_line
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_slot_event_immutable BEFORE UPDATE OR DELETE ON seat_slot_event
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_group_immutable BEFORE UPDATE OR DELETE ON purchase_group
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_group_member_immutable BEFORE UPDATE OR DELETE ON purchase_group_member
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_departure_minor_event_immutable BEFORE UPDATE OR DELETE ON departure_minor_event
  FOR EACH ROW EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_pricing_basis_no_truncate BEFORE TRUNCATE ON pricing_basis
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_line_no_truncate BEFORE TRUNCATE ON purchase_revision_line
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_slot_no_truncate BEFORE TRUNCATE ON seat_slot
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_hold_no_truncate BEFORE TRUNCATE ON seat_hold
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_slot_event_no_truncate BEFORE TRUNCATE ON seat_slot_event
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_purchase_group_no_truncate BEFORE TRUNCATE ON purchase_group
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_group_member_no_truncate BEFORE TRUNCATE ON purchase_group_member
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_group_link_no_truncate BEFORE TRUNCATE ON purchase_group_link
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_departure_minor_event_no_truncate BEFORE TRUNCATE ON departure_minor_event
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_capability_grant_no_truncate BEFORE TRUNCATE ON admin_capability_grant
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

-- At commit a purchase is whole (0017), and a PRICED_SLOTS purchase also: each revision's lines
-- match its seats, total and digest; revision 1 lists every slot; it belongs to a group. A UNIFORM
-- purchase has no slots.
CREATE OR REPLACE FUNCTION fn_purchase_complete() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
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
    ELSIF (SELECT count(*) FROM purchase_revision_line l WHERE l.purchase_id = r.purchase_id AND l.revision = r.revision) <> r.seats
       OR (SELECT sum(price_kopecks) FROM purchase_revision_line l WHERE l.purchase_id = r.purchase_id AND l.revision = r.revision)
          IS DISTINCT FROM r.total_kopecks
       OR fn_purchase_lines_sha256(r.purchase_id, r.revision) IS DISTINCT FROM r.lines_sha256
       OR (r.revision = 1 AND (SELECT count(*) FROM seat_slot WHERE purchase_id = v_purchase) <> r.seats)
       OR NOT EXISTS (SELECT 1 FROM purchase_group_member WHERE purchase_id = v_purchase) THEN
      RAISE EXCEPTION 'PURCHASE_INCOMPLETE' USING ERRCODE = '55000';
    END IF;
  END LOOP;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 6. Current seat projection and occupancy.

-- One row per seat of a PRICED_SLOTS purchase, at its purchase's current revision (its departure,
-- ticket type and price). A later TOUR-79 transfer moves seats by appending a revision.
-- A held seat's protection is its purchase's open hold: fenced (an attempt is in flight or UNKNOWN)
-- or not yet expired.
CREATE VIEW seat_slot_current AS
  SELECT s.id AS seat_slot_id, s.seat_slot_ref, s.purchase_id, p.purchase_ref, s.position, s.state,
         coalesce(h.fenced_at IS NOT NULL, false) AS payment_fenced, h.expires_at AS hold_expires_at, h.hold_ref,
         l.ticket_type, l.price_kopecks, l.pricing_basis_id, r.revision, r.departure_id, m.group_id
    FROM seat_slot s
    JOIN purchase p ON p.id = s.purchase_id
    JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN purchase_revision_line l ON l.purchase_id = r.purchase_id AND l.revision = r.revision AND l.seat_slot_id = s.id
    LEFT JOIN seat_hold h ON h.purchase_id = s.purchase_id AND h.closed_at IS NULL
    LEFT JOIN purchase_group_member m ON m.purchase_id = p.id;

CREATE FUNCTION fn_seat_slot_occupies(p_state text, p_fenced boolean, p_hold_expires_at timestamptz, p_now timestamptz)
RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT p_state = 'CONFIRMED' OR (p_state = 'HELD' AND (coalesce(p_fenced, false) OR coalesce(p_hold_expires_at > p_now, false)))
$fn$ LANGUAGE sql;

-- Shared capacity contract, same signature and callers as 0017: UNIFORM orders as before, plus
-- occupying PRICED_SLOTS seats; a PRICED_SLOTS document order itself counts nothing.
CREATE OR REPLACE FUNCTION fn_departure_taken_seats(p_slug text, p_now timestamptz) RETURNS bigint
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT (SELECT coalesce(sum(coalesce(r.seats, o.seats)), 0) FROM orders o
            LEFT JOIN purchase_revision r ON r.document_order_id = o.id
           WHERE o.seat_model = 'UNIFORM' AND o.departure_slug = p_slug
             AND o.status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD')
             AND NOT (o.status = 'RESERVED' AND o.reserved_until <= p_now AND o.snapshot IS NULL AND o.checkout_attempt_id IS NULL
                      AND o.payment_pending_since IS NULL AND o.resolution_operation_id IS NULL))
       + (SELECT count(*) FROM seat_slot_current c JOIN departure d ON d.id = c.departure_id
           WHERE d.slug = p_slug AND fn_seat_slot_occupies(c.state, c.payment_fenced, c.hold_expires_at, p_now))
$fn$ LANGUAGE sql;

-- The counters of contract §4 (TOUR-64/65/78/102), no personal data. paid_seat_claims counts seat
-- claims, not transactions; over_quota is the red 31/30 indicator, never permission to sell.
CREATE VIEW departure_seat_projection AS
  SELECT d.id AS departure_id, d.slug, d.capacity AS online_quota,
         -- = fn_departure_taken_seats(slug, now()) (tested), without granting that function to the Admin API.
         (SELECT coalesce(sum(coalesce(r.seats, o.seats)), 0) FROM orders o LEFT JOIN purchase_revision r ON r.document_order_id = o.id
           WHERE o.seat_model = 'UNIFORM' AND o.departure_slug = d.slug
             AND o.status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD')
             AND NOT (o.status = 'RESERVED' AND o.reserved_until <= now() AND o.snapshot IS NULL AND o.checkout_attempt_id IS NULL
                      AND o.payment_pending_since IS NULL AND o.resolution_operation_id IS NULL))
         + count(*) FILTER (WHERE fn_seat_slot_occupies(c.state, c.payment_fenced, c.hold_expires_at, now())) AS taken_seats,
         count(*) FILTER (WHERE c.state = 'CONFIRMED') AS confirmed_seats,
         count(*) FILTER (WHERE c.state = 'HELD' AND fn_seat_slot_occupies(c.state, c.payment_fenced, c.hold_expires_at, now())) AS protected_holds,
         count(*) FILTER (WHERE c.state = 'PAID_NO_SEAT_EXCEPTION') AS paid_no_seat,
         count(*) FILTER (WHERE c.state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION')) AS paid_seat_claims,
         coalesce(count(*) FILTER (WHERE c.state IN ('CONFIRMED', 'PAID_NO_SEAT_EXCEPTION')) > d.capacity, false) AS over_quota,
         count(*) FILTER (WHERE c.ticket_type IN ('AGE_0_13', 'AGE_14_17')
                          AND fn_seat_slot_occupies(c.state, c.payment_fenced, c.hold_expires_at, now())) AS online_minors_slots,
         d.minors_allowed, d.minor_min_age, d.minor_sales_paused, d.child_price_kopecks
    FROM departure d LEFT JOIN seat_slot_current c ON c.departure_id = d.id
   GROUP BY d.id;

CREATE VIEW purchase_group_projection AS
  SELECT g.purchase_group_ref, g.departure_id, d.slug AS departure_slug,
         count(DISTINCT c.purchase_id) AS purchases,
         count(*) FILTER (WHERE c.state = 'CONFIRMED' AND c.ticket_type = 'AGE_18_PLUS') AS confirmed_adults,
         count(*) FILTER (WHERE c.state = 'CONFIRMED' AND c.ticket_type = 'AGE_14_17') AS confirmed_teens,
         count(*) FILTER (WHERE c.state = 'CONFIRMED' AND c.ticket_type = 'AGE_0_13') AS confirmed_children,
         count(*) FILTER (WHERE c.state = 'HELD') AS held,
         count(*) FILTER (WHERE c.state = 'PAID_NO_SEAT_EXCEPTION') AS paid_no_seat,
         bool_or(c.state = 'CONFIRMED' AND c.ticket_type = 'AGE_18_PLUS' AND c.departure_id = g.departure_id)
           IS TRUE AS has_active_adult
    FROM purchase_group g JOIN departure d ON d.id = g.departure_id
    LEFT JOIN seat_slot_current c ON c.group_id = g.id
   GROUP BY g.id, d.slug;

-- ---------------------------------------------------------------------------------------------
-- 7. Opening a PRICED_SLOTS purchase: the only native checkout writer from now on.

CREATE FUNCTION fn_new_ref(p_prefix text) RETURNS text VOLATILE SET search_path = pg_catalog, public AS $fn$
  SELECT p_prefix || '-' || left(md5(gen_random_uuid()::text), 20)
$fn$ LANGUAGE sql;

-- T−24 (booking-window.ts BOOKING_CUTOFF_HOURS): 24 elapsed hours before the local departure.
CREATE FUNCTION fn_departure_cutoff(p_departure uuid) RETURNS timestamptz
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT ((d.starts_on + d.departure_time::time) AT TIME ZONE d.timezone) - interval '24 hours' FROM departure d WHERE d.id = p_departure
$fn$ LANGUAGE sql;

-- Whether a new hold of seats may be admitted on this departure now, by the database clock. The
-- caller has taken the sales switch (fn_sales_open_for_sale) and then the departure lock, as checkout.
-- The same rules hold for a first purchase and for a new payment cycle, whoever calls the SQL.
CREATE FUNCTION fn_departure_admission_refusal(p_departure uuid) RETURNS text
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE;
BEGIN
  SELECT * INTO d FROM departure WHERE id = p_departure;
  IF NOT FOUND THEN RETURN 'DEPARTURE_UNKNOWN'; END IF;
  IF d.booking_status <> 'OPEN' OR d.cancellation_requested_at IS NOT NULL THEN RETURN 'DEPARTURE_NOT_OPEN'; END IF;
  IF d.published_at IS NULL OR NOT d.is_listed THEN RETURN 'DEPARTURE_NOT_LISTED'; END IF;
  IF d.starts_on IS NULL OR fn_departure_cutoff(d.id) <= clock_timestamp() THEN RETURN 'BOOKING_CUTOFF_REACHED'; END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

-- A new hold's end: five minutes by the database clock, never past T−24.
CREATE FUNCTION fn_new_hold_expiry(p_departure uuid) RETURNS timestamptz
STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT least(clock_timestamp() + interval '5 minutes', fn_departure_cutoff(p_departure))
$fn$ LANGUAGE sql;

-- In the checkout transaction, after fn_sales_open_for_sale and fn_lock_checkout_departure, for the
-- PRICED_SLOTS document order created by this transaction. Ticket counts are by type; the database
-- applies the minors rules, prices every seat from one frozen pricing basis and checks the amount.
CREATE FUNCTION fn_open_slotted_purchase(p_order_id uuid, p_adults int, p_teens int, p_children int,
  p_link_token_sha256 text, p_link_key_sha256 text, p_request_sha256 text)
RETURNS TABLE (purchase_ref text, purchase_group_ref text, revision int, hold_expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE o orders%ROWTYPE; d departure%ROWTYPE; p purchase%ROWTYPE; k purchase_group_link%ROWTYPE; v_expires timestamptz;
  v_group uuid; v_group_ref text; v_basis uuid; v_child bigint; v_minors int; v_slot uuid; v_type text;
  v_pos int := 0; refusal text;
BEGIN
  IF p_order_id IS NULL THEN RAISE EXCEPTION 'PURCHASE_ORDER_UNKNOWN' USING ERRCODE = '22023'; END IF;
  refusal := fn_purchase_document_order_fresh(p_order_id);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  SELECT * INTO o FROM orders WHERE id = p_order_id FOR UPDATE;
  IF o.seat_model <> 'PRICED_SLOTS' OR o.replaces_order_id IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_ORDER_NOT_PRICED_SLOTS' USING ERRCODE = '55000';
  END IF;
  IF p_adults IS NULL OR p_teens IS NULL OR p_children IS NULL OR p_adults < 0 OR p_teens < 0 OR p_children < 0
     OR p_adults + p_teens + p_children <> o.seats THEN
    RAISE EXCEPTION 'SEATS_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The admission rules are the database's, not only the caller's: a direct SQL call cannot open a
  -- purchase with sales closed, after T−24, on a closed departure or beyond the online quota.
  IF NOT fn_sales_open_for_sale() THEN RAISE EXCEPTION 'SALES_CLOSED' USING ERRCODE = '55000'; END IF;
  PERFORM fn_lock_checkout_departure(o.departure_slug);
  refusal := fn_departure_admission_refusal(o.departure_id);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  IF NOT fn_departure_has_room(o.departure_slug, o.seats) THEN RAISE EXCEPTION 'NOT_ENOUGH_SEATS' USING ERRCODE = '55000'; END IF;
  SELECT * INTO d FROM departure WHERE id = o.departure_id FOR SHARE;
  v_minors := p_teens + p_children;
  IF v_minors > 0 THEN
    IF NOT d.minors_allowed THEN RAISE EXCEPTION 'MINORS_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
    IF d.minor_sales_paused THEN RAISE EXCEPTION 'MINOR_SALES_PAUSED' USING ERRCODE = '55000'; END IF;
    IF p_children > 0 AND coalesce(d.minor_min_age, 0) >= 14 THEN
      RAISE EXCEPTION 'TICKET_TYPE_NOT_ALLOWED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF d.price_kopecks IS DISTINCT FROM o.unit_price_kopecks THEN
    RAISE EXCEPTION 'PURCHASE_PRICE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  v_child := coalesce(d.child_price_kopecks, o.unit_price_kopecks);
  IF (p_adults + p_teens) * o.unit_price_kopecks + p_children * v_child <> o.amount_kopecks THEN
    RAISE EXCEPTION 'PURCHASE_PRICE_MISMATCH' USING ERRCODE = '55000';
  END IF;

  IF p_link_token_sha256 IS NOT NULL THEN
    IF p_link_key_sha256 IS NULL OR p_link_key_sha256 !~ '^[0-9a-f]{64}$'
       OR p_request_sha256 IS NULL OR p_request_sha256 !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'GROUP_LINK_INVALID' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO k FROM purchase_group_link WHERE token_sha256 = p_link_token_sha256 FOR UPDATE;
    IF NOT FOUND OR k.revoked_at IS NOT NULL OR k.consumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'GROUP_LINK_INVALID' USING ERRCODE = '55000';
    END IF;
    -- Exactly the tickets the manager chose; quota, price, pause and T−24 are still checked anew.
    IF ROW(k.adults, k.teens, k.children) IS DISTINCT FROM ROW(p_adults, p_teens, p_children) THEN
      RAISE EXCEPTION 'GROUP_LINK_TICKETS_MISMATCH' USING ERRCODE = '55000';
    END IF;
    v_group := k.group_id;
    IF (SELECT departure_id FROM purchase_group WHERE id = v_group) IS DISTINCT FROM o.departure_id THEN
      RAISE EXCEPTION 'GROUP_LINK_DEPARTURE_MISMATCH' USING ERRCODE = '55000';
    END IF;
    -- A purchase of minors only needs a confirmed adult seat of the group on this departure (v1.9 §3 п.1).
    IF p_adults = 0 AND NOT EXISTS (SELECT 1 FROM seat_slot_current c WHERE c.group_id = v_group
         AND c.departure_id = o.departure_id AND c.ticket_type = 'AGE_18_PLUS' AND c.state = 'CONFIRMED') THEN
      RAISE EXCEPTION 'MINORS_WITHOUT_ADULT' USING ERRCODE = '55000';
    END IF;
  ELSIF p_adults = 0 THEN
    RAISE EXCEPTION 'MINORS_WITHOUT_ADULT' USING ERRCODE = '55000';
  END IF;

  INSERT INTO purchase (purchase_ref, lifecycle_profile, payment_owner, origin_order_id)
    VALUES (fn_new_ref('mp'), 'NATIVE_NO_REFERRAL', 'MIKLUHA_NATIVE', o.id) RETURNING * INTO p;
  IF v_group IS NULL THEN
    INSERT INTO purchase_group (purchase_group_ref, departure_id) VALUES (fn_new_ref('mg'), o.departure_id) RETURNING id INTO v_group;
    INSERT INTO purchase_group_member (purchase_id, group_id, joined_via) VALUES (p.id, v_group, 'ORIGIN');
  ELSE
    UPDATE purchase_group_link SET consumed_at = clock_timestamp(), consumed_purchase_id = p.id,
      consumed_key_sha256 = p_link_key_sha256, consumed_request_sha256 = p_request_sha256 WHERE id = k.id;
    INSERT INTO purchase_group_member (purchase_id, group_id, joined_via, link_id) VALUES (p.id, v_group, 'STAFF_LINK', k.id);
  END IF;
  SELECT g.purchase_group_ref INTO v_group_ref FROM purchase_group g WHERE g.id = v_group;

  INSERT INTO pricing_basis (pricing_basis_ref, source, document_order_id, departure_id, departure_version,
      adult_price_kopecks, child_price_kopecks, price_departure_on, timezone, minor_settings_version)
    VALUES (fn_new_ref('pb'), 'PUBLISHED_GRID', o.id, o.departure_id, o.accepted_departure_version,
      o.unit_price_kopecks, d.child_price_kopecks, o.trip_starts_on, o.trip_timezone, d.minor_settings_version) RETURNING id INTO v_basis;
  v_expires := fn_new_hold_expiry(o.departure_id);
  INSERT INTO seat_hold (hold_ref, purchase_id, cycle, expires_at) VALUES (fn_new_ref('sh'), p.id, 1, v_expires);
  FOR v_type IN SELECT x.t FROM (VALUES (1, 'AGE_18_PLUS', p_adults), (2, 'AGE_14_17', p_teens), (3, 'AGE_0_13', p_children))
                  x(k, t, n), generate_series(1, x.n) g ORDER BY x.k, g LOOP
    v_pos := v_pos + 1;
    INSERT INTO seat_slot (seat_slot_ref, purchase_id, position, pricing_basis_id, state)
      VALUES (fn_new_ref('ss'), p.id, v_pos, v_basis, 'HELD') RETURNING id INTO v_slot;
    INSERT INTO purchase_revision_line (purchase_id, revision, seat_slot_id, ticket_type, pricing_basis_id, price_kopecks)
      VALUES (p.id, 1, v_slot, v_type, v_basis, fn_pricing_basis_price(v_basis, v_type));
    INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason)
      VALUES (v_slot, NULL, 'HELD', 'checkout', 'PURCHASE_OPENED');
  END LOOP;
  INSERT INTO purchase_revision (purchase_id, revision, basis, document_order_id, departure_id, departure_version, seats,
      unit_price_kopecks, total_kopecks, participant_refs, contract_snapshot_sha256, legal_release_ref, legal_release_hash,
      pd_consent_ref, pd_consent_hash, accepted_at, effective_at, recorded_at, revision_hash, slot_model, lines_sha256)
    VALUES (p.id, 1, 'INITIAL', o.id, o.departure_id, o.accepted_departure_version, o.seats, o.unit_price_kopecks,
      o.amount_kopecks, '{}', o.contract_snapshot_sha256, o.legal_release_ref, o.legal_release_hash,
      o.pd_consent_ref, o.pd_consent_hash, o.pd_consent_accepted_at, o.pd_consent_accepted_at, clock_timestamp(),
      'sha256:' || repeat('0', 64), 'PRICED_SLOTS', fn_purchase_lines_sha256(p.id, 1));
  INSERT INTO order_event (order_id, event, detail) VALUES (o.id, 'PURCHASE_REVISION', 'revision:1');
  RETURN QUERY SELECT p.purchase_ref, v_group_ref, 1, v_expires;
END $fn$ LANGUAGE plpgsql;

-- Replay of a checkout started through a group link: the same idempotency key returns the purchase
-- it created, and whether the repeated request is the accepted one (otherwise the caller refuses
-- IDEMPOTENCY_CONFLICT); another key gets nothing (the caller then refuses GROUP_LINK_INVALID).
CREATE FUNCTION fn_group_link_replay(p_token_sha256 text, p_key_sha256 text, p_request_sha256 text)
RETURNS TABLE (purchase_ref text, document_order_ref text, same_request boolean)
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT p.purchase_ref, o.order_ref, k.consumed_request_sha256 = p_request_sha256 FROM purchase_group_link k
    JOIN purchase p ON p.id = k.consumed_purchase_id JOIN orders o ON o.id = p.origin_order_id
   WHERE k.token_sha256 = p_token_sha256 AND k.consumed_key_sha256 = p_key_sha256
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_group_link_issue(p_admin_id uuid, p_group_ref text, p_token_sha256 text,
  p_adults int, p_teens int, p_children int) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'group_link.issue'); v_group uuid; v_ref text := fn_new_ref('gl');
BEGIN
  SELECT id INTO v_group FROM purchase_group WHERE purchase_group_ref = p_group_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_GROUP_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'GROUP_LINK_INVALID' USING ERRCODE = '22023'; END IF;
  IF p_adults IS NULL OR p_teens IS NULL OR p_children IS NULL OR p_adults < 0 OR p_teens < 0 OR p_children < 0
     OR p_adults + p_teens + p_children NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'SEATS_INVALID' USING ERRCODE = '22023';
  END IF;
  INSERT INTO purchase_group_link (group_link_ref, group_id, token_sha256, issued_by_admin, issued_by, adults, teens, children)
    VALUES (v_ref, v_group, p_token_sha256, p_admin_id, v_by, p_adults, p_teens, p_children);
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_group_link_revoke(p_admin_id uuid, p_link_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'group_link.revoke'); v_reason text := fn_staff_reason(p_reason);
  k purchase_group_link%ROWTYPE;
BEGIN
  SELECT * INTO k FROM purchase_group_link WHERE group_link_ref = p_link_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'GROUP_LINK_INVALID' USING ERRCODE = '55000'; END IF;
  IF k.revoked_at IS NOT NULL OR k.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'GROUP_LINK_ALREADY_FINAL' USING ERRCODE = '55000'; END IF;
  UPDATE purchase_group_link SET revoked_at = clock_timestamp(), revoked_by = v_by, revoke_reason = v_reason WHERE id = k.id;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 8. Payment cycles and seat transitions (TOUR-77/78/27 call them; bank proof itself is TOUR-77's).
--    No function here cancels a confirmed seat: that is a TOUR-79 amendment revision (A2b-3).

CREATE FUNCTION fn_text_arg(p_value text, p_code text) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_value IS NULL OR length(btrim(p_value)) NOT BETWEEN 1 AND 500 OR p_value ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION '%', p_code USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_value);
END $fn$ LANGUAGE plpgsql;

-- Lock order everywhere: the departure (as checkout: row share + advisory), then the purchase's
-- holds and seats. Returns the slug of the purchase's current departure.
CREATE FUNCTION fn_purchase_lock_departure(p_purchase uuid) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_slug text;
BEGIN
  SELECT d.slug INTO v_slug FROM purchase p JOIN purchase_revision r ON r.purchase_id = p.id AND r.revision = p.current_revision
    JOIN departure d ON d.id = r.departure_id WHERE p.id = p_purchase;
  IF v_slug IS NULL THEN RAISE EXCEPTION 'PURCHASE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM fn_lock_checkout_departure(v_slug);
  RETURN v_slug;
END $fn$ LANGUAGE plpgsql;

-- Under the departure lock: is there room for n more seats within the online quota?
CREATE FUNCTION fn_departure_has_room(p_slug text, p_seats int) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT d.capacity IS NOT NULL AND fn_departure_taken_seats(p_slug, clock_timestamp()) + p_seats <= d.capacity
    FROM departure d WHERE d.slug = p_slug
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_purchase_id(p_purchase_ref text) RETURNS uuid STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM purchase WHERE purchase_ref = p_purchase_ref;
  IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM seat_hold WHERE purchase_id = v) THEN
    RAISE EXCEPTION 'PURCHASE_UNKNOWN' USING ERRCODE = '55000';
  END IF;
  RETURN v;
END $fn$ LANGUAGE plpgsql;

-- The payment functions below are the database half of TOUR-77: they bind every money outcome to the
-- one attempt recorded on the hold (attempt_ref), so no outcome can be applied to a hold whose attempt
-- was never recorded, nor with another attempt's identity. Whether the bank really answered so
-- (provider, amount, currency, read-back) is TOUR-77's bank_operation (contract A2b-1); until it is
-- integrated these transitions are source-only and not qualified for real money.

-- The attempt is recorded before the bank registration (2A): the hold is then kept until the
-- attempt's outcome, past its five minutes. Repeating the same attempt is idempotent.
CREATE FUNCTION fn_purchase_hold_fence(p_purchase_ref text, p_attempt_ref text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid := fn_purchase_id(p_purchase_ref); h seat_hold%ROWTYPE;
  v_attempt text := fn_text_arg(p_attempt_ref, 'BANK_OPERATION_REQUIRED');
BEGIN
  PERFORM fn_purchase_lock_departure(v_purchase);
  SELECT * INTO h FROM seat_hold WHERE purchase_id = v_purchase AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOLD_NOT_OPEN' USING ERRCODE = '55000'; END IF;
  IF h.fenced_at IS NOT NULL THEN
    IF h.attempt_ref = v_attempt THEN RETURN h.hold_ref; END IF;
    RAISE EXCEPTION 'HOLD_ALREADY_FENCED' USING ERRCODE = '55000';
  END IF;
  UPDATE seat_hold SET fenced_at = clock_timestamp(), attempt_ref = v_attempt WHERE id = h.id;
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason, bank_operation_ref)
    SELECT id, 'HELD', 'HELD', h.id, 'payment', 'PAYMENT_ATTEMPT_RECORDED', v_attempt FROM seat_slot
     WHERE purchase_id = v_purchase AND state = 'HELD' ORDER BY position;
  RETURN h.hold_ref;
END $fn$ LANGUAGE plpgsql;

-- The bank proved that this attempt did not pay: the hold closes, its seats are released, and the
-- purchase may start a new cycle (fn_purchase_rehold). Only the fenced attempt's own outcome counts.
CREATE FUNCTION fn_purchase_payment_failed(p_purchase_ref text, p_attempt_ref text) RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid := fn_purchase_id(p_purchase_ref); h seat_hold%ROWTYPE; v_n int;
BEGIN
  PERFORM fn_purchase_lock_departure(v_purchase);
  SELECT * INTO h FROM seat_hold WHERE purchase_id = v_purchase AND closed_at IS NULL FOR UPDATE;
  IF NOT FOUND OR h.fenced_at IS NULL OR h.attempt_ref IS DISTINCT FROM p_attempt_ref THEN
    RAISE EXCEPTION 'ATTEMPT_UNKNOWN' USING ERRCODE = '55000';
  END IF;
  UPDATE seat_hold SET closed_at = clock_timestamp(), outcome = 'PAYMENT_FAILED' WHERE id = h.id;
  WITH r AS (UPDATE seat_slot SET state = 'RELEASED' WHERE purchase_id = v_purchase AND state = 'HELD' RETURNING id)
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason, bank_operation_ref)
    SELECT id, 'HELD', 'RELEASED', h.id, 'payment', 'PAYMENT_FAILED', h.attempt_ref FROM r;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $fn$ LANGUAGE plpgsql;

-- The bank confirmed that a recorded attempt paid (enough for every seat of the cycle: v1.8.2 §2.2
-- п.2). The database, not the caller, decides each seat's state:
--   * the attempt's hold is open (fenced): it closes PAID and its seats are CONFIRMED; they were
--     protected all along, so no capacity is taken twice;
--   * the attempt's hold already closed PAYMENT_FAILED (a late success, 3A): each released seat is
--     CONFIRMED if the quota has room under the departure lock, otherwise PAID_NO_SEAT_EXCEPTION. A
--     later cycle (open or paid) makes it a double collection for manual reconciliation (TOUR-77/27):
--     refused with NEWER_CYCLE_EXISTS. After the purchase closed (its document order EXPIRED, the
--     buyer's contact erased) it is refused with PURCHASE_CLOSED_LATE_PAYMENT: manual settlement.
-- Repeating the same confirmation changes nothing. An unfenced or lapsed hold never had an attempt,
-- so it can never be confirmed (no seat beyond the quota).
CREATE FUNCTION fn_purchase_payment_confirmed(p_purchase_ref text, p_attempt_ref text)
RETURNS TABLE (confirmed int, no_seat int)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_purchase uuid := fn_purchase_id(p_purchase_ref); h seat_hold%ROWTYPE; v_slug text; s record;
  v_confirmed int := 0; v_no_seat int := 0; o orders%ROWTYPE;
BEGIN
  v_slug := fn_purchase_lock_departure(v_purchase);
  -- The same row lock as fn_priced_document_orders_close and fn_purchase_rehold (departure, then
  -- order, then hold): a closure either happened before and is seen here, or waits for this one.
  SELECT o2.* INTO o FROM purchase p JOIN orders o2 ON o2.id = p.origin_order_id WHERE p.id = v_purchase FOR UPDATE OF o2;
  SELECT * INTO h FROM seat_hold WHERE purchase_id = v_purchase AND attempt_ref = p_attempt_ref FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTEMPT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF h.closed_at IS NULL THEN
    UPDATE seat_hold SET closed_at = clock_timestamp(), outcome = 'PAID' WHERE id = h.id;
    FOR s IN SELECT id FROM seat_slot WHERE purchase_id = v_purchase AND state = 'HELD' ORDER BY position FOR UPDATE LOOP
      UPDATE seat_slot SET state = 'CONFIRMED' WHERE id = s.id;
      INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason, bank_operation_ref)
        VALUES (s.id, 'HELD', 'CONFIRMED', h.id, 'payment', 'PAYMENT_CONFIRMED', h.attempt_ref);
      v_confirmed := v_confirmed + 1;
    END LOOP;
  ELSIF h.outcome = 'PAYMENT_FAILED' THEN
    -- Already applied: a repeat changes nothing.
    IF EXISTS (SELECT 1 FROM seat_slot_event WHERE seat_hold_id = h.id
               AND reason IN ('LATE_PAYMENT_CONFIRMED', 'LATE_PAYMENT_NO_SEAT')) THEN
      RETURN QUERY SELECT 0, 0;
      RETURN;
    END IF;
    -- The purchase was closed (EXPIRED, buyer contact erased by decision 8B): a late success changes
    -- no seat and reopens nothing. The money fact is the bank operation's (TOUR-77); settlement or
    -- refund is manual (TOUR-27).
    IF o.status <> 'RESERVED' OR o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'PURCHASE_CLOSED_LATE_PAYMENT' USING ERRCODE = '55000';
    END IF;
    -- A later cycle exists (open or paid): this money is a second collection for the same seats,
    -- for manual reconciliation and refund (TOUR-77/27), never a silent no-op or a second seat.
    IF EXISTS (SELECT 1 FROM seat_hold WHERE purchase_id = v_purchase AND cycle > h.cycle) THEN
      RAISE EXCEPTION 'NEWER_CYCLE_EXISTS' USING ERRCODE = '55000';
    END IF;
    FOR s IN SELECT id FROM seat_slot WHERE purchase_id = v_purchase AND state = 'RELEASED' ORDER BY position FOR UPDATE LOOP
      IF fn_departure_has_room(v_slug, 1) THEN
        UPDATE seat_slot SET state = 'CONFIRMED' WHERE id = s.id;
        INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason, bank_operation_ref)
          VALUES (s.id, 'RELEASED', 'CONFIRMED', h.id, 'payment', 'LATE_PAYMENT_CONFIRMED', h.attempt_ref);
        v_confirmed := v_confirmed + 1;
      ELSE
        UPDATE seat_slot SET state = 'PAID_NO_SEAT_EXCEPTION' WHERE id = s.id;
        INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason, bank_operation_ref)
          VALUES (s.id, 'RELEASED', 'PAID_NO_SEAT_EXCEPTION', h.id, 'payment', 'LATE_PAYMENT_NO_SEAT', h.attempt_ref);
        v_no_seat := v_no_seat + 1;
      END IF;
    END LOOP;
  END IF;
  RETURN QUERY SELECT v_confirmed, v_no_seat;
END $fn$ LANGUAGE plpgsql;

-- maintain(): an unfenced hold past its time closes LAPSED and its seats are released, by the
-- database clock only: no caller-supplied time can end a live hold early. A fenced hold (attempt in
-- flight or UNKNOWN) never lapses.
CREATE FUNCTION fn_seat_holds_close_lapsed() RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE h seat_hold%ROWTYPE; v_n int := 0; v_m int;
BEGIN
  FOR h IN SELECT * FROM seat_hold WHERE closed_at IS NULL AND fenced_at IS NULL AND expires_at <= clock_timestamp()
           ORDER BY purchase_id FOR UPDATE SKIP LOCKED LOOP
    UPDATE seat_hold SET closed_at = clock_timestamp(), outcome = 'LAPSED' WHERE id = h.id AND fenced_at IS NULL;
    CONTINUE WHEN NOT FOUND;
    WITH r AS (UPDATE seat_slot SET state = 'RELEASED' WHERE purchase_id = h.purchase_id AND state = 'HELD' RETURNING id)
    INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason)
      SELECT id, 'HELD', 'RELEASED', h.id, 'maintenance', 'HOLD_LAPSED' FROM r;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    v_n := v_n + v_m;
  END LOOP;
  RETURN v_n;
END $fn$ LANGUAGE plpgsql;

-- A new payment cycle of the same purchase after a proven failure or a lapse (v1.9.0 §2 п.1): a new
-- hold of the same seats at their frozen prices, under the general rules again, all checked here by
-- the database clock whoever calls the SQL: sales switch, departure open and listed, T−24, quota,
-- minors' pause and permission, a confirmed adult for a children-only linked purchase. Retries end
-- at the earlier of 24 hours after the purchase was created and T−24 (OWNER decision 1A, 06.11.2026), however
-- many attempts fail. The document order's row serializes this with its closure by maintain().
-- The caller verifies the buyer's ownership of the purchase (purchases.ts).
CREATE FUNCTION fn_purchase_rehold(p_purchase_ref text)
RETURNS TABLE (hold_ref text, expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
#variable_conflict use_column
DECLARE v_purchase uuid := fn_purchase_id(p_purchase_ref); v_slug text; last seat_hold%ROWTYPE; o orders%ROWTYPE;
  p purchase%ROWTYPE; d departure%ROWTYPE; v_seats int; v_adults int; v_children int; v_minors int; v_group uuid;
  v_hold uuid; v_ref text := fn_new_ref('sh'); v_expires timestamptz; refusal text;
BEGIN
  IF NOT fn_sales_open_for_sale() THEN RAISE EXCEPTION 'SALES_CLOSED' USING ERRCODE = '55000'; END IF;
  v_slug := fn_purchase_lock_departure(v_purchase);
  SELECT * INTO p FROM purchase WHERE id = v_purchase;
  -- The same row lock as fn_priced_document_orders_close: whichever comes second sees the first.
  SELECT * INTO o FROM orders WHERE id = p.origin_order_id FOR UPDATE;
  IF o.status <> 'RESERVED' OR o.closed_at IS NOT NULL OR o.pd_erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'PURCHASE_CLOSED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO last FROM seat_hold WHERE purchase_id = v_purchase ORDER BY cycle DESC LIMIT 1 FOR UPDATE;
  IF last.outcome IS NULL OR last.outcome NOT IN ('PAYMENT_FAILED', 'LAPSED')
     OR EXISTS (SELECT 1 FROM seat_slot WHERE purchase_id = v_purchase AND state <> 'RELEASED') THEN
    RAISE EXCEPTION 'REHOLD_NOT_ALLOWED' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO d FROM departure WHERE slug = v_slug;
  refusal := fn_departure_admission_refusal(d.id);
  IF refusal IS NOT NULL THEN RAISE EXCEPTION '%', refusal USING ERRCODE = '55000'; END IF;
  IF clock_timestamp() >= p.created_at + interval '24 hours' THEN
    RAISE EXCEPTION 'RETRY_WINDOW_CLOSED' USING ERRCODE = '55000';
  END IF;
  -- OWNER decision 2 (06.11.2026, Stage A): no new payment attempt on terms the organizer has since
  -- changed. Any new published revision of the departure refuses the retry until TOUR-89 classifies
  -- changes and a re-acceptance flow exists (A2b-10). An attempt already registered is not affected:
  -- its outcome is applied by fn_purchase_payment_confirmed on the terms it was registered under.
  IF d.published_version IS DISTINCT FROM (SELECT r.departure_version FROM purchase_revision r
       WHERE r.purchase_id = v_purchase AND r.revision = p.current_revision) THEN
    RAISE EXCEPTION 'DEPARTURE_CHANGED' USING ERRCODE = '55000';
  END IF;
  SELECT count(*), count(*) FILTER (WHERE ticket_type = 'AGE_18_PLUS'), count(*) FILTER (WHERE ticket_type = 'AGE_0_13'),
         min(group_id::text)::uuid
    INTO v_seats, v_adults, v_children, v_group FROM seat_slot_current WHERE purchase_id = v_purchase;
  v_minors := v_seats - v_adults;
  IF v_minors > 0 THEN
    IF NOT d.minors_allowed THEN RAISE EXCEPTION 'MINORS_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
    IF d.minor_sales_paused THEN RAISE EXCEPTION 'MINOR_SALES_PAUSED' USING ERRCODE = '55000'; END IF;
    IF v_children > 0 AND coalesce(d.minor_min_age, 0) >= 14 THEN RAISE EXCEPTION 'TICKET_TYPE_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
    IF v_adults = 0 AND NOT EXISTS (SELECT 1 FROM seat_slot_current c WHERE c.group_id = v_group AND c.purchase_id <> v_purchase
         AND c.departure_id = d.id AND c.ticket_type = 'AGE_18_PLUS' AND c.state = 'CONFIRMED') THEN
      RAISE EXCEPTION 'MINORS_WITHOUT_ADULT' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NOT fn_departure_has_room(v_slug, v_seats) THEN RAISE EXCEPTION 'NOT_ENOUGH_SEATS' USING ERRCODE = '55000'; END IF;
  v_expires := fn_new_hold_expiry(d.id);
  INSERT INTO seat_hold (hold_ref, purchase_id, cycle, expires_at) VALUES (v_ref, v_purchase, last.cycle + 1, v_expires)
    RETURNING id INTO v_hold;
  WITH r AS (UPDATE seat_slot SET state = 'HELD' WHERE purchase_id = v_purchase AND state = 'RELEASED' RETURNING id)
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, seat_hold_id, actor, reason)
    SELECT id, 'RELEASED', 'HELD', v_hold, 'checkout', 'NEW_PAYMENT_CYCLE' FROM r;
  RETURN QUERY SELECT v_ref, v_expires;
END $fn$ LANGUAGE plpgsql;

-- TOUR-27 settled a no-seat exception by refund. The refund operation's own evidence is TOUR-27/77's.
CREATE FUNCTION fn_seat_slot_refund_settled(p_slot_ref text, p_refund_ref text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE s seat_slot%ROWTYPE; v_ref text := fn_text_arg(p_refund_ref, 'BANK_OPERATION_REQUIRED');
BEGIN
  IF v_ref !~ '^[A-Za-z0-9_:.-]{1,100}$' THEN RAISE EXCEPTION 'BANK_OPERATION_REQUIRED' USING ERRCODE = '22023'; END IF;
  SELECT * INTO s FROM seat_slot WHERE seat_slot_ref = p_slot_ref FOR UPDATE;
  IF NOT FOUND OR s.state <> 'PAID_NO_SEAT_EXCEPTION' THEN RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID' USING ERRCODE = '55000'; END IF;
  UPDATE seat_slot SET state = 'REFUND_SETTLED' WHERE id = s.id;
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason, bank_operation_ref)
    VALUES (s.id, s.state, 'REFUND_SETTLED', 'refund', 'NO_SEAT_REFUNDED', v_ref);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_seat_slot_assign_no_seat(p_admin_id uuid, p_slot_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'paid_no_seat.resolve'); v_reason text := fn_staff_reason(p_reason);
  s seat_slot%ROWTYPE; v_slug text;
BEGIN
  SELECT * INTO s FROM seat_slot WHERE seat_slot_ref = p_slot_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID' USING ERRCODE = '55000'; END IF;
  v_slug := fn_purchase_lock_departure(s.purchase_id);
  SELECT * INTO s FROM seat_slot WHERE id = s.id FOR UPDATE;
  IF s.state <> 'PAID_NO_SEAT_EXCEPTION' THEN RAISE EXCEPTION 'SEAT_SLOT_TRANSITION_INVALID' USING ERRCODE = '55000'; END IF;
  IF NOT fn_departure_has_room(v_slug, 1) THEN RAISE EXCEPTION 'NO_SEAT_AVAILABLE' USING ERRCODE = '55000'; END IF;
  UPDATE seat_slot SET state = 'CONFIRMED' WHERE id = s.id;
  INSERT INTO seat_slot_event (seat_slot_id, from_state, to_state, actor, reason) VALUES (s.id, s.state, 'CONFIRMED', v_by, v_reason);
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 9. Personalization identities: participants, companions, invitations. No personal data here.

CREATE TABLE seat_participant (
  participant_ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seat_slot_id    uuid NOT NULL REFERENCES seat_slot(id),
  opened_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at        timestamptz,
  end_reason      text CHECK (end_reason IN ('REPLACED', 'WITHDRAWN', 'SLOT_ENDED')),
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX seat_participant_active ON seat_participant (seat_slot_id) WHERE ended_at IS NULL;

CREATE TABLE companion_assignment (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  companion_ref             text NOT NULL UNIQUE CHECK (companion_ref ~ '^ca-[0-9a-f]{20}$'),
  minor_slot_id             uuid NOT NULL REFERENCES seat_slot(id),
  companion_slot_id         uuid NOT NULL REFERENCES seat_slot(id),
  companion_participant_ref uuid REFERENCES seat_participant(participant_ref),
  assigned_by_kind          text NOT NULL CHECK (assigned_by_kind IN ('BUYER', 'STAFF')),
  assigned_by_admin         uuid REFERENCES admin_user(id),
  assigned_by               text NOT NULL CHECK (length(assigned_by) BETWEEN 1 AND 120),
  reason                    text CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  assigned_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at              timestamptz,
  revoked_at                timestamptz,
  revoke_reason             text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CHECK (minor_slot_id <> companion_slot_id),
  CHECK ((assigned_by_kind = 'STAFF') = (assigned_by_admin IS NOT NULL)),
  CHECK (assigned_by_kind = 'BUYER' OR (companion_participant_ref IS NOT NULL AND reason IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX companion_assignment_active ON companion_assignment (minor_slot_id) WHERE revoked_at IS NULL;

CREATE TABLE seat_invitation (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_ref          text NOT NULL UNIQUE CHECK (invitation_ref ~ '^iv-[0-9a-f]{20}$'),
  seat_slot_id            uuid NOT NULL REFERENCES seat_slot(id),
  purpose                 text NOT NULL CHECK (purpose IN ('SELF', 'MINOR_VIA_COMPANION')),
  companion_assignment_id uuid REFERENCES companion_assignment(id),
  token_sha256            text NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at              timestamptz,
  revoked_at              timestamptz,
  revoke_reason           text CHECK (length(btrim(revoke_reason)) BETWEEN 1 AND 500),
  CHECK ((purpose = 'MINOR_VIA_COMPANION') = (companion_assignment_id IS NOT NULL)),
  CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- One active invitation per seat (v1.8.2 §1).
CREATE UNIQUE INDEX seat_invitation_active ON seat_invitation (seat_slot_id) WHERE revoked_at IS NULL;

-- A participant opens only on a confirmed seat; it ends once.
CREATE FUNCTION fn_seat_participant_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'PARTICIPANT_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM seat_slot WHERE id = NEW.seat_slot_id AND state = 'CONFIRMED') OR NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'SEAT_SLOT_NOT_CONFIRMED' USING ERRCODE = '55000';
    END IF;
    NEW.opened_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW.participant_ref, NEW.seat_slot_id, NEW.opened_at) IS DISTINCT FROM ROW(OLD.participant_ref, OLD.seat_slot_id, OLD.opened_at)
     OR OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'PARTICIPANT_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON seat_participant
  FOR EACH ROW EXECUTE FUNCTION fn_seat_participant_guard();

-- A minor seat is accompanied by an adult seat that is confirmed: within the purchase (buyer, before
-- personalization), or a personalized adult of another purchase of the same group on the same current
-- departure, assigned by staff only (v1.9 §3 п.2–3). Nobody assigns themselves.
CREATE FUNCTION fn_companion_assignment_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE m seat_slot_current%ROWTYPE; c seat_slot_current%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'COMPANION_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.companion_ref, NEW.minor_slot_id, NEW.companion_slot_id, NEW.companion_participant_ref, NEW.assigned_by_kind,
           NEW.assigned_by_admin, NEW.assigned_by, NEW.reason, NEW.assigned_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.companion_ref, OLD.minor_slot_id, OLD.companion_slot_id, OLD.companion_participant_ref,
           OLD.assigned_by_kind, OLD.assigned_by_admin, OLD.assigned_by, OLD.reason, OLD.assigned_at)
       OR OLD.revoked_at IS NOT NULL
       OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
      RAISE EXCEPTION 'COMPANION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO m FROM seat_slot_current WHERE seat_slot_id = NEW.minor_slot_id;
  SELECT * INTO c FROM seat_slot_current WHERE seat_slot_id = NEW.companion_slot_id;
  IF m.seat_slot_id IS NULL OR m.state <> 'CONFIRMED' OR m.ticket_type NOT IN ('AGE_0_13', 'AGE_14_17') THEN
    RAISE EXCEPTION 'MINOR_SLOT_INVALID' USING ERRCODE = '55000';
  END IF;
  IF c.seat_slot_id IS NULL OR c.state <> 'CONFIRMED' OR c.ticket_type <> 'AGE_18_PLUS'
     OR (NEW.companion_participant_ref IS NOT NULL AND NOT EXISTS (SELECT 1 FROM seat_participant
           WHERE participant_ref = NEW.companion_participant_ref AND seat_slot_id = c.seat_slot_id AND ended_at IS NULL))
     OR (NEW.assigned_by_kind = 'BUYER' AND c.purchase_id <> m.purchase_id)
     OR (NEW.assigned_by_kind = 'STAFF' AND (c.group_id IS DISTINCT FROM m.group_id OR c.departure_id <> m.departure_id))
     OR NEW.revoked_at IS NOT NULL OR NEW.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'COMPANION_INVALID' USING ERRCODE = '55000';
  END IF;
  NEW.assigned_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_companion_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON companion_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_companion_assignment_guard();

-- Invitations only after the seat is confirmed: an adult's own (18+), or a companion's invitation
-- limited to one minor seat under an active staff assignment.
CREATE FUNCTION fn_seat_invitation_guard() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
DECLARE s seat_slot_current%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'INVITATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW.id, NEW.invitation_ref, NEW.seat_slot_id, NEW.purpose, NEW.companion_assignment_id, NEW.token_sha256, NEW.issued_at)
       IS DISTINCT FROM ROW(OLD.id, OLD.invitation_ref, OLD.seat_slot_id, OLD.purpose, OLD.companion_assignment_id, OLD.token_sha256, OLD.issued_at)
       OR OLD.revoked_at IS NOT NULL
       OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at) THEN
      RAISE EXCEPTION 'INVITATION_HISTORY_IMMUTABLE' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO s FROM seat_slot_current WHERE seat_slot_id = NEW.seat_slot_id;
  IF s.seat_slot_id IS NULL OR s.state <> 'CONFIRMED' THEN RAISE EXCEPTION 'SEAT_SLOT_NOT_CONFIRMED' USING ERRCODE = '55000'; END IF;
  IF (NEW.purpose = 'SELF' AND s.ticket_type <> 'AGE_18_PLUS')
     OR (NEW.purpose = 'MINOR_VIA_COMPANION' AND (NOT EXISTS (SELECT 1 FROM companion_assignment a
           WHERE a.id = NEW.companion_assignment_id AND a.minor_slot_id = NEW.seat_slot_id AND a.assigned_by_kind = 'STAFF')
           OR NOT fn_companion_current(NEW.companion_assignment_id)))
     OR NEW.claimed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITATION_PURPOSE_INVALID' USING ERRCODE = '55000';
  END IF;
  NEW.issued_at := clock_timestamp();
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_invitation_guard BEFORE INSERT OR UPDATE OR DELETE ON seat_invitation
  FOR EACH ROW EXECUTE FUNCTION fn_seat_invitation_guard();

-- Leaving cascades in the same transaction (v1.9 §3 п.5, G-GROUP-03): a seat that stops being
-- CONFIRMED ends its participant, its invitation and every assignment it is part of; an ended
-- companion participant loses its assignments; a revoked assignment loses its invitation.
CREATE FUNCTION fn_seat_slot_left() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  UPDATE companion_assignment SET revoked_at = clock_timestamp(),
      revoke_reason = CASE WHEN companion_slot_id = NEW.id THEN 'COMPANION_SEAT_ENDED' ELSE 'MINOR_SEAT_ENDED' END
    WHERE (companion_slot_id = NEW.id OR minor_slot_id = NEW.id) AND revoked_at IS NULL;
  UPDATE seat_participant SET ended_at = clock_timestamp(), end_reason = 'SLOT_ENDED' WHERE seat_slot_id = NEW.id AND ended_at IS NULL;
  UPDATE seat_invitation SET revoked_at = clock_timestamp(), revoke_reason = 'SEAT_ENDED' WHERE seat_slot_id = NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_slot_left AFTER UPDATE OF state ON seat_slot
  FOR EACH ROW WHEN (OLD.state = 'CONFIRMED' AND NEW.state <> 'CONFIRMED') EXECUTE FUNCTION fn_seat_slot_left();

CREATE FUNCTION fn_seat_participant_left() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = 'COMPANION_PARTICIPANT_ENDED'
    WHERE companion_participant_ref = NEW.participant_ref AND revoked_at IS NULL;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_seat_participant_left AFTER UPDATE OF ended_at ON seat_participant
  FOR EACH ROW WHEN (OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL) EXECUTE FUNCTION fn_seat_participant_left();

CREATE FUNCTION fn_companion_assignment_left() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  UPDATE seat_invitation SET revoked_at = clock_timestamp(), revoke_reason = 'COMPANION_REVOKED'
    WHERE companion_assignment_id = NEW.id AND revoked_at IS NULL;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_companion_assignment_left AFTER UPDATE OF revoked_at ON companion_assignment
  FOR EACH ROW WHEN (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL) EXECUTE FUNCTION fn_companion_assignment_left();

CREATE TRIGGER trg_seat_participant_no_truncate BEFORE TRUNCATE ON seat_participant
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_companion_assignment_no_truncate BEFORE TRUNCATE ON companion_assignment
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();
CREATE TRIGGER trg_seat_invitation_no_truncate BEFORE TRUNCATE ON seat_invitation
  FOR EACH STATEMENT EXECUTE FUNCTION fn_purchase_history_immutable();

CREATE FUNCTION fn_slot_id(p_slot_ref text) RETURNS uuid STABLE SET search_path = pg_catalog, public AS $fn$
DECLARE v uuid;
BEGIN
  SELECT id INTO v FROM seat_slot WHERE seat_slot_ref = p_slot_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'SEAT_SLOT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  RETURN v;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_seat_participant_open(p_slot_ref text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_slot uuid := fn_slot_id(p_slot_ref); v_ref uuid;
BEGIN
  PERFORM 1 FROM seat_slot WHERE id = v_slot FOR UPDATE;
  IF EXISTS (SELECT 1 FROM seat_participant WHERE seat_slot_id = v_slot AND ended_at IS NULL) THEN
    RAISE EXCEPTION 'PARTICIPANT_ALREADY_ACTIVE' USING ERRCODE = '55000';
  END IF;
  INSERT INTO seat_participant (seat_slot_id) VALUES (v_slot) RETURNING participant_ref INTO v_ref;
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_seat_participant_end(p_participant_ref uuid, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('REPLACED', 'WITHDRAWN') THEN RAISE EXCEPTION 'REASON_INVALID' USING ERRCODE = '22023'; END IF;
  UPDATE seat_participant SET ended_at = clock_timestamp(), end_reason = p_reason WHERE participant_ref = p_participant_ref AND ended_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'PARTICIPANT_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

-- An assignment and the companion's leaving are serialized: both seats are locked in id order, then
-- the companion participant (share), the same order as a seat that leaves (seat, then its participant)
-- and after any participant ending (participant row). Whatever committed first, the second sees it:
-- an assignment waits and then refuses an ended companion; an ending waits and then revokes the new
-- assignment (fn_seat_participant_left). The insert guard re-checks with a fresh snapshot.
CREATE FUNCTION fn_companion_lock(p_minor uuid, p_companion uuid, p_participant uuid) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM 1 FROM seat_slot WHERE id IN (p_minor, p_companion) ORDER BY id FOR UPDATE;
  IF p_participant IS NOT NULL THEN
    PERFORM 1 FROM seat_participant WHERE participant_ref = p_participant AND seat_slot_id = p_companion AND ended_at IS NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'COMPANION_INVALID' USING ERRCODE = '55000'; END IF;
  END IF;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_companion_assign_in_purchase(p_minor_slot_ref text, p_companion_slot_ref text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_minor uuid := fn_slot_id(p_minor_slot_ref); v_companion uuid := fn_slot_id(p_companion_slot_ref); v_ref text := fn_new_ref('ca');
BEGIN
  PERFORM fn_companion_lock(v_minor, v_companion, NULL);
  IF EXISTS (SELECT 1 FROM companion_assignment WHERE minor_slot_id = v_minor AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'COMPANION_ACTIVE' USING ERRCODE = '55000';
  END IF;
  INSERT INTO companion_assignment (companion_ref, minor_slot_id, companion_slot_id, assigned_by_kind, assigned_by)
    VALUES (v_ref, v_minor, v_companion, 'BUYER', 'buyer');
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- Staff assignment across purchases; an existing assignment of the minor is revoked as REASSIGNED.
CREATE FUNCTION fn_companion_assign_staff(p_admin_id uuid, p_minor_slot_ref text, p_companion_participant_ref uuid, p_reason text)
RETURNS text SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'companion.assign'); v_reason text := fn_staff_reason(p_reason);
  v_minor uuid := fn_slot_id(p_minor_slot_ref); v_companion uuid; v_ref text := fn_new_ref('ca');
BEGIN
  -- seat_slot_id never changes: read it unlocked to find the seat, then lock and re-check (fn_companion_lock).
  SELECT seat_slot_id INTO v_companion FROM seat_participant WHERE participant_ref = p_companion_participant_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANION_INVALID' USING ERRCODE = '55000'; END IF;
  PERFORM fn_companion_lock(v_minor, v_companion, p_companion_participant_ref);
  UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = 'REASSIGNED'
    WHERE minor_slot_id = v_minor AND revoked_at IS NULL;
  INSERT INTO companion_assignment (companion_ref, minor_slot_id, companion_slot_id, companion_participant_ref,
      assigned_by_kind, assigned_by_admin, assigned_by, reason)
    VALUES (v_ref, v_minor, v_companion, p_companion_participant_ref, 'STAFF', p_admin_id, v_by, v_reason);
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- The companion confirms an assignment already authorized for them; it cannot create one.
CREATE FUNCTION fn_companion_confirm(p_companion_ref text, p_participant_ref uuid) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  UPDATE companion_assignment SET confirmed_at = clock_timestamp()
    WHERE companion_ref = p_companion_ref AND revoked_at IS NULL AND confirmed_at IS NULL
      AND companion_participant_ref = p_participant_ref;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

-- The buyer may undo only their own in-purchase assignment; staff assignments are staff's.
CREATE FUNCTION fn_companion_revoke(p_companion_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_reason text := fn_text_arg(p_reason, 'REASON_INVALID');
BEGIN
  UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = v_reason
    WHERE companion_ref = p_companion_ref AND revoked_at IS NULL AND assigned_by_kind = 'BUYER';
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_companion_revoke_staff(p_admin_id uuid, p_companion_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, 'companion.assign'); v_reason text := fn_staff_reason(p_reason);
BEGIN
  UPDATE companion_assignment SET revoked_at = clock_timestamp(), revoke_reason = left(v_by || ': ' || v_reason, 500)
    WHERE companion_ref = p_companion_ref AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'COMPANION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_seat_invitation_issue(p_slot_ref text, p_purpose text, p_token_sha256 text, p_companion_ref text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_slot uuid := fn_slot_id(p_slot_ref); v_assignment uuid; v_ref text := fn_new_ref('iv');
BEGIN
  IF p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'INVITATION_TOKEN_INVALID' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM seat_slot WHERE id = v_slot FOR UPDATE;
  IF EXISTS (SELECT 1 FROM seat_invitation WHERE seat_slot_id = v_slot AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'INVITATION_ACTIVE' USING ERRCODE = '55000';
  END IF;
  IF p_companion_ref IS NOT NULL THEN
    -- Same order as an assignment: seats, then the companion participant; then the assignment itself.
    SELECT id INTO v_assignment FROM companion_assignment WHERE companion_ref = p_companion_ref AND minor_slot_id = v_slot;
    IF FOUND THEN
      PERFORM fn_companion_lock(v_slot, (SELECT companion_slot_id FROM companion_assignment WHERE id = v_assignment),
        (SELECT companion_participant_ref FROM companion_assignment WHERE id = v_assignment));
      PERFORM 1 FROM companion_assignment WHERE id = v_assignment FOR SHARE;
    END IF;
  END IF;
  INSERT INTO seat_invitation (invitation_ref, seat_slot_id, purpose, companion_assignment_id, token_sha256)
    VALUES (v_ref, v_slot, p_purpose, v_assignment, p_token_sha256);
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_seat_invitation_revoke(p_invitation_ref text, p_reason text) RETURNS void
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_reason text := fn_text_arg(p_reason, 'REASON_INVALID');
BEGIN
  UPDATE seat_invitation SET revoked_at = clock_timestamp(), revoke_reason = v_reason WHERE invitation_ref = p_invitation_ref AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
END $fn$ LANGUAGE plpgsql;

-- An assignment still stands only while its companion does: not revoked, the companion's seat
-- CONFIRMED and, for a staff assignment, its participant not ended.
CREATE FUNCTION fn_companion_current(p_assignment uuid) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM companion_assignment a JOIN seat_slot c ON c.id = a.companion_slot_id
   WHERE a.id = p_assignment AND a.revoked_at IS NULL AND c.state = 'CONFIRMED'
     AND (a.companion_participant_ref IS NULL OR EXISTS (SELECT 1 FROM seat_participant sp
            WHERE sp.participant_ref = a.companion_participant_ref AND sp.ended_at IS NULL)))
$fn$ LANGUAGE sql;

-- The bearer token is single-use (v1.8.2 §3 п.5): it only finds an invitation that is live and not
-- yet claimed. After the claim the token alone opens nothing; the guest's OTP session (TOUR-99, A2b)
-- is checked against fn_seat_invitation_live on every request (§3 п.9).
CREATE FUNCTION fn_seat_invitation_live(p_invitation_ref text) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM seat_invitation i JOIN seat_slot s ON s.id = i.seat_slot_id
   WHERE i.invitation_ref = p_invitation_ref AND i.revoked_at IS NULL AND s.state = 'CONFIRMED'
     AND (i.companion_assignment_id IS NULL OR fn_companion_current(i.companion_assignment_id)))
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_seat_invitation_claimable(p_token_sha256 text)
RETURNS TABLE (invitation_ref text, seat_slot_ref text, purpose text)
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT i.invitation_ref, s.seat_slot_ref, i.purpose
    FROM seat_invitation i JOIN seat_slot s ON s.id = i.seat_slot_id
   WHERE i.token_sha256 = p_token_sha256 AND i.claimed_at IS NULL AND fn_seat_invitation_live(i.invitation_ref)
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_seat_invitation_claim(p_token_sha256 text) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_ref text;
BEGIN
  SELECT a.invitation_ref INTO v_ref FROM fn_seat_invitation_claimable(p_token_sha256) a;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'INVITATION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
  UPDATE seat_invitation SET claimed_at = clock_timestamp() WHERE invitation_ref = v_ref AND claimed_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'INVITATION_NOT_ACTIVE' USING ERRCODE = '55000'; END IF;
  RETURN v_ref;
END $fn$ LANGUAGE plpgsql;

-- maintain(): a PRICED_SLOTS document order ends (EXPIRED, then its buyer data under the unpaid
-- retention) only when every seat is released, no hold is open (no UNKNOWN), and no retry is possible
-- any more: the earlier of 24 hours after the purchase was created and T−24 has passed, by the
-- database clock. Retries do not extend it.
CREATE FUNCTION fn_priced_document_order_closable(p_order uuid) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM seat_slot s WHERE s.purchase_id = p.id AND s.state <> 'RELEASED')
     AND NOT EXISTS (SELECT 1 FROM seat_hold h WHERE h.purchase_id = p.id AND h.closed_at IS NULL)
     AND clock_timestamp() >= least(p.created_at + interval '24 hours',
           (SELECT fn_departure_cutoff(r.departure_id) FROM purchase_revision r WHERE r.purchase_id = p.id AND r.revision = p.current_revision))
    FROM purchase p WHERE p.origin_order_id = p_order
$fn$ LANGUAGE sql;

-- Closes what is closable, one document order at a time under its row lock (the lock a retry takes),
-- re-checking after the lock; an order a retry holds is skipped and seen again next run.
CREATE FUNCTION fn_priced_document_orders_close() RETURNS SETOF uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v uuid;
BEGIN
  FOR v IN SELECT o.id FROM orders o WHERE o.seat_model = 'PRICED_SLOTS' AND o.status = 'RESERVED' AND o.closed_at IS NULL
           ORDER BY o.id FOR UPDATE SKIP LOCKED LOOP
    CONTINUE WHEN NOT coalesce(fn_priced_document_order_closable(v), false);
    UPDATE orders SET status = 'EXPIRED', closed_at = clock_timestamp() WHERE id = v AND status = 'RESERVED';
    CONTINUE WHEN NOT FOUND;
    RETURN NEXT v;
  END LOOP;
END $fn$ LANGUAGE plpgsql;

-- OWNER decision 8B (06.11.2026): the buyer's personal data of a closed, unpaid PRICED_SLOTS purchase
-- is erased at its closure, with no further delay. Closure itself already waits for every exception:
-- no open hold (no attempt in flight or UNKNOWN), no paid seat or paid-no-seat claim
-- (fn_priced_document_order_closable); a legal hold still stops erasure. UNIFORM orders keep 0017's
-- rules unchanged. What is erased is the order's buyer contact, outbox address and unpaid document
-- bytes (maintain()); the purchase, seats, prices, holds, attempts and audit stay.
CREATE OR REPLACE FUNCTION fn_purchase_pd_retention_due(p_order_id uuid) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT NOT EXISTS (SELECT 1 FROM purchase_revision WHERE document_order_id = o.id)
      OR (NOT o.legal_hold
          AND ((o.status IN ('EXPIRED','CANCELLED') AND o.closed_recorded_at <= clock_timestamp() - interval '24 hours')
            OR (o.status IN ('PAID','FULFILLED','REFUNDED') AND o.trip_ends_on + 90 < (clock_timestamp() AT TIME ZONE 'UTC')::date)
            OR (o.seat_model = 'PRICED_SLOTS' AND o.status = 'EXPIRED' AND o.closed_recorded_at IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM purchase p JOIN seat_slot s ON s.purchase_id = p.id
                                 WHERE p.origin_order_id = o.id AND s.state <> 'RELEASED')
                AND NOT EXISTS (SELECT 1 FROM purchase p JOIN seat_hold h ON h.purchase_id = p.id
                                 WHERE p.origin_order_id = o.id AND (h.closed_at IS NULL OR h.outcome = 'PAID')))))
    FROM orders o WHERE o.id = p_order_id
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- 10. The pause of minors' sales (same lock order as checkout: row, then advisory). OWNER decision 3
--     (06.11.2026): the child price, minors' permission and minimum age are offer terms, set only by
--     the departure's publication (A2b-8, before sales); no separate command writes them. The pause
--     stays an operational switch with reason, audit and CAS.

CREATE FUNCTION fn_departure_minor_lock(p_id uuid, p_expected int) RETURNS departure
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE;
BEGIN
  SELECT * INTO d FROM departure WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
  IF d.minor_settings_version IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'DEPARTURE_MINOR_CONFLICT' USING ERRCODE = '55000'; END IF;
  RETURN d;
END $fn$ LANGUAGE plpgsql;

-- Blocks new 0–13/14–17 seats of every new purchase, linked ones included; paid seats stay.
CREATE FUNCTION fn_admin_minor_sales_pause(p_admin_id uuid, p_id uuid, p_expected int, p_paused boolean, p_reason text) RETURNS int
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_by text := fn_staff_require(p_admin_id, CASE WHEN p_paused THEN 'minor_sales.pause' ELSE 'minor_sales.resume' END);
  v_reason text := fn_staff_reason(p_reason); d departure%ROWTYPE := fn_departure_minor_lock(p_id, p_expected);
BEGIN
  IF p_paused IS NULL THEN RAISE EXCEPTION 'DEPARTURE_MINOR_SETTINGS_INVALID' USING ERRCODE = '22023'; END IF;
  PERFORM fn_editorial_command(true);
  UPDATE departure SET minor_sales_paused = p_paused, minor_settings_version = d.minor_settings_version + 1 WHERE id = p_id;
  PERFORM fn_editorial_command(false);
  INSERT INTO departure_minor_event (departure_id, actor, action, reason, version, details)
    VALUES (p_id, v_by, CASE WHEN p_paused THEN 'PAUSE' ELSE 'RESUME' END, v_reason, d.minor_settings_version + 1, '{}'::jsonb);
  RETURN d.minor_settings_version + 1;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- 11. Privileges. Tables are read-only to the services; every write goes through the functions.

REVOKE ALL ON admin_capability_grant, departure_minor_event, purchase_group, purchase_group_link, purchase_group_member,
  pricing_basis, seat_hold, seat_slot, seat_slot_event, purchase_revision_line, seat_participant, companion_assignment, seat_invitation,
  seat_slot_current, departure_seat_projection, purchase_group_projection FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_order_seat_model_immutable(), fn_priced_slots_no_passenger(), fn_staff_role_permits(text, text),
  fn_staff_permission_capability(text), fn_staff_permission_known(text), fn_staff_permitted(uuid, text), fn_staff_require(uuid, text),
  fn_staff_reason(text), fn_capability_grant_guard(), fn_admin_grant_capability(text, text, text, text),
  fn_admin_revoke_capability(text, text, text, text), fn_pricing_basis_price(uuid, text), fn_purchase_lines_sha256(uuid, int),
  fn_purchase_revision_slot_model(), fn_purchase_in_creation(uuid), fn_pricing_basis_on_insert(), fn_seat_slot_on_insert(),
  fn_seat_slot_guard(), fn_purchase_line_on_insert(), fn_group_member_on_insert(), fn_group_link_guard(),
  fn_seat_slot_occupies(text, boolean, timestamptz, timestamptz), fn_new_ref(text),
  fn_open_slotted_purchase(uuid, int, int, int, text, text, text), fn_group_link_replay(text, text, text),
  fn_group_link_issue(uuid, text, text, int, int, int), fn_group_link_revoke(uuid, text, text), fn_text_arg(text, text),
  fn_seat_hold_guard(), fn_purchase_lock_departure(uuid), fn_departure_has_room(text, int), fn_purchase_id(text),
  fn_purchase_hold_fence(text, text), fn_purchase_payment_failed(text, text), fn_purchase_payment_confirmed(text, text),
  fn_seat_holds_close_lapsed(), fn_purchase_rehold(text), fn_seat_slot_refund_settled(text, text),
  fn_priced_document_order_closable(uuid), fn_priced_document_orders_close(), fn_departure_cutoff(uuid),
  fn_departure_admission_refusal(uuid), fn_new_hold_expiry(uuid), fn_seat_slot_assign_no_seat(uuid, text, text), fn_seat_participant_guard(), fn_companion_assignment_guard(),
  fn_seat_invitation_guard(), fn_seat_slot_left(), fn_seat_participant_left(), fn_companion_assignment_left(), fn_slot_id(text),
  fn_seat_participant_open(text), fn_seat_participant_end(uuid, text), fn_companion_assign_in_purchase(text, text),
  fn_companion_lock(uuid, uuid, uuid), fn_companion_current(uuid),
  fn_companion_assign_staff(uuid, text, uuid, text), fn_companion_confirm(text, uuid), fn_companion_revoke(text, text),
  fn_companion_revoke_staff(uuid, text, text), fn_seat_invitation_issue(text, text, text, text), fn_seat_invitation_revoke(text, text),
  fn_seat_invitation_live(text), fn_seat_invitation_claimable(text), fn_seat_invitation_claim(text), fn_departure_minor_lock(uuid, int),
  fn_admin_minor_sales_pause(uuid, uuid, int, boolean, text)
  FROM PUBLIC;

-- The public service: checkout, payments' seat transitions, personalization identities.
GRANT SELECT (child_price_kopecks, minors_allowed, minor_min_age, minor_sales_paused, minor_settings_version) ON departure TO commerce_app, admin_app;
GRANT SELECT ON purchase_group, purchase_group_member, pricing_basis, seat_hold, seat_slot, seat_slot_event, purchase_revision_line,
  seat_participant, companion_assignment, seat_slot_current, departure_seat_projection, purchase_group_projection TO commerce_app, admin_app;
GRANT SELECT (id, invitation_ref, seat_slot_id, purpose, companion_assignment_id, issued_at, claimed_at, revoked_at, revoke_reason)
  ON seat_invitation TO commerce_app, admin_app;
GRANT SELECT (id, group_link_ref, group_id, issued_by_admin, issued_by, issued_at, revoked_at, revoked_by, revoke_reason, consumed_at,
  consumed_purchase_id, adults, teens, children) ON purchase_group_link TO commerce_app, admin_app;
GRANT SELECT ON departure_minor_event TO admin_app;
GRANT SELECT ON admin_capability_grant TO admin_app, admin_operator;
GRANT EXECUTE ON FUNCTION fn_open_slotted_purchase(uuid, int, int, int, text, text, text), fn_group_link_replay(text, text, text),
  fn_purchase_hold_fence(text, text), fn_purchase_payment_failed(text, text), fn_purchase_payment_confirmed(text, text),
  fn_seat_holds_close_lapsed(), fn_purchase_rehold(text), fn_seat_slot_refund_settled(text, text),
  fn_priced_document_orders_close(), fn_seat_participant_open(text), fn_seat_participant_end(uuid, text), fn_companion_assign_in_purchase(text, text),
  fn_companion_confirm(text, uuid), fn_companion_revoke(text, text), fn_seat_invitation_issue(text, text, text, text),
  fn_seat_invitation_revoke(text, text), fn_seat_invitation_live(text), fn_seat_invitation_claimable(text),
  fn_seat_invitation_claim(text) TO commerce_app;
-- The deferred completeness check (fn_purchase_complete) runs at COMMIT as the session's login.
GRANT EXECUTE ON FUNCTION fn_purchase_lines_sha256(uuid, int) TO commerce_app;
-- Functions inside views are executed with the reader's EXECUTE privilege.
GRANT EXECUTE ON FUNCTION fn_seat_slot_occupies(text, boolean, timestamptz, timestamptz) TO commerce_app, admin_app;
-- The Admin API: staff commands, each checking the signed-in account's permission in the database.
GRANT EXECUTE ON FUNCTION fn_staff_permitted(uuid, text), fn_group_link_issue(uuid, text, text, int, int, int), fn_group_link_revoke(uuid, text, text),
  fn_seat_slot_assign_no_seat(uuid, text, text), fn_companion_assign_staff(uuid, text, uuid, text),
  fn_companion_revoke_staff(uuid, text, text), fn_admin_minor_sales_pause(uuid, uuid, int, boolean, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_admin_grant_capability(text, text, text, text), fn_admin_revoke_capability(text, text, text, text)
  TO admin_operator;
