-- ADR v2.3 §2–§3 (Linear ART-357): tours and departures as editable offers in PostgreSQL, their
-- editorial revisions, and the order's own immutable contract.
--
--   identity     a tour's slug (offerRef) and a departure's slug (unitRef), the departure's tour and
--                both published_at never change after the first publication. A published tour or
--                departure is never physically deleted; orders reference departures ON DELETE RESTRICT.
--   revisions    "Save draft" writes *_draft only. "Publish" copies the draft into the public row in
--                one transaction, checked against the draft revision and the published version the
--                editor saw: a stale tab or a double click is a conflict, never a silent overwrite.
--                Every publish keeps its immutable *_revision row: what the page showed.
--   date lock    a departure's dates, times and timezone cannot change while it has an active or
--                concluded order (RESERVED unexpired, PAYMENT_PENDING, HELD, PAID, FULFILLED).
--                Only the move/cancel workflow (ADR v2.3 §4, its own reviewed migration) may.
--   snapshot     every new order stores the buyer's whole resolved contract (contract_snapshot,
--                schema mikluha.order-contract/1, sha256 of its RFC 8785 form) bound to the order's
--                own slug, dates, times, timezone and price. It never changes after insert, so a
--                price or programme edit of the departure leaves every existing order as it was.
--
-- Roles. commerce_app (the public service) reads published tours and departures and nothing editorial;
-- it can never write them. admin_app (the isolated Admin API, ADR v2.1 §7) creates tours and
-- departures and edits them only through the functions below; it has no right on orders, payments,
-- the booking switch or EIS. bookingStatus, capacity and isListed transitions are ART-366's: no
-- role may change them yet, so every departure stays CLOSED and unlisted.
-- Historical orders (0001–0007) keep NULL: their contract cannot be reconstructed from today's data.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_app') THEN
    CREATE ROLE admin_app NOLOGIN;
  END IF;
END $$;

CREATE TABLE tour (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  published_version int CHECK (published_version >= 1),
  -- The published projection. A departure copies the template once (ART-358); later edits of the
  -- tour affect only departures created later.
  title             text CHECK (length(title) BETWEEN 1 AND 300),
  contract_template jsonb CHECK (contract_template IS NULL OR jsonb_typeof(contract_template) = 'object'),
  content           jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
  CHECK ((published_at IS NULL) = (published_version IS NULL)),
  CHECK (published_at IS NULL OR (title IS NOT NULL AND content IS NOT NULL))
);

