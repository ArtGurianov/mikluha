-- ADR v2.3 §2–§4 (Linear ART-358): content CRUD and the versioned publish of editable offers, on top
-- of the 0008 tables. Nothing here is imported from content/: a new database has no content at all.
--
--   commands     the Admin API (admin_app) creates and edits tours, departures, reports, reviews,
--                organizers and legal drafts only through the SECURITY DEFINER functions below. Each
--                one writes an editorial_audit row; a write that bypasses them (the owner, directly)
--                is audited as DIRECT_WRITE. The audit, revisions and execution changes are append-only.
--   template     a departure copies its tour's published contract template once: when it is created,
--                or at its first publication if the tour had none then. Whole, never merged; later
--                template edits reach only departures created later.
--   graph        publish checks every relation: a departure's tour, a report's tour and departure, a
--                review's tour and a departure's organizers must be published (and consistent).
--   listing      fail-closed: only an explicit isListed = true lists a tour, report, review or
--                organizer, and the public projection (public_* views, the only thing the service
--                reads for pages) shows an item only when everything it hangs on is listed too.
--   execution    changing the contract (programme, route, accommodation, carrier, services) of a
--                departure with active or concluded orders is not an ordinary edit. Publish refuses it
--                unless OWNER classifies it: EQUIVALENT is applied and creates exactly one notice per
--                affected order; MATERIAL is recorded and NOT applied (move/cancel workflow). Neither
--                touches an order's contract_snapshot; both are recorded as order events.
--   legal        legal pages have drafts only. Publishing legal text stays a code release with the
--                legal-release admission (ART-359); fn_publish_content_item refuses it.
--
-- No clone-for-price, no offerRevision, no departure_contract_version: the price is edited and
-- published like any other field and reaches only new quotes.

-- ---------------------------------------------------------------------------------------------
-- Audit.

