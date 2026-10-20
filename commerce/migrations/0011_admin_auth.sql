-- ADR v2.3 §7 (Linear ART-363; adman-vps-infrastructure runbooks/application-standards.md §1): the
-- isolated Admin API's own accounts, second factor, sessions and audit.
--
--   accounts   OWNER or EDITOR, created only by an operator over SSH (admin_operator). The password
--              is stored as scrypt; nothing here is ever readable by the public service.
--   TOTP       RFC 6238 (SHA-1, 6 digits, 30 s, ±1 step). The seed is stored only encrypted under a
--              key the Admin API holds in its environment; this database never sees it in clear.
--              A step is accepted at most once and never at or before the last accepted one.
--              Enrolment is open for 24 hours after an operator creates the account or resets its
--              TOTP, and closes at the first confirmed code. No recovery codes, no web disable: a lost
--              device is `admin-operator totp reset` over SSH, audited, which revokes every session.
--   sessions   only a MAC of a random token, keyed by a secret the Admin API derives from its
--              environment key: a row written with this database's credentials alone names no token
--              anyone holds, so it can never be presented over HTTP. A session is opened only by
--              fn_admin_login, in the same transaction that spends a TOTP step and writes its
--              AUTH.LOGIN audit row, and it names that row for its whole life (refresh carries it
--              over). Only an enabled account with a confirmed second factor has one. Revoked stays
--              revoked.
--   evidence   every audit row the Admin API writes carries an attestation: a MAC over the row,
--              under the same environment secret. The database stores it and cannot make one, so an
--              AUTH.LOGIN row, or a publish that names it, written with this database's credentials
--              alone fails verification (src/admin/attestation.ts). What admin_app's credential still
--              can do without the Admin API (call the editorial functions of 0008-0010 directly) leaves
--              no attested row behind, and is told apart that way, not prevented.
--   audit      append-only, for every login: the database records when and through which login.
--
-- Roles. admin_app (the Admin API's login) reads accounts, opens and refreshes sessions only through
-- fn_admin_login/fn_admin_session_rotate, writes the throttle and audit rows, and starts an
-- enrolment only through fn_admin_totp_begin. admin_operator (an operator's
-- login, never the API's) manages accounts through fn_admin_* below. Neither may belong to
-- commerce_app or commerce_operator: every function here refuses such a login, whatever the grants
-- say. commerce_app has no right on any of it.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_app') THEN
    CREATE ROLE admin_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_operator') THEN
    CREATE ROLE admin_operator NOLOGIN;
  END IF;
END $$;

CREATE TABLE admin_user (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login                 text NOT NULL UNIQUE CHECK (login ~ '^[a-z][a-z0-9._-]{2,63}$'),
  role                  text NOT NULL CHECK (role IN ('OWNER', 'EDITOR')),
  -- scrypt:v1:N:r:p:<16-byte salt>:<64-byte key>, both base64url (src/admin/password.ts).
  password_scrypt       text NOT NULL CHECK (password_scrypt ~ '^scrypt:v1:16384:8:1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{86}$'),
  password_changed_at   timestamptz NOT NULL,
  totp_enrollment_until timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  disabled_at           timestamptz
);

CREATE TABLE admin_totp (
  admin_id           uuid PRIMARY KEY REFERENCES admin_user(id) ON DELETE RESTRICT,
  -- v1.<iv>.<tag>.<ciphertext>: AES-256-GCM, bound to the account id.
  seed_ciphertext    text NOT NULL CHECK (seed_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  last_accepted_step bigint CHECK (last_accepted_step >= 0),
  enrolled_at        timestamptz NOT NULL,
  confirmed_at       timestamptz,
  CHECK (confirmed_at IS NULL OR last_accepted_step IS NOT NULL)
);

CREATE TABLE admin_audit (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL,
  -- The database login that wrote the row: recorded by the database, not supplied by the caller.
  login_role  text NOT NULL,
  admin_id    uuid REFERENCES admin_user(id) ON DELETE RESTRICT,
  actor       text NOT NULL CHECK (length(actor) BETWEEN 1 AND 120 AND actor !~ '[[:cntrl:]]'),
  action      text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_.]{2,63}$'),
  outcome     text NOT NULL CHECK (outcome IN ('OK', 'REFUSED')),
  entity_type text CHECK (entity_type ~ '^[a-z_]{1,40}$'),
  entity_id   text CHECK (length(entity_id) BETWEEN 1 AND 120),
  details     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object' AND length(details::text) <= 4096),
  -- The Admin API's MAC over this row (src/admin/attestation.ts); NULL for operator and owner rows.
  attestation text CHECK (attestation ~ '^[0-9a-f]{64}$')
);
CREATE INDEX admin_audit_at ON admin_audit (at DESC);

CREATE TABLE admin_session (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id            uuid NOT NULL REFERENCES admin_user(id) ON DELETE RESTRICT,
  -- HMAC-SHA256 of the token under the Admin API's session key, never the token itself.
  token_mac           text NOT NULL UNIQUE CHECK (token_mac ~ '^[0-9a-f]{64}$'),
  created_at          timestamptz NOT NULL,
  last_seen_at        timestamptz NOT NULL,
  idle_expires_at     timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  -- A refresh replaces the token: the new session names the one it replaced.
  rotated_from        uuid REFERENCES admin_session(id) ON DELETE RESTRICT,
  -- The AUTH.LOGIN row of the password + TOTP login that admitted this session (kept across refresh).
  auth_audit_id       bigint NOT NULL REFERENCES admin_audit(id) ON DELETE RESTRICT,
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IN ('LOGOUT', 'REFRESH', 'REVOKED', 'TOTP_RESET',
                                                     'PASSWORD_CHANGED', 'USER_DISABLED')),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (absolute_expires_at > created_at AND absolute_expires_at <= created_at + interval '12 hours'),
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX admin_session_live ON admin_session (admin_id) WHERE revoked_at IS NULL;

-- One limit for password and code attempts: a bucket is a keyed hash of the trusted client source
-- or of the login, never the address or the login itself.
CREATE TABLE admin_login_throttle (
  bucket       text NOT NULL CHECK (bucket ~ '^(source|account):[0-9a-f]{64}$'),
  window_start timestamptz NOT NULL,
  attempts     int NOT NULL CHECK (attempts >= 1),
  PRIMARY KEY (bucket, window_start)
);
-- Old windows are pruned by the Admin API's timer, outside the login path.
CREATE INDEX admin_login_throttle_window ON admin_login_throttle (window_start);


-- ---------------------------------------------------------------------------------------------
-- Invariants for every login, the owner's included.

CREATE FUNCTION fn_admin_audit_stamp() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.at := now();
  NEW.login_role := session_user;
  -- The Admin API attests every row it writes; one without is not the Admin API's.
  IF NEW.attestation IS NULL AND pg_has_role(session_user, 'admin_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'ADMIN_AUDIT_ATTESTATION_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_admin_audit_stamp BEFORE INSERT ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION fn_admin_audit_stamp();

CREATE FUNCTION fn_admin_audit_append_only() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION 'ADMIN_AUDIT_APPEND_ONLY' USING ERRCODE = '55000';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_admin_audit_append_only BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION fn_admin_audit_append_only();
CREATE TRIGGER trg_admin_audit_no_truncate BEFORE TRUNCATE ON admin_audit
  FOR EACH STATEMENT EXECUTE FUNCTION fn_admin_audit_append_only();

-- A confirmed seed never changes (a reset deletes it), and a code's step only ever moves forward.
CREATE FUNCTION fn_admin_totp_forward_only() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.admin_id IS DISTINCT FROM OLD.admin_id
     OR (OLD.confirmed_at IS NOT NULL AND (NEW.seed_ciphertext IS DISTINCT FROM OLD.seed_ciphertext
         OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at))
     OR (NEW.seed_ciphertext IS NOT DISTINCT FROM OLD.seed_ciphertext AND OLD.last_accepted_step IS NOT NULL
         AND (NEW.last_accepted_step IS NULL OR NEW.last_accepted_step < OLD.last_accepted_step)) THEN
    RAISE EXCEPTION 'ADMIN_TOTP_REPLAY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_admin_totp_forward_only BEFORE UPDATE ON admin_totp
  FOR EACH ROW EXECUTE FUNCTION fn_admin_totp_forward_only();

-- No session without an enabled account and a confirmed second factor.
CREATE FUNCTION fn_admin_session_admissible() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.revoked_at IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM admin_user u JOIN admin_totp t ON t.admin_id = u.id
                    WHERE u.id = NEW.admin_id AND u.disabled_at IS NULL AND t.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ADMIN_SESSION_NOT_ADMISSIBLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_admin_session_admissible BEFORE INSERT ON admin_session
  FOR EACH ROW EXECUTE FUNCTION fn_admin_session_admissible();

CREATE FUNCTION fn_admin_session_revocation_final() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_reason IS DISTINCT FROM OLD.revoked_reason
     OR NEW.idle_expires_at IS DISTINCT FROM OLD.idle_expires_at) THEN
    RAISE EXCEPTION 'ADMIN_SESSION_REVOKED' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_admin_session_revocation_final BEFORE UPDATE ON admin_session
  FOR EACH ROW EXECUTE FUNCTION fn_admin_session_revocation_final();

-- ---------------------------------------------------------------------------------------------
-- The Admin API's commands (admin_app).

-- The public service and the commerce operator never act as Admin, whatever grants say.
CREATE FUNCTION fn_admin_not_commerce() RETURNS void SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF (pg_has_role(session_user, 'commerce_app', 'MEMBER') OR pg_has_role(session_user, 'commerce_operator', 'MEMBER'))
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'ADMIN_COMMERCE_LOGIN: % belongs to commerce', session_user USING ERRCODE = '42501';
  END IF;
END $fn$ LANGUAGE plpgsql;

-- A new, unconfirmed seed, only inside the enrolment window and never over a confirmed one.
CREATE FUNCTION fn_admin_totp_begin(p_admin_id uuid, p_seed_ciphertext text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  u admin_user%ROWTYPE;
BEGIN
  PERFORM fn_admin_not_commerce();
  SELECT * INTO u FROM admin_user WHERE id = p_admin_id FOR UPDATE;
  IF NOT FOUND OR u.disabled_at IS NOT NULL THEN
    RAISE EXCEPTION 'ADMIN_USER_UNKNOWN' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (SELECT 1 FROM admin_totp WHERE admin_id = p_admin_id AND confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'TOTP_ALREADY_ENROLLED' USING ERRCODE = '55000';
  END IF;
  IF u.totp_enrollment_until IS NULL OR u.totp_enrollment_until <= now() THEN
    RAISE EXCEPTION 'TOTP_ENROLLMENT_CLOSED' USING ERRCODE = '55000';
  END IF;
  INSERT INTO admin_totp (admin_id, seed_ciphertext, last_accepted_step, enrolled_at, confirmed_at)
    VALUES (p_admin_id, p_seed_ciphertext, NULL, now(), NULL)
    ON CONFLICT (admin_id) DO UPDATE SET seed_ciphertext = EXCLUDED.seed_ciphertext,
      last_accepted_step = NULL, enrolled_at = EXCLUDED.enrolled_at, confirmed_at = NULL;
END $fn$ LANGUAGE plpgsql;

-- Spends the step a code matched. Conditional under the row lock, so two requests with the same
-- code never both pass. Confirming closes the enrolment window.
CREATE FUNCTION fn_admin_totp_accept(p_admin_id uuid, p_step bigint, p_confirming boolean)
RETURNS boolean SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  t admin_totp%ROWTYPE;
  v_until timestamptz;
BEGIN
  PERFORM fn_admin_not_commerce();
  SELECT * INTO t FROM admin_totp WHERE admin_id = p_admin_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOTP_NOT_ENROLLED' USING ERRCODE = '55000'; END IF;
  IF (t.confirmed_at IS NOT NULL) = p_confirming THEN
    RAISE EXCEPTION '%', CASE WHEN p_confirming THEN 'TOTP_ALREADY_ENROLLED' ELSE 'TOTP_NOT_ENROLLED' END USING ERRCODE = '55000';
  END IF;
  IF p_confirming THEN
    SELECT totp_enrollment_until INTO v_until FROM admin_user WHERE id = p_admin_id FOR UPDATE;
    IF v_until IS NULL OR v_until <= now() THEN
      RAISE EXCEPTION 'TOTP_ENROLLMENT_CLOSED' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF p_step IS NULL OR p_step < 0 OR (t.last_accepted_step IS NOT NULL AND p_step <= t.last_accepted_step) THEN
    RETURN false;
  END IF;
  UPDATE admin_totp SET last_accepted_step = p_step, confirmed_at = coalesce(confirmed_at, now())
    WHERE admin_id = p_admin_id;
  IF p_confirming THEN
    UPDATE admin_user SET totp_enrollment_until = NULL WHERE id = p_admin_id;
  END IF;
  RETURN true;
END $fn$ LANGUAGE plpgsql;

-- The only way a session begins: the step a code matched is spent (fn_admin_totp_accept), the
-- AUTH.LOGIN row is written with the Admin API's attestation, and the session that names it is
-- opened, all at once. Nothing is returned when the step is not accepted (a code already used, or an
-- earlier one). The database cannot check the step against the seed, nor the attestation: holding
-- only this database's credentials, a caller gets a row whose token MAC matches no token and whose
-- attestation does not verify.
CREATE FUNCTION fn_admin_login(p_session_id uuid, p_admin_id uuid, p_step bigint, p_confirming boolean, p_token_mac text,
  p_now timestamptz, p_idle_seconds int, p_attestation text)
RETURNS TABLE (out_session_id uuid, out_auth_audit_id bigint, out_idle_expires_at timestamptz, out_absolute_expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_login text;
  v_audit bigint;
  v_absolute timestamptz := p_now + interval '12 hours';
  v_idle timestamptz;
BEGIN
  PERFORM fn_admin_not_commerce();
  IF p_session_id IS NULL OR p_now IS NULL OR p_idle_seconds IS NULL OR p_idle_seconds NOT BETWEEN 60 AND 43200 THEN
    RAISE EXCEPTION 'ADMIN_SESSION_LIFETIME_INVALID' USING ERRCODE = '22023';
  END IF;
  v_idle := least(p_now + make_interval(secs => p_idle_seconds), v_absolute);
  IF NOT fn_admin_totp_accept(p_admin_id, p_step, p_confirming) THEN RETURN; END IF;
  SELECT login INTO v_login FROM admin_user WHERE id = p_admin_id;
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details, attestation)
    VALUES (p_admin_id, v_login, 'AUTH.LOGIN', 'OK', 'admin_session', p_session_id::text,
            jsonb_build_object('totpStep', p_step, 'enrolment', p_confirming), p_attestation)
    RETURNING id INTO v_audit;
  INSERT INTO admin_session (id, admin_id, token_mac, created_at, last_seen_at, idle_expires_at, absolute_expires_at, auth_audit_id)
    VALUES (p_session_id, p_admin_id, p_token_mac, p_now, p_now, v_idle, v_absolute, v_audit);
  RETURN QUERY SELECT p_session_id, v_audit, v_idle, v_absolute;
END $fn$ LANGUAGE plpgsql;

-- The account row share-locked to the end of the caller's transaction, if it is enabled. A publish
-- takes it before its session row, the order every operator command takes them, so a disable, a
-- reset, a password change or a revocation either committed before (and the publish is refused) or
-- waits until the publish is done. admin_app holds no UPDATE right that a direct FOR SHARE would need.
CREATE FUNCTION fn_admin_lock_account(p_admin_id uuid) RETURNS boolean
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM fn_admin_not_commerce();
  PERFORM 1 FROM admin_user WHERE id = p_admin_id AND disabled_at IS NULL FOR SHARE;
  RETURN FOUND;
END $fn$ LANGUAGE plpgsql;

-- Refresh: a live session's token is replaced. The new session keeps the 12-hour limit and the
-- authentication of the old one, which is revoked in the same transaction.
CREATE FUNCTION fn_admin_session_rotate(p_token_mac text, p_new_token_mac text, p_now timestamptz, p_idle_seconds int)
RETURNS TABLE (out_session_id uuid, out_auth_audit_id bigint, out_idle_expires_at timestamptz, out_absolute_expires_at timestamptz)
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  s admin_session%ROWTYPE;
  v_session uuid := gen_random_uuid();
  v_idle timestamptz;
BEGIN
  PERFORM fn_admin_not_commerce();
  IF p_now IS NULL OR p_idle_seconds IS NULL OR p_idle_seconds NOT BETWEEN 60 AND 43200 THEN
    RAISE EXCEPTION 'ADMIN_SESSION_LIFETIME_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO s FROM admin_session WHERE token_mac = p_token_mac AND revoked_at IS NULL
    AND idle_expires_at > p_now AND absolute_expires_at > p_now FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE admin_session SET revoked_at = p_now, revoked_reason = 'REFRESH' WHERE id = s.id;
  v_idle := least(p_now + make_interval(secs => p_idle_seconds), s.absolute_expires_at);
  INSERT INTO admin_session (id, admin_id, token_mac, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
      rotated_from, auth_audit_id)
    VALUES (v_session, s.admin_id, p_new_token_mac, p_now, p_now, v_idle, s.absolute_expires_at, s.id, s.auth_audit_id);
  RETURN QUERY SELECT v_session, s.auth_audit_id, v_idle, s.absolute_expires_at;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Operator commands (admin_operator), run over SSH from a one-off container: never the API's login.

CREATE FUNCTION fn_admin_operator_actor(p_by text) RETURNS text SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF (pg_has_role(session_user, 'admin_app', 'MEMBER') OR pg_has_role(session_user, 'commerce_app', 'MEMBER'))
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'ADMIN_OPERATOR_SERVICE_LOGIN: % belongs to a service', session_user USING ERRCODE = '42501';
  END IF;
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR p_by ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'ADMIN_OPERATOR_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN 'operator:' || btrim(p_by);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_operator_reason(p_reason text) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 OR p_reason ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'ADMIN_OPERATOR_REASON_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_reason);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_operator_user(p_login text) RETURNS uuid SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM admin_user WHERE login = p_login FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ADMIN_USER_UNKNOWN' USING ERRCODE = '55000'; END IF;
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_revoke_all(p_admin_id uuid, p_reason text) RETURNS int SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_count int;
BEGIN
  UPDATE admin_session SET revoked_at = now(), revoked_reason = p_reason
    WHERE admin_id = p_admin_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_create_user(p_login text, p_role text, p_password_scrypt text, p_by text)
RETURNS uuid SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_id uuid;
BEGIN
  INSERT INTO admin_user (login, role, password_scrypt, password_changed_at, totp_enrollment_until)
    VALUES (p_login, p_role, p_password_scrypt, now(), now() + interval '24 hours') RETURNING id INTO v_id;
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_id, v_by, 'USER.CREATED', 'OK', 'admin_user', p_login, jsonb_build_object('role', p_role));
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_set_password(p_login text, p_password_scrypt text, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_id uuid := fn_admin_operator_user(p_login);
  v_revoked int;
BEGIN
  UPDATE admin_user SET password_scrypt = p_password_scrypt, password_changed_at = now() WHERE id = v_id;
  v_revoked := fn_admin_revoke_all(v_id, 'PASSWORD_CHANGED');
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_id, v_by, 'USER.PASSWORD_SET', 'OK', 'admin_user', p_login, jsonb_build_object('sessionsRevoked', v_revoked));
  RETURN v_revoked;
END $fn$ LANGUAGE plpgsql;

-- The lost-device path: the seed is gone, every session is revoked, and the account must enrol
-- again within 24 hours with a new QR code and a first code.
CREATE FUNCTION fn_admin_reset_totp(p_login text, p_by text, p_reason text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_reason text := fn_admin_operator_reason(p_reason);
  v_id uuid := fn_admin_operator_user(p_login);
  v_had boolean;
  v_revoked int;
BEGIN
  DELETE FROM admin_totp WHERE admin_id = v_id;
  v_had := FOUND;
  UPDATE admin_user SET totp_enrollment_until = now() + interval '24 hours' WHERE id = v_id;
  v_revoked := fn_admin_revoke_all(v_id, 'TOTP_RESET');
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_id, v_by, 'TOTP.RESET', 'OK', 'admin_user', p_login,
            jsonb_build_object('reason', v_reason, 'hadTotp', v_had, 'sessionsRevoked', v_revoked));
  RETURN v_revoked;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_set_disabled(p_login text, p_disabled boolean, p_by text, p_reason text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_reason text := fn_admin_operator_reason(p_reason);
  v_id uuid := fn_admin_operator_user(p_login);
  v_revoked int := 0;
BEGIN
  UPDATE admin_user SET disabled_at = CASE WHEN p_disabled THEN coalesce(disabled_at, now()) END WHERE id = v_id;
  IF p_disabled THEN v_revoked := fn_admin_revoke_all(v_id, 'USER_DISABLED'); END IF;
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_id, v_by, CASE WHEN p_disabled THEN 'USER.DISABLED' ELSE 'USER.ENABLED' END, 'OK', 'admin_user', p_login,
            jsonb_build_object('reason', v_reason, 'sessionsRevoked', v_revoked));
  RETURN v_revoked;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_revoke_sessions(p_login text, p_by text, p_reason text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_reason text := fn_admin_operator_reason(p_reason);
  v_id uuid := fn_admin_operator_user(p_login);
  v_revoked int := fn_admin_revoke_all(v_id, 'REVOKED');
BEGIN
  INSERT INTO admin_audit (admin_id, actor, action, outcome, entity_type, entity_id, details)
    VALUES (v_id, v_by, 'SESSION.REVOKED_ALL', 'OK', 'admin_user', p_login,
            jsonb_build_object('reason', v_reason, 'sessionsRevoked', v_revoked));
  RETURN v_revoked;
END $fn$ LANGUAGE plpgsql;

-- Lifts the login throttle, for an owner locked out by someone else's attempts.
CREATE FUNCTION fn_admin_clear_throttle(p_by text, p_reason text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_admin_operator_actor(p_by);
  v_reason text := fn_admin_operator_reason(p_reason);
  v_count int;
BEGIN
  DELETE FROM admin_login_throttle;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO admin_audit (actor, action, outcome, details)
    VALUES (v_by, 'THROTTLE.CLEARED', 'OK', jsonb_build_object('reason', v_reason, 'buckets', v_count));
  RETURN v_count;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Privileges.

REVOKE ALL ON admin_user, admin_totp, admin_session, admin_login_throttle, admin_audit FROM PUBLIC;

-- Readiness: the Admin API serves only at exactly its build's schema version.
GRANT SELECT ON schema_migrations TO admin_app;
GRANT SELECT ON admin_user, admin_totp, admin_session, admin_login_throttle, admin_audit TO admin_app;
GRANT UPDATE (last_seen_at, idle_expires_at, revoked_at, revoked_reason) ON admin_session TO admin_app;
GRANT INSERT, UPDATE (attempts), DELETE ON admin_login_throttle TO admin_app;
GRANT INSERT (admin_id, actor, action, outcome, entity_type, entity_id, details, attestation) ON admin_audit TO admin_app;

-- The operator sees accounts and their state, never a password hash or a seed.
GRANT SELECT (id, login, role, password_changed_at, totp_enrollment_until, created_at, disabled_at) ON admin_user TO admin_operator;
GRANT SELECT (admin_id, last_accepted_step, enrolled_at, confirmed_at) ON admin_totp TO admin_operator;
GRANT SELECT (id, admin_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at, rotated_from, auth_audit_id,
  revoked_at, revoked_reason) ON admin_session TO admin_operator;
GRANT SELECT ON admin_audit TO admin_operator;

REVOKE ALL ON FUNCTION fn_admin_audit_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_audit_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_totp_forward_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_session_admissible() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_session_revocation_final() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_not_commerce() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_totp_begin(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_totp_accept(uuid, bigint, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_login(uuid, uuid, bigint, boolean, text, timestamptz, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_session_rotate(text, text, timestamptz, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_lock_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_operator_actor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_operator_reason(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_operator_user(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_revoke_all(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_create_user(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_set_password(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_reset_totp(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_set_disabled(text, boolean, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_revoke_sessions(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_admin_clear_throttle(text, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION fn_admin_totp_begin(uuid, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_admin_login(uuid, uuid, bigint, boolean, text, timestamptz, int, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_admin_session_rotate(text, text, timestamptz, int) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_admin_lock_account(uuid) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_admin_create_user(text, text, text, text) TO admin_operator;
GRANT EXECUTE ON FUNCTION fn_admin_set_password(text, text, text) TO admin_operator;
GRANT EXECUTE ON FUNCTION fn_admin_reset_totp(text, text, text) TO admin_operator;
GRANT EXECUTE ON FUNCTION fn_admin_set_disabled(text, boolean, text, text) TO admin_operator;
GRANT EXECUTE ON FUNCTION fn_admin_revoke_sessions(text, text, text) TO admin_operator;
GRANT EXECUTE ON FUNCTION fn_admin_clear_throttle(text, text) TO admin_operator;