CREATE TABLE departure (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  tour_id           uuid NOT NULL REFERENCES tour(id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  published_version int CHECK (published_version >= 1),
  -- The published projection: what the page shows and new quotes use.
  starts_on         date,
  ends_on           date,
  departure_time    text CHECK (departure_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  return_time       text CHECK (return_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone          text CHECK (length(timezone) BETWEEN 1 AND 100),
  price_kopecks     bigint CHECK (price_kopecks > 0),
  -- The resolved {tour, departure} contract (catalog.ts TourContract/DepartureContract). The schedule
  -- lives in the columns above only, never a second time in here. NULL: not sellable.
  contract          jsonb CHECK (contract IS NULL OR (jsonb_typeof(contract) = 'object'
                      AND NOT coalesce(contract->'departure' ?| ARRAY['departureTime', 'returnTime'], false))),
  content           jsonb CHECK (content IS NULL OR jsonb_typeof(content) = 'object'),
  capacity          int CHECK (capacity >= 1),
  booking_status    text NOT NULL DEFAULT 'CLOSED' CHECK (booking_status IN ('OPEN', 'CLOSED', 'CANCELLED')),
  is_listed         boolean NOT NULL DEFAULT false,
  is_demo           boolean NOT NULL DEFAULT false,
  CHECK ((published_at IS NULL) = (published_version IS NULL)),
  CHECK (ends_on >= starts_on),
  CHECK ((starts_on IS NULL) = (ends_on IS NULL) AND (starts_on IS NULL) = (departure_time IS NULL)
     AND (starts_on IS NULL) = (return_time IS NULL) AND (starts_on IS NULL) = (timezone IS NULL)),
  CHECK (published_at IS NULL OR (starts_on IS NOT NULL AND content IS NOT NULL))
);
CREATE INDEX departure_tour ON departure (tour_id);

CREATE TABLE tour_draft (
  tour_id    uuid PRIMARY KEY REFERENCES tour(id) ON DELETE RESTRICT,
  revision   int NOT NULL CHECK (revision >= 1),
  document   jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND length(document::text) <= 262144),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  login_role text NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE departure_draft (
  departure_id uuid PRIMARY KEY REFERENCES departure(id) ON DELETE RESTRICT,
  revision     int NOT NULL CHECK (revision >= 1),
  document     jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND length(document::text) <= 262144),
  updated_by   text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  login_role   text NOT NULL,
  updated_at   timestamptz NOT NULL
);

-- What each publish made public, exactly. The sha256 is of jsonb's own text form.
CREATE TABLE tour_revision (
  tour_id         uuid NOT NULL REFERENCES tour(id) ON DELETE RESTRICT,
  version         int NOT NULL CHECK (version >= 1),
  draft_revision  int NOT NULL CHECK (draft_revision >= 1),
  document        jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  published_by    text NOT NULL CHECK (length(published_by) BETWEEN 1 AND 100),
  login_role      text NOT NULL,
  published_at    timestamptz NOT NULL,
  PRIMARY KEY (tour_id, version)
);
CREATE TABLE departure_revision (
  departure_id    uuid NOT NULL REFERENCES departure(id) ON DELETE RESTRICT,
  version         int NOT NULL CHECK (version >= 1),
  draft_revision  int NOT NULL CHECK (draft_revision >= 1),
  document        jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  published_by    text NOT NULL CHECK (length(published_by) BETWEEN 1 AND 100),
  login_role      text NOT NULL,
  published_at    timestamptz NOT NULL,
  PRIMARY KEY (departure_id, version)
);
-- The public row always names the revision it shows.
ALTER TABLE tour ADD CONSTRAINT tour_published_revision
  FOREIGN KEY (id, published_version) REFERENCES tour_revision (tour_id, version);
ALTER TABLE departure ADD CONSTRAINT departure_published_revision
  FOREIGN KEY (id, published_version) REFERENCES departure_revision (departure_id, version);

-- ---------------------------------------------------------------------------------------------
-- Identity, deletion and history: enforced for every login, the owner's included.

CREATE FUNCTION fn_tour_identity_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR (OLD.published_at IS NOT NULL AND (NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.published_at IS DISTINCT FROM OLD.published_at))
     OR (OLD.published_version IS NOT NULL AND (NEW.published_version IS NULL OR NEW.published_version < OLD.published_version)) THEN
    RAISE EXCEPTION 'TOUR_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tour_identity_immutable BEFORE UPDATE ON tour
  FOR EACH ROW EXECUTE FUNCTION fn_tour_identity_immutable();

CREATE FUNCTION fn_departure_identity_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR (OLD.published_at IS NOT NULL AND (NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.tour_id IS DISTINCT FROM OLD.tour_id OR NEW.published_at IS DISTINCT FROM OLD.published_at))
     OR (OLD.published_version IS NOT NULL AND (NEW.published_version IS NULL OR NEW.published_version < OLD.published_version)) THEN
    RAISE EXCEPTION 'DEPARTURE_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_identity_immutable BEFORE UPDATE ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_departure_identity_immutable();

CREATE FUNCTION fn_published_undeletable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION '%_PUBLISHED_UNDELETABLE', upper(TG_TABLE_NAME) USING ERRCODE = '55000';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tour_published_undeletable BEFORE DELETE ON tour
  FOR EACH ROW WHEN (OLD.published_at IS NOT NULL) EXECUTE FUNCTION fn_published_undeletable();
CREATE TRIGGER trg_departure_published_undeletable BEFORE DELETE ON departure
  FOR EACH ROW WHEN (OLD.published_at IS NOT NULL) EXECUTE FUNCTION fn_published_undeletable();

CREATE FUNCTION fn_editorial_history_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  RAISE EXCEPTION 'EDITORIAL_HISTORY_IMMUTABLE: %', TG_TABLE_NAME USING ERRCODE = '55000';
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tour_revision_immutable BEFORE UPDATE OR DELETE ON tour_revision
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_departure_revision_immutable BEFORE UPDATE OR DELETE ON departure_revision
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
-- TRUNCATE skips row triggers: refused outright on every table that holds published identity.
CREATE TRIGGER trg_tour_no_truncate BEFORE TRUNCATE ON tour
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_departure_no_truncate BEFORE TRUNCATE ON departure
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_tour_revision_no_truncate BEFORE TRUNCATE ON tour_revision
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_departure_revision_no_truncate BEFORE TRUNCATE ON departure_revision
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();

-- ---------------------------------------------------------------------------------------------
-- The order's contract.

-- Shape checks. CASE, not AND: SQL does not promise to evaluate AND's operands in order, and
-- jsonb_array_elements/jsonb_object_keys raise on the wrong type.
CREATE FUNCTION fn_json_text(j jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'string' THEN length(btrim(j #>> '{}')) > 0 ELSE false END
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_json_text_or_null(j jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'null' THEN true ELSE fn_json_text(j) END
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_json_texts(j jsonb, p_nonempty boolean) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'array'
    THEN (NOT p_nonempty OR jsonb_array_length(j) > 0)
         AND coalesce((SELECT bool_and(fn_json_text(x)) FROM jsonb_array_elements(j) x), true)
    ELSE false END
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_json_keys(j jsonb, p_keys text[]) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'object'
    THEN coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(j) k)
                  = (SELECT array_agg(k ORDER BY k) FROM unnest(p_keys) k), false)
    ELSE false END
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_json_int(j jsonb, p_min numeric) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'number'
    THEN (j #>> '{}')::numeric >= p_min AND (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric)
    ELSE false END
$fn$ LANGUAGE sql;
CREATE FUNCTION fn_json_date(j jsonb) RETURNS date IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN jsonb_typeof(j) = 'string' AND (j #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    THEN make_date(substr(j #>> '{}', 1, 4)::int, substr(j #>> '{}', 6, 2)::int, substr(j #>> '{}', 9, 2)::int) END
$fn$ LANGUAGE sql;

-- mikluha.order-contract/1 (src/contract-snapshot.ts): exactly these keys, every required fact
-- present, and the order's own columns saying the same thing. Checked in steps, each only once the
-- previous one has proved the types it relies on.
CREATE FUNCTION fn_order_contract_snapshot_valid(s jsonb, p_slug text, p_starts date, p_ends date,
  p_departure_time text, p_return_time text, p_timezone text, p_unit_price bigint)
RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
DECLARE
  t jsonb;
  d jsonb;
  a jsonb;
  k jsonb;
BEGIN
  IF NOT fn_json_keys(s, ARRAY['schema', 'tourSlug', 'tourTitle', 'departureSlug', 'startsOn', 'endsOn',
       'timezone', 'unitPriceKopecks', 'currency', 'contract']) THEN RETURN false; END IF;
  IF s->>'schema' IS DISTINCT FROM 'mikluha.order-contract/1'
     OR NOT fn_json_text(s->'tourSlug') OR NOT fn_json_text(s->'tourTitle')
     OR s->>'departureSlug' IS DISTINCT FROM p_slug
     OR fn_json_date(s->'startsOn') IS DISTINCT FROM p_starts OR fn_json_date(s->'endsOn') IS DISTINCT FROM p_ends
     OR p_timezone IS NULL OR s->>'timezone' IS DISTINCT FROM p_timezone
     OR NOT fn_json_int(s->'unitPriceKopecks', 1)
     OR s->>'currency' IS DISTINCT FROM 'RUB'
     OR NOT fn_json_keys(s->'contract', ARRAY['tour', 'departure']) THEN RETURN false; END IF;
  IF (s->>'unitPriceKopecks')::numeric IS DISTINCT FROM p_unit_price THEN RETURN false; END IF;

  t := s #> '{contract,tour}';
  IF NOT fn_json_keys(t, ARRAY['destination', 'route', 'program', 'included', 'excluded', 'insurance', 'risks'])
     OR NOT fn_json_text(t->'destination') OR NOT fn_json_text(t->'route') OR NOT fn_json_text(t->'risks')
     OR NOT fn_json_texts(t->'included', true) OR NOT fn_json_texts(t->'excluded', false)
     OR NOT fn_json_text_or_null(t->'insurance')
     OR coalesce(jsonb_typeof(t->'program'), '') <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(t->'program') = 0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(t->'program') p
                WHERE NOT fn_json_keys(p, ARRAY['title', 'items']) OR NOT fn_json_text(p->'title')
                   OR NOT fn_json_texts(p->'items', true)) THEN RETURN false; END IF;

  d := s #> '{contract,departure}';
  IF NOT fn_json_keys(d, ARRAY['departureTime', 'returnTime', 'departurePoint', 'returnPoint', 'accommodation', 'carrier', 'services'])
     OR p_departure_time IS NULL OR d->>'departureTime' IS DISTINCT FROM p_departure_time
     OR p_return_time IS NULL OR d->>'returnTime' IS DISTINCT FROM p_return_time
     OR NOT fn_json_text(d->'departurePoint') OR NOT fn_json_text(d->'returnPoint')
     OR coalesce(jsonb_typeof(d->'services'), '') <> 'array' THEN RETURN false; END IF;
  a := d->'accommodation';
  IF NOT fn_json_keys(a, ARRAY['name', 'address', 'category', 'registryNumber', 'roomType', 'nights', 'meals', 'legalEntity'])
     OR NOT fn_json_text(a->'name') OR NOT fn_json_text(a->'address') OR NOT fn_json_text(a->'roomType')
     OR NOT fn_json_text(a->'meals') OR NOT fn_json_text(a->'legalEntity')
     OR NOT fn_json_text_or_null(a->'category') OR NOT fn_json_text_or_null(a->'registryNumber')
     OR NOT fn_json_int(a->'nights', 0) THEN RETURN false; END IF;
  k := d->'carrier';
  IF NOT fn_json_keys(k, ARRAY['legalName', 'route', 'vehicle', 'baggage', 'boarding'])
     OR NOT fn_json_text(k->'legalName') OR NOT fn_json_text(k->'route') OR NOT fn_json_text(k->'baggage')
     OR NOT fn_json_text(k->'boarding') OR NOT fn_json_text_or_null(k->'vehicle') THEN RETURN false; END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d->'services') x
    WHERE NOT fn_json_keys(x, ARRAY['name', 'supplier', 'included', 'note']) OR NOT fn_json_text(x->'name')
       OR NOT fn_json_text(x->'supplier') OR coalesce(jsonb_typeof(x->'included'), '') <> 'boolean'
       OR NOT fn_json_text_or_null(x->'note'));
END $fn$ LANGUAGE plpgsql;

ALTER TABLE orders
  ADD COLUMN departure_id             uuid REFERENCES departure(id) ON DELETE RESTRICT,
  ADD COLUMN contract_snapshot        jsonb,
  ADD COLUMN contract_snapshot_sha256 text CHECK (contract_snapshot_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ADD CONSTRAINT orders_contract_snapshot_whole CHECK ((contract_snapshot IS NULL) = (contract_snapshot_sha256 IS NULL)),
  ADD CONSTRAINT orders_contract_snapshot_valid CHECK (contract_snapshot IS NULL OR fn_order_contract_snapshot_valid(
    contract_snapshot, departure_slug, trip_starts_on, trip_ends_on, trip_departure_time, trip_return_time,
    trip_timezone, unit_price_kopecks));
CREATE INDEX orders_departure_id_taken ON orders (departure_id)
  WHERE departure_id IS NOT NULL AND status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD');

-- A new order carries its contract, and an order of a departure that lives here matches it as
-- published now, under the departure lock.
CREATE FUNCTION fn_order_contract_on_insert() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  d departure%ROWTYPE;
BEGIN
  IF NEW.contract_snapshot IS NULL THEN
    RAISE EXCEPTION 'ORDER_CONTRACT_SNAPSHOT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF NEW.departure_id IS NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || NEW.departure_slug, 0));
  SELECT * INTO d FROM departure WHERE id = NEW.departure_id;
  IF NOT FOUND OR d.published_at IS NULL THEN
    RAISE EXCEPTION 'ORDER_DEPARTURE_NOT_PUBLISHED' USING ERRCODE = '55000';
  END IF;
  IF d.slug <> NEW.departure_slug THEN
    RAISE EXCEPTION 'ORDER_DEPARTURE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  IF ROW(d.starts_on, d.ends_on, d.departure_time, d.return_time, d.timezone)
     IS DISTINCT FROM ROW(NEW.trip_starts_on, NEW.trip_ends_on, NEW.trip_departure_time, NEW.trip_return_time, NEW.trip_timezone) THEN
    RAISE EXCEPTION 'ORDER_DEPARTURE_SCHEDULE_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_contract_on_insert BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_contract_on_insert();

-- What the buyer accepted is never rewritten, and an order never moves to another departure (a
-- move is the §4 workflow, not an UPDATE). Historical NULLs are never backfilled either.
CREATE FUNCTION fn_order_contract_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.contract_snapshot IS DISTINCT FROM OLD.contract_snapshot
     OR NEW.contract_snapshot_sha256 IS DISTINCT FROM OLD.contract_snapshot_sha256
     OR NEW.departure_id IS DISTINCT FROM OLD.departure_id THEN
    RAISE EXCEPTION 'ORDER_CONTRACT_SNAPSHOT_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_contract_immutable BEFORE UPDATE OF contract_snapshot, contract_snapshot_sha256, departure_id ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_contract_immutable();

-- ---------------------------------------------------------------------------------------------
-- Date lock. The departure lock is the advisory lock reserve() already takes ('departure:<slug>'),
-- so a reservation and a schedule change never interleave: whichever commits second sees the other.
-- Orders made before departures lived here carry only the slug, and count too.

CREATE FUNCTION fn_departure_has_active_orders(p_id uuid, p_slug text) RETURNS boolean
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT EXISTS (SELECT 1 FROM orders
    WHERE (departure_id = p_id OR (departure_id IS NULL AND departure_slug = p_slug))
      AND (status IN ('PAYMENT_PENDING', 'HELD', 'PAID', 'FULFILLED')
           OR (status = 'RESERVED' AND reserved_until > now())))
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_departure_schedule_locked() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || OLD.slug, 0));
  IF fn_departure_has_active_orders(OLD.id, OLD.slug) THEN
    RAISE EXCEPTION 'DEPARTURE_SCHEDULE_LOCKED: % has active or concluded orders', OLD.slug USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_schedule_locked
  BEFORE UPDATE OF starts_on, ends_on, departure_time, return_time, timezone ON departure
  FOR EACH ROW WHEN (ROW(NEW.starts_on, NEW.ends_on, NEW.departure_time, NEW.return_time, NEW.timezone)
                     IS DISTINCT FROM ROW(OLD.starts_on, OLD.ends_on, OLD.departure_time, OLD.return_time, OLD.timezone))
  EXECUTE FUNCTION fn_departure_schedule_locked();

-- ---------------------------------------------------------------------------------------------
-- Editorial commands. SECURITY DEFINER: admin_app holds no write privilege on these tables, so
-- this is the only way it changes them, and every trigger above still applies.

CREATE FUNCTION fn_editorial_actor(p_by text) RETURNS text SET search_path = pg_catalog, public AS $fn$
BEGIN
  -- The public service never edits offers, whatever grants say (as fn_set_sales_open).
  IF pg_has_role(session_user, 'commerce_app', 'MEMBER')
     AND NOT (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) THEN
    RAISE EXCEPTION 'EDITORIAL_SERVICE_LOGIN: % belongs to commerce_app', session_user USING ERRCODE = '42501';
  END IF;
  IF p_by IS NULL OR length(btrim(p_by)) NOT BETWEEN 1 AND 100 OR p_by ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'EDITORIAL_ACTOR_INVALID' USING ERRCODE = '22023';
  END IF;
  RETURN btrim(p_by);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_tour_document_valid(doc jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(doc, ARRAY['slug', 'title', 'contract', 'content'])
    AND coalesce(doc->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false)
    AND fn_json_text(doc->'title') AND length(doc->>'title') <= 300
    AND jsonb_typeof(doc->'contract') IN ('object', 'null')
    AND jsonb_typeof(doc->'content') = 'object'
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_departure_document_valid(doc jsonb) RETURNS boolean STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(doc, ARRAY['slug', 'startsOn', 'endsOn', 'departureTime', 'returnTime', 'timezone',
                                 'priceKopecks', 'contract', 'content'])
    AND coalesce(doc->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false)
    AND fn_json_date(doc->'startsOn') IS NOT NULL AND fn_json_date(doc->'endsOn') IS NOT NULL
    AND coalesce(doc->>'departureTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false)
    AND coalesce(doc->>'returnTime' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false)
    AND EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = doc->>'timezone')
    AND CASE jsonb_typeof(doc->'priceKopecks') WHEN 'null' THEN true
             WHEN 'number' THEN fn_json_int(doc->'priceKopecks', 1) AND (doc->>'priceKopecks')::numeric < 1000000000000
             ELSE false END
    AND jsonb_typeof(doc->'contract') IN ('object', 'null')
    AND jsonb_typeof(doc->'content') = 'object'
$fn$ LANGUAGE sql;

-- Save draft: compare-and-set on the draft revision the editor saw (0 for none). Returns the new one.
CREATE FUNCTION fn_save_tour_draft(p_tour_id uuid, p_expected_revision int, p_document jsonb, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_revision int;
BEGIN
  PERFORM 1 FROM tour WHERE id = p_tour_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOUR_UNKNOWN' USING ERRCODE = '55000'; END IF;
  SELECT revision INTO v_revision FROM tour_draft WHERE tour_id = p_tour_id;
  IF coalesce(v_revision, 0) IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT: expected %, current %', p_expected_revision, coalesce(v_revision, 0) USING ERRCODE = '55000';
  END IF;
  INSERT INTO tour_draft (tour_id, revision, document, updated_by, login_role, updated_at)
    VALUES (p_tour_id, p_expected_revision + 1, p_document, v_by, session_user, now())
    ON CONFLICT (tour_id) DO UPDATE SET revision = EXCLUDED.revision, document = EXCLUDED.document,
      updated_by = EXCLUDED.updated_by, login_role = EXCLUDED.login_role, updated_at = EXCLUDED.updated_at;
  RETURN p_expected_revision + 1;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_save_departure_draft(p_departure_id uuid, p_expected_revision int, p_document jsonb, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_revision int;
BEGIN
  PERFORM 1 FROM departure WHERE id = p_departure_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  SELECT revision INTO v_revision FROM departure_draft WHERE departure_id = p_departure_id;
  IF coalesce(v_revision, 0) IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT: expected %, current %', p_expected_revision, coalesce(v_revision, 0) USING ERRCODE = '55000';
  END IF;
  INSERT INTO departure_draft (departure_id, revision, document, updated_by, login_role, updated_at)
    VALUES (p_departure_id, p_expected_revision + 1, p_document, v_by, session_user, now())
    ON CONFLICT (departure_id) DO UPDATE SET revision = EXCLUDED.revision, document = EXCLUDED.document,
      updated_by = EXCLUDED.updated_by, login_role = EXCLUDED.login_role, updated_at = EXCLUDED.updated_at;
  RETURN p_expected_revision + 1;
END $fn$ LANGUAGE plpgsql;

-- Publish: one transaction under the row lock; the draft revision AND the published version (0 for
-- never published) must be the ones the editor saw. Returns the new published version.
CREATE FUNCTION fn_publish_tour(p_tour_id uuid, p_expected_draft_revision int, p_expected_published_version int, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_published int;
  v_draft tour_draft%ROWTYPE;
  v_version int;
BEGIN
  SELECT coalesce(published_version, 0) INTO v_published FROM tour WHERE id = p_tour_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOUR_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF v_published IS DISTINCT FROM p_expected_published_version THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_CONFLICT: expected %, current %', p_expected_published_version, v_published USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_draft FROM tour_draft WHERE tour_id = p_tour_id;
  IF NOT FOUND OR v_draft.revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  IF NOT fn_tour_document_valid(v_draft.document) THEN
    RAISE EXCEPTION 'TOUR_DOCUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  v_version := v_published + 1;
  INSERT INTO tour_revision (tour_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    VALUES (p_tour_id, v_version, v_draft.revision, v_draft.document,
            'sha256:' || encode(sha256(convert_to(v_draft.document::text, 'UTF8')), 'hex'), v_by, session_user, now());
  UPDATE tour SET slug = v_draft.document->>'slug', title = v_draft.document->>'title',
      contract_template = nullif(v_draft.document->'contract', 'null'::jsonb), content = v_draft.document->'content',
      published_version = v_version, published_at = coalesce(published_at, now())
    WHERE id = p_tour_id;
  RETURN v_version;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_publish_departure(p_departure_id uuid, p_expected_draft_revision int, p_expected_published_version int, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_published int;
  v_tour_id uuid;
  v_draft departure_draft%ROWTYPE;
  v_doc jsonb;
  v_version int;
BEGIN
  SELECT coalesce(published_version, 0), tour_id INTO v_published, v_tour_id
    FROM departure WHERE id = p_departure_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF v_published IS DISTINCT FROM p_expected_published_version THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_CONFLICT: expected %, current %', p_expected_published_version, v_published USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_draft FROM departure_draft WHERE departure_id = p_departure_id;
  IF NOT FOUND OR v_draft.revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  v_doc := v_draft.document;
  IF NOT fn_departure_document_valid(v_doc) THEN
    RAISE EXCEPTION 'DEPARTURE_DOCUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF (SELECT published_at FROM tour WHERE id = v_tour_id) IS NULL THEN
    RAISE EXCEPTION 'TOUR_NOT_PUBLISHED' USING ERRCODE = '55000';
  END IF;
  v_version := v_published + 1;
  INSERT INTO departure_revision (departure_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    VALUES (p_departure_id, v_version, v_draft.revision, v_doc,
            'sha256:' || encode(sha256(convert_to(v_doc::text, 'UTF8')), 'hex'), v_by, session_user, now());
  -- Changed dates fire the date lock; a changed slug after first publication, the identity trigger.
  UPDATE departure SET slug = v_doc->>'slug',
      starts_on = (v_doc->>'startsOn')::date, ends_on = (v_doc->>'endsOn')::date,
      departure_time = v_doc->>'departureTime', return_time = v_doc->>'returnTime', timezone = v_doc->>'timezone',
      price_kopecks = (v_doc->>'priceKopecks')::bigint, contract = nullif(v_doc->'contract', 'null'::jsonb),
      content = v_doc->'content', published_version = v_version, published_at = coalesce(published_at, now())
    WHERE id = p_departure_id;
  RETURN v_version;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Privileges.

REVOKE ALL ON tour, departure, tour_draft, departure_draft, tour_revision, departure_revision FROM PUBLIC;
GRANT SELECT ON tour, departure TO commerce_app, admin_app;
GRANT SELECT ON tour_draft, departure_draft, tour_revision, departure_revision TO admin_app;
GRANT INSERT (slug) ON tour TO admin_app;
GRANT INSERT (slug, tour_id) ON departure TO admin_app;

REVOKE ALL ON FUNCTION fn_tour_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_published_undeletable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_editorial_history_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_has_active_orders(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_schedule_locked() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_order_contract_on_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_order_contract_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_editorial_actor(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_save_tour_draft(uuid, int, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_save_departure_draft(uuid, int, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_publish_tour(uuid, int, int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_publish_departure(uuid, int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_save_tour_draft(uuid, int, jsonb, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_save_departure_draft(uuid, int, jsonb, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_publish_tour(uuid, int, int, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_publish_departure(uuid, int, int, text) TO admin_app;