CREATE TABLE editorial_audit (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  entity          text NOT NULL CHECK (entity IN ('tour', 'departure', 'report', 'review', 'organizer', 'legal')),
  entity_id       uuid NOT NULL,
  action          text NOT NULL CHECK (action ~ '^[A-Z_]{1,40}$'),
  actor           text CHECK (actor IS NULL OR length(actor) BETWEEN 1 AND 100),
  login_role      text NOT NULL,
  draft_revision  int,
  version         int,
  document_sha256 text CHECK (document_sha256 IS NULL OR document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  detail          jsonb CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object')
);
CREATE INDEX editorial_audit_entity ON editorial_audit (entity, entity_id, id);
CREATE TRIGGER trg_editorial_audit_immutable BEFORE UPDATE OR DELETE ON editorial_audit
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_editorial_audit_no_truncate BEFORE TRUNCATE ON editorial_audit
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();

CREATE FUNCTION fn_editorial_audit(p_entity text, p_id uuid, p_action text, p_actor text, p_draft int, p_version int,
  p_sha text, p_detail jsonb) RETURNS void SET search_path = pg_catalog, public AS $fn$
  INSERT INTO editorial_audit (entity, entity_id, action, actor, login_role, draft_revision, version, document_sha256, detail)
    VALUES (p_entity, p_id, p_action, p_actor, session_user, p_draft, p_version, p_sha, p_detail)
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_sha256_jsonb(j jsonb) RETURNS text IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT 'sha256:' || encode(sha256(convert_to(j::text, 'UTF8')), 'hex')
$fn$ LANGUAGE sql;

-- The commands below mark their own transaction while they write; anything else that writes a
-- content table (the owner with a direct statement) leaves a DIRECT_WRITE row behind.
CREATE FUNCTION fn_editorial_command(p_on boolean) RETURNS void SET search_path = pg_catalog, public AS $fn$
  SELECT set_config('mikluha.editorial_command', CASE WHEN p_on THEN 'on' ELSE 'off' END, true) IS NOT NULL
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_editorial_direct_write() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  r record;
BEGIN
  IF coalesce(current_setting('mikluha.editorial_command', true), '') = 'on' THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := OLD; ELSE r := NEW; END IF;
  PERFORM fn_editorial_audit(coalesce(to_jsonb(r)->>'kind', TG_TABLE_NAME), r.id,
    'DIRECT_WRITE', NULL, NULL, NULL, NULL, jsonb_build_object('op', TG_OP));
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tour_direct_write AFTER INSERT OR UPDATE OR DELETE ON tour
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_direct_write();
CREATE TRIGGER trg_departure_direct_write AFTER INSERT OR UPDATE OR DELETE ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_direct_write();

-- ---------------------------------------------------------------------------------------------
-- Contract completeness. The stored departure contract is {tour, departure}: the tour part is the
-- product (catalog.ts TourContract), the departure part its facts without the schedule, which lives
-- in columns (0008). The same rules as the order snapshot (fn_order_contract_snapshot_valid).

CREATE FUNCTION fn_tour_contract_complete(t jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NOT fn_json_keys(t, ARRAY['destination', 'route', 'program', 'included', 'excluded', 'insurance', 'risks'])
     OR NOT fn_json_text(t->'destination') OR NOT fn_json_text(t->'route') OR NOT fn_json_text(t->'risks')
     OR NOT fn_json_texts(t->'included', true) OR NOT fn_json_texts(t->'excluded', false)
     OR NOT fn_json_text_or_null(t->'insurance')
     OR coalesce(jsonb_typeof(t->'program'), '') <> 'array' THEN RETURN false; END IF;
  RETURN jsonb_array_length(t->'program') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t->'program') p
                     WHERE NOT fn_json_keys(p, ARRAY['title', 'items']) OR NOT fn_json_text(p->'title')
                        OR NOT fn_json_texts(p->'items', true));
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_departure_facts_complete(d jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
DECLARE
  a jsonb;
  k jsonb;
BEGIN
  IF NOT fn_json_keys(d, ARRAY['departurePoint', 'returnPoint', 'accommodation', 'carrier', 'services'])
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

CREATE FUNCTION fn_departure_contract_complete(c jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN fn_json_keys(c, ARRAY['tour', 'departure'])
    THEN fn_tour_contract_complete(c->'tour') AND fn_departure_facts_complete(c->'departure') ELSE false END
$fn$ LANGUAGE sql;

-- A stored contract may be incomplete (the page exists, nothing is sold), but it is never a shape
-- the snapshot writer could misread: exactly {tour, departure}, each an object or null.
CREATE FUNCTION fn_departure_contract_shape(c jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN fn_json_keys(c, ARRAY['tour', 'departure'])
    THEN jsonb_typeof(c->'tour') IN ('object', 'null') AND jsonb_typeof(c->'departure') IN ('object', 'null')
    ELSE false END
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- Tours and departures: listing, template resolution, sellable contract.

ALTER TABLE tour ADD COLUMN is_listed boolean NOT NULL DEFAULT false;

ALTER TABLE departure
  ADD COLUMN template_tour_version int,
  ADD COLUMN template_sha256 text CHECK (template_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN contract_complete boolean GENERATED ALWAYS AS (coalesce(fn_departure_contract_complete(contract), false)) STORED,
  ADD CONSTRAINT departure_template_whole CHECK ((template_tour_version IS NULL) = (template_sha256 IS NULL)),
  ADD CONSTRAINT departure_template_revision
    FOREIGN KEY (tour_id, template_tour_version) REFERENCES tour_revision (tour_id, version);

-- The template is resolved once and never again.
CREATE FUNCTION fn_departure_template_once() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF OLD.template_tour_version IS NOT NULL OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'DEPARTURE_TEMPLATE_RESOLVED_ONCE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_template_once BEFORE UPDATE OF template_tour_version, template_sha256 ON departure
  FOR EACH ROW WHEN (ROW(NEW.template_tour_version, NEW.template_sha256) IS DISTINCT FROM ROW(OLD.template_tour_version, OLD.template_sha256))
  EXECUTE FUNCTION fn_departure_template_once();

-- A tour document may now say whether the tour is listed; without the key it is not.
CREATE OR REPLACE FUNCTION fn_tour_document_valid(doc jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT (fn_json_keys(doc, ARRAY['slug', 'title', 'contract', 'content'])
          OR (fn_json_keys(doc, ARRAY['slug', 'title', 'isListed', 'contract', 'content'])
              AND jsonb_typeof(doc->'isListed') = 'boolean'))
    AND coalesce(doc->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false)
    AND fn_json_text(doc->'title') AND length(doc->>'title') <= 300
    AND CASE jsonb_typeof(doc->'contract') WHEN 'null' THEN true
             WHEN 'object' THEN fn_tour_contract_complete(doc->'contract') ELSE false END
    AND jsonb_typeof(doc->'content') = 'object'
$fn$ LANGUAGE sql;

-- A departure document may now name its organizers (slugs, in order, no repeats) and must carry a
-- well-shaped contract.
CREATE OR REPLACE FUNCTION fn_departure_document_valid(doc jsonb) RETURNS boolean STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(doc - 'organizers', ARRAY['slug', 'startsOn', 'endsOn', 'departureTime', 'returnTime', 'timezone',
                                                'priceKopecks', 'contract', 'content'])
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

-- ---------------------------------------------------------------------------------------------
-- Reports, reviews, organizers and legal drafts: one shape, one history, per kind validation.

CREATE TABLE content_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind IN ('report', 'review', 'organizer', 'legal')),
  slug              text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,99}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  published_version int CHECK (published_version >= 1),
  -- The published projection.
  document          jsonb CHECK (document IS NULL OR jsonb_typeof(document) = 'object'),
  is_listed         boolean NOT NULL DEFAULT false,
  tour_id           uuid REFERENCES tour(id) ON DELETE RESTRICT,
  departure_id      uuid REFERENCES departure(id) ON DELETE RESTRICT,
  UNIQUE (kind, slug),
  CHECK ((published_at IS NULL) = (published_version IS NULL)),
  CHECK ((published_at IS NULL) = (document IS NULL)),
  CHECK (published_at IS NOT NULL OR (NOT is_listed AND tour_id IS NULL AND departure_id IS NULL)),
  CHECK (kind = 'report' OR departure_id IS NULL),
  CHECK (kind IN ('report', 'review') OR tour_id IS NULL),
  CHECK (kind <> 'report' OR published_at IS NULL OR tour_id IS NOT NULL),
  CHECK (kind <> 'legal' OR published_at IS NULL)
);
CREATE INDEX content_item_tour ON content_item (tour_id) WHERE tour_id IS NOT NULL;
CREATE INDEX content_item_departure ON content_item (departure_id) WHERE departure_id IS NOT NULL;

CREATE TABLE content_item_draft (
  item_id    uuid PRIMARY KEY REFERENCES content_item(id) ON DELETE RESTRICT,
  revision   int NOT NULL CHECK (revision >= 1),
  document   jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object' AND length(document::text) <= 262144),
  updated_by text NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 100),
  login_role text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE content_item_revision (
  item_id         uuid NOT NULL REFERENCES content_item(id) ON DELETE RESTRICT,
  version         int NOT NULL CHECK (version >= 1),
  draft_revision  int NOT NULL CHECK (draft_revision >= 1),
  document        jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  document_sha256 text NOT NULL CHECK (document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  published_by    text NOT NULL CHECK (length(published_by) BETWEEN 1 AND 100),
  login_role      text NOT NULL,
  published_at    timestamptz NOT NULL,
  PRIMARY KEY (item_id, version)
);
ALTER TABLE content_item ADD CONSTRAINT content_item_published_revision
  FOREIGN KEY (id, published_version) REFERENCES content_item_revision (item_id, version);

-- A departure's organizers as published: replaced as a whole by each departure publish.
CREATE TABLE departure_organizer (
  departure_id uuid NOT NULL REFERENCES departure(id) ON DELETE RESTRICT,
  organizer_id uuid NOT NULL REFERENCES content_item(id) ON DELETE RESTRICT,
  position     int NOT NULL CHECK (position >= 1),
  PRIMARY KEY (departure_id, organizer_id),
  UNIQUE (departure_id, position)
);

CREATE FUNCTION fn_content_item_identity_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.published_at IS NOT NULL AND (NEW.slug IS DISTINCT FROM OLD.slug
         OR NEW.published_at IS DISTINCT FROM OLD.published_at))
     OR (OLD.published_version IS NOT NULL AND (NEW.published_version IS NULL OR NEW.published_version < OLD.published_version)) THEN
    RAISE EXCEPTION 'CONTENT_IDENTITY_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_content_item_identity_immutable BEFORE UPDATE ON content_item
  FOR EACH ROW EXECUTE FUNCTION fn_content_item_identity_immutable();
CREATE TRIGGER trg_content_item_published_undeletable BEFORE DELETE ON content_item
  FOR EACH ROW WHEN (OLD.published_at IS NOT NULL) EXECUTE FUNCTION fn_published_undeletable();
CREATE TRIGGER trg_content_item_revision_immutable BEFORE UPDATE OR DELETE ON content_item_revision
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_content_item_no_truncate BEFORE TRUNCATE ON content_item
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_content_item_revision_no_truncate BEFORE TRUNCATE ON content_item_revision
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_content_item_direct_write AFTER INSERT OR UPDATE OR DELETE ON content_item
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_direct_write();

-- What each kind publishes: exactly these keys. Media, description, gallery, SEO and sort order
-- live in `content`; relations are slugs, resolved and checked at publish.
CREATE FUNCTION fn_content_document_valid(p_kind text, doc jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR NOT coalesce(doc->>'slug' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false)
     OR jsonb_typeof(doc->'content') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  CASE p_kind
    WHEN 'report' THEN
      RETURN fn_json_keys(doc, ARRAY['slug', 'title', 'tour', 'departure', 'date', 'isListed', 'noindex', 'content'])
        AND fn_json_text(doc->'title') AND length(doc->>'title') <= 300
        AND coalesce(doc->>'tour' ~ '^[a-z0-9][a-z0-9-]{0,99}$', false) AND jsonb_typeof(doc->'tour') = 'string'
        AND (jsonb_typeof(doc->'departure') = 'null'
             OR (jsonb_typeof(doc->'departure') = 'string' AND (doc->>'departure') ~ '^[a-z0-9][a-z0-9-]{0,99}$'))
        AND (jsonb_typeof(doc->'date') = 'null' OR fn_json_date(doc->'date') IS NOT NULL)
        AND jsonb_typeof(doc->'isListed') = 'boolean' AND jsonb_typeof(doc->'noindex') = 'boolean';
    WHEN 'review' THEN
      RETURN fn_json_keys(doc, ARRAY['slug', 'authorName', 'tour', 'isListed', 'isDemo', 'content'])
        AND fn_json_text(doc->'authorName') AND length(doc->>'authorName') <= 100
        AND (jsonb_typeof(doc->'tour') = 'null'
             OR (jsonb_typeof(doc->'tour') = 'string' AND (doc->>'tour') ~ '^[a-z0-9][a-z0-9-]{0,99}$'))
        AND jsonb_typeof(doc->'isListed') = 'boolean' AND jsonb_typeof(doc->'isDemo') = 'boolean';
    WHEN 'organizer' THEN
      RETURN fn_json_keys(doc, ARRAY['slug', 'name', 'isListed', 'isDemo', 'content'])
        AND fn_json_text(doc->'name') AND length(doc->>'name') <= 200
        AND jsonb_typeof(doc->'isListed') = 'boolean' AND jsonb_typeof(doc->'isDemo') = 'boolean';
    ELSE
      RETURN false;
  END CASE;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Execution changes (ADR v2.3 §4) and their per-order notices.

CREATE TABLE departure_execution_change (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  departure_id         uuid NOT NULL REFERENCES departure(id) ON DELETE RESTRICT,
  classification       text NOT NULL CHECK (classification IN ('EQUIVALENT', 'MATERIAL')),
  outcome              text NOT NULL CHECK (outcome IN ('APPLIED', 'ROUTED_TO_MOVE_CANCEL')),
  from_version         int NOT NULL CHECK (from_version >= 1),
  to_version           int,
  draft_revision       int NOT NULL CHECK (draft_revision >= 1),
  from_contract_sha256 text CHECK (from_contract_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  to_contract_sha256   text CHECK (to_contract_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  notice               text NOT NULL CHECK (length(btrim(notice)) BETWEEN 1 AND 4000),
  affected_order_refs  text[] NOT NULL CHECK (cardinality(affected_order_refs) >= 1),
  classified_by        text NOT NULL CHECK (length(classified_by) BETWEEN 1 AND 100),
  login_role           text NOT NULL,
  created_at           timestamptz NOT NULL,
  CHECK ((classification = 'EQUIVALENT') = (outcome = 'APPLIED')),
  CHECK ((outcome = 'APPLIED') = (to_version IS NOT NULL))
);
CREATE INDEX departure_execution_change_departure ON departure_execution_change (departure_id, created_at);
CREATE TRIGGER trg_execution_change_immutable BEFORE UPDATE OR DELETE ON departure_execution_change
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_execution_change_no_truncate BEFORE TRUNCATE ON departure_execution_change
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();

-- One row per change and order. No personal data: the recipient is read from order_contact when
-- the mail is sent. ACCEPTED means Notisend accepted it; only a provider delivery report makes it
-- DELIVERED. Notisend has no idempotency key, so a send is repeated only when it provably was not
-- queued (as email_outbox, 0005).
CREATE TABLE execution_change_notice (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_id        uuid NOT NULL REFERENCES departure_execution_change(id),
  order_id         uuid NOT NULL REFERENCES orders(id),
  idempotency_key  text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 100),
  state            text NOT NULL CHECK (state IN ('PENDING', 'SENDING', 'ACCEPTED', 'DELIVERED', 'ATTENTION')),
  provider_job_id  text,
  provider_status  text CHECK (provider_status IS NULL OR provider_status ~ '^[a-z_]{1,40}$'),
  attempts         int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_attempt_at timestamptz,
  next_attempt_at  timestamptz NOT NULL,
  lease_until      timestamptz,
  last_error_code  text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,60}$'),
  created_at       timestamptz NOT NULL,
  accepted_at      timestamptz,
  delivered_at     timestamptz,
  UNIQUE (change_id, order_id),
  CHECK ((attempts = 0) = (first_attempt_at IS NULL)),
  CHECK (state NOT IN ('ACCEPTED', 'DELIVERED') OR (provider_job_id IS NOT NULL AND accepted_at IS NOT NULL)),
  CHECK ((state = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK (state <> 'SENDING' OR lease_until IS NOT NULL)
);
CREATE INDEX execution_change_notice_due ON execution_change_notice (next_attempt_at)
  WHERE state IN ('PENDING', 'SENDING');

-- A notice never goes back: an accepted or possibly-queued mail is never sent twice.
CREATE FUNCTION fn_execution_notice_transition() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.change_id IS DISTINCT FROM OLD.change_id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.attempts < OLD.attempts
     OR (OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id)
     OR (OLD.state IS DISTINCT FROM NEW.state AND NOT (
          (OLD.state = 'PENDING' AND NEW.state IN ('SENDING', 'ATTENTION'))
       OR (OLD.state = 'SENDING' AND NEW.state IN ('PENDING', 'ACCEPTED', 'ATTENTION'))
       OR (OLD.state = 'ACCEPTED' AND NEW.state IN ('DELIVERED', 'ATTENTION')))) THEN
    RAISE EXCEPTION 'EXECUTION_NOTICE_TRANSITION: % -> %', OLD.state, NEW.state USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_execution_notice_transition BEFORE UPDATE ON execution_change_notice
  FOR EACH ROW EXECUTE FUNCTION fn_execution_notice_transition();
-- A row is never deleted; like orders and email_outbox, the table is not TRUNCATE-guarded.
CREATE TRIGGER trg_execution_notice_undeletable BEFORE DELETE ON execution_change_notice
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();

-- The orders a contract change reaches: active or concluded, as the date lock counts them (0008).
CREATE FUNCTION fn_departure_affected_orders(p_departure_id uuid)
RETURNS TABLE (order_id uuid, order_ref text, status text)
STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT o.id, o.order_ref, o.status FROM orders o JOIN departure d ON d.id = p_departure_id
   WHERE (o.departure_id = d.id OR (o.departure_id IS NULL AND o.departure_slug = d.slug))
     AND (o.status IN ('PAYMENT_PENDING', 'HELD', 'PAID', 'FULFILLED')
          OR (o.status = 'RESERVED' AND o.reserved_until > now()))
   ORDER BY o.created_at, o.order_ref
$fn$ LANGUAGE sql;

-- ---------------------------------------------------------------------------------------------
-- Commands: creation.

CREATE FUNCTION fn_create_tour(p_slug text, p_by text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_id uuid;
BEGIN
  PERFORM fn_editorial_command(true);
  INSERT INTO tour (slug) VALUES (p_slug) RETURNING id INTO v_id;
  PERFORM fn_editorial_audit('tour', v_id, 'CREATE', v_by, NULL, NULL, NULL, jsonb_build_object('slug', p_slug));
  PERFORM fn_editorial_command(false);
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

-- A new departure starts CLOSED and unlisted (0008 defaults) with draft revision 1 holding its tour's
-- published template, copied whole. Without a template the copy happens at the first publication.
CREATE FUNCTION fn_create_departure(p_tour_id uuid, p_slug text, p_by text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  t tour%ROWTYPE;
  v_id uuid;
  v_doc jsonb;
BEGIN
  SELECT * INTO t FROM tour WHERE id = p_tour_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TOUR_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF t.published_at IS NULL THEN RAISE EXCEPTION 'TOUR_NOT_PUBLISHED' USING ERRCODE = '55000'; END IF;
  PERFORM fn_editorial_command(true);
  INSERT INTO departure (slug, tour_id) VALUES (p_slug, p_tour_id) RETURNING id INTO v_id;
  v_doc := jsonb_build_object('slug', p_slug, 'startsOn', NULL, 'endsOn', NULL, 'departureTime', NULL, 'returnTime', NULL,
    'timezone', NULL, 'priceKopecks', NULL,
    'contract', CASE WHEN t.contract_template IS NULL THEN 'null'::jsonb
                     ELSE jsonb_build_object('tour', t.contract_template, 'departure', NULL) END,
    'content', '{}'::jsonb);
  IF t.contract_template IS NOT NULL THEN
    UPDATE departure SET template_tour_version = t.published_version, template_sha256 = fn_sha256_jsonb(t.contract_template)
      WHERE id = v_id;
  END IF;
  INSERT INTO departure_draft (departure_id, revision, document, updated_by, login_role, updated_at)
    VALUES (v_id, 1, v_doc, v_by, session_user, now());
  PERFORM fn_editorial_audit('departure', v_id, 'CREATE', v_by, 1, NULL, fn_sha256_jsonb(v_doc),
    jsonb_build_object('slug', p_slug, 'tourId', p_tour_id,
      'templateTourVersion', CASE WHEN t.contract_template IS NULL THEN NULL ELSE t.published_version END));
  PERFORM fn_editorial_command(false);
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_create_content_item(p_kind text, p_slug text, p_by text) RETURNS uuid
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_id uuid;
BEGIN
  PERFORM fn_editorial_command(true);
  INSERT INTO content_item (kind, slug) VALUES (p_kind, p_slug) RETURNING id INTO v_id;
  PERFORM fn_editorial_audit(p_kind, v_id, 'CREATE', v_by, NULL, NULL, NULL, jsonb_build_object('slug', p_slug));
  PERFORM fn_editorial_command(false);
  RETURN v_id;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Commands: drafts. The 0008 functions, now audited.

CREATE OR REPLACE FUNCTION fn_save_tour_draft(p_tour_id uuid, p_expected_revision int, p_document jsonb, p_by text)
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
  PERFORM fn_editorial_audit('tour', p_tour_id, 'SAVE_DRAFT', v_by, p_expected_revision + 1, NULL, fn_sha256_jsonb(p_document), NULL);
  RETURN p_expected_revision + 1;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_save_departure_draft(p_departure_id uuid, p_expected_revision int, p_document jsonb, p_by text)
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
  PERFORM fn_editorial_audit('departure', p_departure_id, 'SAVE_DRAFT', v_by, p_expected_revision + 1, NULL, fn_sha256_jsonb(p_document), NULL);
  RETURN p_expected_revision + 1;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_save_content_draft(p_item_id uuid, p_expected_revision int, p_document jsonb, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_kind text;
  v_revision int;
BEGIN
  SELECT kind INTO v_kind FROM content_item WHERE id = p_item_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  SELECT revision INTO v_revision FROM content_item_draft WHERE item_id = p_item_id;
  IF coalesce(v_revision, 0) IS DISTINCT FROM p_expected_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT: expected %, current %', p_expected_revision, coalesce(v_revision, 0) USING ERRCODE = '55000';
  END IF;
  INSERT INTO content_item_draft (item_id, revision, document, updated_by, login_role, updated_at)
    VALUES (p_item_id, p_expected_revision + 1, p_document, v_by, session_user, now())
    ON CONFLICT (item_id) DO UPDATE SET revision = EXCLUDED.revision, document = EXCLUDED.document,
      updated_by = EXCLUDED.updated_by, login_role = EXCLUDED.login_role, updated_at = EXCLUDED.updated_at;
  PERFORM fn_editorial_audit(v_kind, p_item_id, 'SAVE_DRAFT', v_by, p_expected_revision + 1, NULL, fn_sha256_jsonb(p_document), NULL);
  RETURN p_expected_revision + 1;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- Commands: publish.

CREATE OR REPLACE FUNCTION fn_publish_tour(p_tour_id uuid, p_expected_draft_revision int, p_expected_published_version int, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  v_published int;
  v_draft tour_draft%ROWTYPE;
  v_version int;
  v_sha text;
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
  PERFORM fn_editorial_command(true);
  v_version := v_published + 1;
  v_sha := fn_sha256_jsonb(v_draft.document);
  INSERT INTO tour_revision (tour_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    VALUES (p_tour_id, v_version, v_draft.revision, v_draft.document, v_sha, v_by, session_user, now());
  UPDATE tour SET slug = v_draft.document->>'slug', title = v_draft.document->>'title',
      contract_template = nullif(v_draft.document->'contract', 'null'::jsonb), content = v_draft.document->'content',
      is_listed = coalesce(v_draft.document->'isListed' = 'true'::jsonb, false),
      published_version = v_version, published_at = coalesce(published_at, now())
    WHERE id = p_tour_id;
  PERFORM fn_editorial_audit('tour', p_tour_id, 'PUBLISH', v_by, v_draft.revision, v_version, v_sha, NULL);
  PERFORM fn_editorial_command(false);
  RETURN v_version;
END $fn$ LANGUAGE plpgsql;

-- The departure publish. p_classification is NULL for an ordinary edit; it must be EQUIVALENT or
-- MATERIAL exactly when the contract changes and the departure has affected orders. Returns
-- {outcome: PUBLISHED | APPLIED | ROUTED_TO_MOVE_CANCEL, version, changeId, affectedOrders}.
CREATE FUNCTION fn_publish_departure_change(p_departure_id uuid, p_expected_draft_revision int,
  p_expected_published_version int, p_classification text, p_notice text, p_by text)
RETURNS jsonb SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  d departure%ROWTYPE;
  t tour%ROWTYPE;
  v_published int;
  v_draft departure_draft%ROWTYPE;
  v_doc jsonb;
  v_contract jsonb;
  v_draft_revision int;
  v_resolved boolean := false;
  v_orders uuid[];
  v_refs text[];
  v_change uuid;
  v_version int;
  v_sha text;
  v_organizers uuid[];
  v_missing text;
BEGIN
  SELECT * INTO d FROM departure WHERE id = p_departure_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  v_published := coalesce(d.published_version, 0);
  IF v_published IS DISTINCT FROM p_expected_published_version THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_CONFLICT: expected %, current %', p_expected_published_version, v_published USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_draft FROM departure_draft WHERE departure_id = p_departure_id;
  IF NOT FOUND OR v_draft.revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  v_doc := v_draft.document;
  v_draft_revision := v_draft.revision;
  IF NOT fn_departure_document_valid(v_doc) THEN
    RAISE EXCEPTION 'DEPARTURE_DOCUMENT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO t FROM tour WHERE id = d.tour_id FOR SHARE;
  IF t.published_at IS NULL THEN
    RAISE EXCEPTION 'TOUR_NOT_PUBLISHED' USING ERRCODE = '55000';
  END IF;
  PERFORM fn_editorial_command(true);

  -- Template: once, whole. A first publication without the tour part takes the tour's template now;
  -- the draft is advanced to what was published, so the next save starts from it.
  v_contract := nullif(v_doc->'contract', 'null'::jsonb);
  IF d.published_at IS NULL AND d.template_tour_version IS NULL AND t.contract_template IS NOT NULL
     AND (v_contract IS NULL OR v_contract->'tour' = 'null'::jsonb) THEN
    v_contract := jsonb_build_object('tour', t.contract_template, 'departure', coalesce(v_contract->'departure', 'null'::jsonb));
    v_doc := jsonb_set(v_doc, '{contract}', v_contract);
    v_draft_revision := v_draft.revision + 1;
    v_resolved := true;
    UPDATE departure_draft SET revision = v_draft_revision, document = v_doc, updated_by = v_by,
        login_role = session_user, updated_at = now()
      WHERE departure_id = p_departure_id;
    UPDATE departure SET template_tour_version = t.published_version, template_sha256 = fn_sha256_jsonb(t.contract_template)
      WHERE id = p_departure_id;
  END IF;

  -- Graph: every organizer named is a published organizer.
  IF v_doc ? 'organizers' THEN
    SELECT string_agg(o.slug, ', ') INTO v_missing FROM jsonb_array_elements_text(v_doc->'organizers') AS o(slug)
     WHERE NOT EXISTS (SELECT 1 FROM content_item c WHERE c.kind = 'organizer' AND c.slug = o.slug AND c.published_at IS NOT NULL);
    IF v_missing IS NOT NULL THEN
      RAISE EXCEPTION 'RELATION_NOT_PUBLISHED: organizer %', v_missing USING ERRCODE = '55000';
    END IF;
    SELECT array_agg(c.id ORDER BY o.n) INTO v_organizers
      FROM jsonb_array_elements_text(v_doc->'organizers') WITH ORDINALITY AS o(slug, n)
      JOIN content_item c ON c.kind = 'organizer' AND c.slug = o.slug;
  END IF;

  -- An open sale is never left without a complete offer.
  IF d.booking_status = 'OPEN' AND (v_doc->'priceKopecks' = 'null'::jsonb OR NOT coalesce(fn_departure_contract_complete(v_contract), false)) THEN
    RAISE EXCEPTION 'DEPARTURE_OPEN_REQUIRES_COMPLETE_OFFER' USING ERRCODE = '55000';
  END IF;

  -- Execution change: the contract differs from the published one and buyers hold it. Under the
  -- departure lock, as reserve(), so no reservation slips in between the count and the publish.
  IF d.published_at IS NOT NULL AND v_contract IS DISTINCT FROM d.contract THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
    SELECT array_agg(a.order_id), array_agg(a.order_ref) INTO v_orders, v_refs FROM fn_departure_affected_orders(p_departure_id) a;
  END IF;
  IF v_orders IS NULL THEN
    IF p_classification IS NOT NULL THEN
      RAISE EXCEPTION 'EXECUTION_CHANGE_NOT_REQUIRED' USING ERRCODE = '55000';
    END IF;
  ELSE
    IF p_classification IS NULL THEN
      RAISE EXCEPTION 'EXECUTION_CHANGE_CLASSIFICATION_REQUIRED: % affected orders', cardinality(v_orders) USING ERRCODE = '55000';
    END IF;
    IF p_classification NOT IN ('EQUIVALENT', 'MATERIAL') THEN
      RAISE EXCEPTION 'EXECUTION_CHANGE_CLASSIFICATION_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_notice IS NULL OR length(btrim(p_notice)) NOT BETWEEN 1 AND 4000 OR p_notice ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
      RAISE EXCEPTION 'EXECUTION_CHANGE_NOTICE_INVALID' USING ERRCODE = '22023';
    END IF;
    IF p_classification = 'MATERIAL' THEN
      -- Not an edit: recorded for the move/cancel workflow, and nothing is published. (No template
      -- was resolved above: a departure with orders has been published before.)
      INSERT INTO departure_execution_change (departure_id, classification, outcome, from_version, to_version, draft_revision,
          from_contract_sha256, to_contract_sha256, notice, affected_order_refs, classified_by, login_role, created_at)
        VALUES (p_departure_id, 'MATERIAL', 'ROUTED_TO_MOVE_CANCEL', v_published, NULL, v_draft_revision,
          fn_sha256_jsonb(d.contract), fn_sha256_jsonb(v_contract), btrim(p_notice), v_refs, v_by, session_user, now())
        RETURNING id INTO v_change;
      INSERT INTO order_event (order_id, event, detail) SELECT o, 'EXECUTION_CHANGE_MATERIAL', v_change::text FROM unnest(v_orders) o;
      PERFORM fn_editorial_audit('departure', p_departure_id, 'EXECUTION_CHANGE_MATERIAL', v_by, v_draft_revision, v_published,
        fn_sha256_jsonb(v_doc), jsonb_build_object('changeId', v_change, 'affectedOrders', cardinality(v_orders)));
      PERFORM fn_editorial_command(false);
      RETURN jsonb_build_object('outcome', 'ROUTED_TO_MOVE_CANCEL', 'version', v_published, 'changeId', v_change,
        'affectedOrders', cardinality(v_orders));
    END IF;
  END IF;

  v_version := v_published + 1;
  v_sha := fn_sha256_jsonb(v_doc);
  INSERT INTO departure_revision (departure_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    VALUES (p_departure_id, v_version, v_draft_revision, v_doc, v_sha, v_by, session_user, now());
  -- Changed dates fire the date lock; a changed slug after first publication, the identity trigger.
  UPDATE departure SET slug = v_doc->>'slug',
      starts_on = (v_doc->>'startsOn')::date, ends_on = (v_doc->>'endsOn')::date,
      departure_time = v_doc->>'departureTime', return_time = v_doc->>'returnTime', timezone = v_doc->>'timezone',
      price_kopecks = (v_doc->>'priceKopecks')::bigint, contract = v_contract,
      content = v_doc->'content', published_version = v_version, published_at = coalesce(published_at, now())
    WHERE id = p_departure_id;
  DELETE FROM departure_organizer WHERE departure_id = p_departure_id;
  INSERT INTO departure_organizer (departure_id, organizer_id, position)
    SELECT p_departure_id, o, n FROM unnest(v_organizers) WITH ORDINALITY AS u(o, n);

  IF v_orders IS NOT NULL THEN
    INSERT INTO departure_execution_change (departure_id, classification, outcome, from_version, to_version, draft_revision,
        from_contract_sha256, to_contract_sha256, notice, affected_order_refs, classified_by, login_role, created_at)
      VALUES (p_departure_id, 'EQUIVALENT', 'APPLIED', v_published, v_version, v_draft_revision,
        fn_sha256_jsonb(d.contract), fn_sha256_jsonb(v_contract), btrim(p_notice), v_refs, v_by, session_user, now())
      RETURNING id INTO v_change;
    INSERT INTO execution_change_notice (change_id, order_id, idempotency_key, state, next_attempt_at, created_at)
      SELECT v_change, o.id, 'mk-change:' || v_change || ':' || o.order_ref, 'PENDING', now(), now()
        FROM orders o WHERE o.id = ANY (v_orders);
    INSERT INTO order_event (order_id, event, detail) SELECT o, 'EXECUTION_CHANGE_EQUIVALENT', v_change::text FROM unnest(v_orders) o;
  END IF;
  PERFORM fn_editorial_audit('departure', p_departure_id,
    CASE WHEN v_change IS NULL THEN 'PUBLISH' ELSE 'EXECUTION_CHANGE_EQUIVALENT' END, v_by, v_draft_revision, v_version, v_sha,
    jsonb_build_object('fromVersion', v_published,
      'priceChanged', (v_doc->'priceKopecks') IS DISTINCT FROM to_jsonb(d.price_kopecks),
      'contractChanged', v_contract IS DISTINCT FROM d.contract, 'templateResolved', v_resolved,
      'changeId', v_change, 'affectedOrders', coalesce(cardinality(v_orders), 0)));
  PERFORM fn_editorial_command(false);
  RETURN jsonb_build_object('outcome', CASE WHEN v_change IS NULL THEN 'PUBLISHED' ELSE 'APPLIED' END, 'version', v_version,
    'changeId', v_change, 'affectedOrders', coalesce(cardinality(v_orders), 0));
END $fn$ LANGUAGE plpgsql;

-- The 0008 signature stays for an ordinary edit: a contract change on a sold departure is refused
-- with EXECUTION_CHANGE_CLASSIFICATION_REQUIRED.
CREATE OR REPLACE FUNCTION fn_publish_departure(p_departure_id uuid, p_expected_draft_revision int, p_expected_published_version int, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT (fn_publish_departure_change(p_departure_id, p_expected_draft_revision, p_expected_published_version, NULL, NULL, p_by)->>'version')::int
$fn$ LANGUAGE sql;

CREATE FUNCTION fn_publish_content_item(p_item_id uuid, p_expected_draft_revision int, p_expected_published_version int, p_by text)
RETURNS int SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE
  v_by text := fn_editorial_actor(p_by);
  c content_item%ROWTYPE;
  v_published int;
  v_draft content_item_draft%ROWTYPE;
  v_doc jsonb;
  v_tour tour%ROWTYPE;
  v_departure departure%ROWTYPE;
  v_version int;
  v_sha text;
BEGIN
  SELECT * INTO c FROM content_item WHERE id = p_item_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  IF c.kind = 'legal' THEN
    RAISE EXCEPTION 'LEGAL_PUBLICATION_NOT_ADMITTED: legal text is published by a code release (ART-359)' USING ERRCODE = '55000';
  END IF;
  v_published := coalesce(c.published_version, 0);
  IF v_published IS DISTINCT FROM p_expected_published_version THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_CONFLICT: expected %, current %', p_expected_published_version, v_published USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_draft FROM content_item_draft WHERE item_id = p_item_id;
  IF NOT FOUND OR v_draft.revision IS DISTINCT FROM p_expected_draft_revision THEN
    RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT' USING ERRCODE = '55000';
  END IF;
  v_doc := v_draft.document;
  IF NOT fn_content_document_valid(c.kind, v_doc) THEN
    RAISE EXCEPTION 'CONTENT_DOCUMENT_INVALID: %', c.kind USING ERRCODE = '22023';
  END IF;
  -- Graph: a report hangs on a published tour and optionally on a published departure of that tour;
  -- a review optionally on a published tour.
  IF jsonb_typeof(v_doc->'tour') = 'string' THEN
    SELECT * INTO v_tour FROM tour WHERE slug = v_doc->>'tour' FOR SHARE;
    IF NOT FOUND OR v_tour.published_at IS NULL THEN
      RAISE EXCEPTION 'RELATION_NOT_PUBLISHED: tour %', v_doc->>'tour' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF jsonb_typeof(v_doc->'departure') = 'string' THEN
    SELECT * INTO v_departure FROM departure WHERE slug = v_doc->>'departure' FOR SHARE;
    IF NOT FOUND OR v_departure.published_at IS NULL THEN
      RAISE EXCEPTION 'RELATION_NOT_PUBLISHED: departure %', v_doc->>'departure' USING ERRCODE = '55000';
    END IF;
    IF v_departure.tour_id IS DISTINCT FROM v_tour.id THEN
      RAISE EXCEPTION 'RELATION_MISMATCH: departure % is not of tour %', v_doc->>'departure', v_doc->>'tour' USING ERRCODE = '55000';
    END IF;
  END IF;
  PERFORM fn_editorial_command(true);
  v_version := v_published + 1;
  v_sha := fn_sha256_jsonb(v_doc);
  INSERT INTO content_item_revision (item_id, version, draft_revision, document, document_sha256, published_by, login_role, published_at)
    VALUES (p_item_id, v_version, v_draft.revision, v_doc, v_sha, v_by, session_user, now());
  UPDATE content_item SET slug = v_doc->>'slug', document = v_doc,
      is_listed = coalesce(v_doc->'isListed' = 'true'::jsonb, false),
      tour_id = v_tour.id, departure_id = v_departure.id,
      published_version = v_version, published_at = coalesce(published_at, now())
    WHERE id = p_item_id;
  PERFORM fn_editorial_audit(c.kind, p_item_id, 'PUBLISH', v_by, v_draft.revision, v_version, v_sha, NULL);
  PERFORM fn_editorial_command(false);
  RETURN v_version;
END $fn$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------------------------
-- The public projection: what SSR pages may show. Published and explicitly listed, and so is
-- everything the item hangs on. Drafts, unlisted items and their history never appear here.

CREATE VIEW public_tour WITH (security_barrier) AS
  SELECT t.slug, t.title, t.content, t.published_version
    FROM tour t WHERE t.published_at IS NOT NULL AND t.is_listed;

CREATE VIEW public_departure WITH (security_barrier) AS
  SELECT d.slug, t.slug AS tour_slug, t.title AS tour_title, d.starts_on, d.ends_on, d.departure_time, d.return_time,
         d.timezone, d.price_kopecks, d.capacity, d.contract, d.contract_complete, d.content, d.booking_status, d.is_demo,
         d.published_version
    FROM departure d JOIN tour t ON t.id = d.tour_id
   WHERE d.published_at IS NOT NULL AND d.is_listed AND t.published_at IS NOT NULL AND t.is_listed;

CREATE VIEW public_organizer WITH (security_barrier) AS
  SELECT c.slug, c.document->>'name' AS name, (c.document->'isDemo')::boolean AS is_demo, c.document->'content' AS content,
         c.published_version
    FROM content_item c WHERE c.kind = 'organizer' AND c.published_at IS NOT NULL AND c.is_listed;

CREATE VIEW public_departure_organizer WITH (security_barrier) AS
  SELECT d.slug AS departure_slug, o.slug AS organizer_slug, x.position
    FROM departure_organizer x JOIN public_departure d ON d.slug = (SELECT slug FROM departure WHERE id = x.departure_id)
    JOIN public_organizer o ON o.slug = (SELECT slug FROM content_item WHERE id = x.organizer_id);

CREATE VIEW public_report WITH (security_barrier) AS
  SELECT c.slug, c.document->>'title' AS title, t.slug AS tour_slug, d.slug AS departure_slug,
         fn_json_date(c.document->'date') AS date, (c.document->'noindex')::boolean AS noindex,
         c.document->'content' AS content, c.published_version
    FROM content_item c JOIN tour t ON t.id = c.tour_id LEFT JOIN departure d ON d.id = c.departure_id
   WHERE c.kind = 'report' AND c.published_at IS NOT NULL AND c.is_listed
     AND t.published_at IS NOT NULL AND t.is_listed
     AND (c.departure_id IS NULL OR (d.published_at IS NOT NULL AND d.is_listed));

CREATE VIEW public_review WITH (security_barrier) AS
  SELECT c.slug, c.document->>'authorName' AS author_name, t.slug AS tour_slug, (c.document->'isDemo')::boolean AS is_demo,
         c.document->'content' AS content, c.published_version
    FROM content_item c LEFT JOIN tour t ON t.id = c.tour_id
   WHERE c.kind = 'review' AND c.published_at IS NOT NULL AND c.is_listed
     AND (c.tour_id IS NULL OR (t.published_at IS NOT NULL AND t.is_listed));

-- ---------------------------------------------------------------------------------------------
-- Privileges. admin_app now creates through the functions only (the 0008 INSERT grants go), and
-- reads what Control Room shows; commerce_app reads the public projection and delivers notices.

REVOKE INSERT ON tour, departure FROM admin_app;
REVOKE ALL ON editorial_audit, content_item, content_item_draft, content_item_revision, departure_organizer,
  departure_execution_change, execution_change_notice FROM PUBLIC;
REVOKE ALL ON public_tour, public_departure, public_organizer, public_departure_organizer, public_report, public_review FROM PUBLIC;
GRANT SELECT ON editorial_audit, content_item, content_item_draft, content_item_revision, departure_organizer,
  departure_execution_change, execution_change_notice TO admin_app;
GRANT SELECT ON public_tour, public_departure, public_organizer, public_departure_organizer, public_report, public_review
  TO commerce_app, admin_app;
GRANT SELECT ON departure_execution_change TO commerce_app;
GRANT SELECT, UPDATE (state, provider_job_id, provider_status, attempts, first_attempt_at, next_attempt_at, lease_until,
  last_error_code, accepted_at, delivered_at) ON execution_change_notice TO commerce_app;

REVOKE ALL ON FUNCTION fn_editorial_audit(text, uuid, text, text, int, int, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_editorial_command(boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_editorial_direct_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_template_once() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_content_item_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_execution_notice_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_departure_affected_orders(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_create_tour(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_create_departure(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_create_content_item(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_save_content_draft(uuid, int, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_publish_departure_change(uuid, int, int, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_publish_content_item(uuid, int, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_departure_affected_orders(uuid) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_create_tour(text, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_create_departure(uuid, text, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_create_content_item(text, text, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_save_content_draft(uuid, int, jsonb, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_publish_departure_change(uuid, int, int, text, text, text) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_publish_content_item(uuid, int, int, text) TO admin_app;
