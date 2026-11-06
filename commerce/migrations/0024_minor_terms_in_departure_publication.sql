-- Track A / A2b-8 for TOUR-28/35/65: the child price, the permission to sell minors' seats and the
-- minimum age are offer terms, written only by the departure's publication and accepted in the
-- contract snapshot v2 (docs/plans/2026-11-04-track-a-schema-roles-contract.md §9, §16;
-- OWNER decisions 3 and 6A of 06.11.2026; v1.9.1 §6, G-PRICE-PUB).
--
-- Forward-only after 0023; 0001–0023 keep their bytes. Nothing is backfilled: a departure published
-- before this migration keeps its columns until its next publication, whose document then decides
-- (no `minorTerms` = minors not allowed, no minimum age, no child price).
--
--   * the departure document gains an optional `minorTerms` {allowed, minAge, childPriceKopecks}; when
--     0–13 seats can be sold the child price is explicit (it may equal the adult price), never a fallback;
--     draft → check (fn_departure_document_valid) → publish is the only path that writes the three
--     columns: a publication copies them from the published revision, bumps minor_settings_version
--     when they change and writes an audited departure_minor_event SETTINGS; any other UPDATE of
--     them, by any login, is refused;
--   * the pause of minors' sales stays a separate operational switch (0021 §10): it never rewrites
--     the published terms;
--   * a PRICED_SLOTS order accepts `mikluha.order-contract/2`, which carries the same minor terms; at
--     insert, under the departure lock, they must equal the departure's published terms, and the
--     pricing basis then freezes the same child price. UNIFORM orders keep schema /1;
--   * the public departure projection shows the published terms and the pause (no personal data).

-- ---------------------------------------------------------------------------------------------
-- 1. The document: an optional minorTerms object.

CREATE FUNCTION fn_departure_minor_terms_valid(t jsonb) RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(t, ARRAY['allowed', 'minAge', 'childPriceKopecks'])
    AND jsonb_typeof(t->'allowed') = 'boolean'
    AND CASE jsonb_typeof(t->'minAge') WHEN 'null' THEN true
             WHEN 'number' THEN fn_json_int(t->'minAge', 0) AND (t->>'minAge')::numeric <= 17 ELSE false END
    AND CASE jsonb_typeof(t->'childPriceKopecks') WHEN 'null' THEN true
             WHEN 'number' THEN fn_json_int(t->'childPriceKopecks', 1) AND (t->>'childPriceKopecks')::numeric < 1000000000000
             ELSE false END
    -- Terms for minors exist only when minors may be sold: no orphan price or age.
    AND ((t->'allowed')::boolean OR (jsonb_typeof(t->'minAge') = 'null' AND jsonb_typeof(t->'childPriceKopecks') = 'null'))
    -- OWNER 6A (review of PR #89): when 0–13 seats can be sold (no minimum age, or one below 14) the child
    -- price is published explicitly, even if it equals the adult price; never an implicit adult fallback.
    -- With a minimum age of 14 or more there are no 0–13 seats, so no child price either.
    AND (NOT (t->'allowed')::boolean
         OR CASE WHEN jsonb_typeof(t->'minAge') = 'number' AND (t->>'minAge')::numeric >= 14
                 THEN jsonb_typeof(t->'childPriceKopecks') = 'null'
                 ELSE jsonb_typeof(t->'childPriceKopecks') = 'number' END)
$fn$ LANGUAGE sql;

-- The published (or default) terms of a departure document, normalized.
CREATE FUNCTION fn_departure_minor_terms(doc jsonb) RETURNS jsonb IMMUTABLE SET search_path = pg_catalog, public AS $fn$
  SELECT CASE WHEN doc ? 'minorTerms' THEN doc->'minorTerms'
              ELSE '{"allowed": false, "minAge": null, "childPriceKopecks": null}'::jsonb END
$fn$ LANGUAGE sql;

-- 0009's validator, same signature, plus the optional minorTerms key.
CREATE OR REPLACE FUNCTION fn_departure_document_valid(doc jsonb) RETURNS boolean STABLE SET search_path = pg_catalog, public AS $fn$
  SELECT fn_json_keys(doc - 'organizers' - 'minorTerms', ARRAY['slug', 'startsOn', 'endsOn', 'departureTime', 'returnTime', 'timezone',
                                                'priceKopecks', 'contract', 'content'])
    AND (NOT doc ? 'minorTerms' OR coalesce(fn_departure_minor_terms_valid(doc->'minorTerms'), false))
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
-- 2. One write path: the publication. For every login's DML.

CREATE FUNCTION fn_departure_minor_terms_guard() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE v_doc jsonb; v_terms jsonb; v_by text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.minors_allowed OR NEW.minor_min_age IS NOT NULL OR NEW.child_price_kopecks IS NOT NULL
       OR NEW.minor_settings_version <> 0 OR NEW.minor_sales_paused THEN
      RAISE EXCEPTION 'DEPARTURE_MINOR_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.published_version IS DISTINCT FROM OLD.published_version AND NEW.published_version IS NOT NULL THEN
    SELECT document, published_by INTO v_doc, v_by FROM departure_revision
     WHERE departure_id = NEW.id AND version = NEW.published_version;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_MINOR_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000'; END IF;
    v_terms := fn_departure_minor_terms(v_doc);
    IF NOT coalesce(fn_departure_minor_terms_valid(v_terms), false) THEN
      RAISE EXCEPTION 'DEPARTURE_DOCUMENT_INVALID' USING ERRCODE = '22023';
    END IF;
    NEW.minors_allowed := (v_terms->'allowed')::boolean;
    NEW.minor_min_age := (v_terms->>'minAge')::int;
    NEW.child_price_kopecks := (v_terms->>'childPriceKopecks')::bigint;
    IF ROW(NEW.minors_allowed, NEW.minor_min_age, NEW.child_price_kopecks)
       IS DISTINCT FROM ROW(OLD.minors_allowed, OLD.minor_min_age, OLD.child_price_kopecks) THEN
      -- A changed price or permission is a new version the pricing basis can name (0021 §6 п.5).
      NEW.minor_settings_version := OLD.minor_settings_version + 1;
      INSERT INTO departure_minor_event (departure_id, actor, action, reason, version, details)
        VALUES (NEW.id, coalesce(v_by, 'publication'), 'SETTINGS', 'departure publication v' || NEW.published_version,
          NEW.minor_settings_version, v_terms || jsonb_build_object('departureVersion', NEW.published_version));
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.minors_allowed, NEW.minor_min_age, NEW.child_price_kopecks)
     IS DISTINCT FROM ROW(OLD.minors_allowed, OLD.minor_min_age, OLD.child_price_kopecks) THEN
    RAISE EXCEPTION 'DEPARTURE_MINOR_TERMS_PUBLICATION_ONLY' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_minor_terms_guard BEFORE INSERT OR UPDATE ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_departure_minor_terms_guard();

-- ---------------------------------------------------------------------------------------------
-- 3. The contract snapshot v2: schema /1 plus the minor terms the buyer accepted.

CREATE OR REPLACE FUNCTION fn_order_contract_snapshot_valid(s jsonb, p_slug text, p_starts date, p_ends date,
  p_departure_time text, p_return_time text, p_timezone text, p_unit_price bigint)
RETURNS boolean IMMUTABLE SET search_path = pg_catalog, public AS $fn$
DECLARE
  t jsonb;
  d jsonb;
  a jsonb;
  k jsonb;
BEGIN
  IF s->>'schema' = 'mikluha.order-contract/2' THEN
    IF NOT fn_json_keys(s, ARRAY['schema', 'tourSlug', 'tourTitle', 'departureSlug', 'startsOn', 'endsOn',
         'timezone', 'unitPriceKopecks', 'currency', 'contract', 'minorTerms'])
       OR NOT coalesce(fn_departure_minor_terms_valid(s->'minorTerms'), false) THEN RETURN false; END IF;
    -- The rest is exactly schema /1.
    s := (s - 'minorTerms') || '{"schema": "mikluha.order-contract/1"}'::jsonb;
  END IF;
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

-- A PRICED_SLOTS order carries /2, a UNIFORM one /1. NOT VALID: orders written before this
-- migration were synthetic (0021 is not installed anywhere) and are not rewritten.
ALTER TABLE orders ADD CONSTRAINT orders_contract_snapshot_model CHECK (contract_snapshot IS NULL
  OR (seat_model = 'PRICED_SLOTS') = (contract_snapshot->>'schema' = 'mikluha.order-contract/2')) NOT VALID;

-- At insert, under the departure lock (0008's trigger took it): the accepted minor terms are the
-- departure's published ones, which fn_open_slotted_purchase then freezes in the pricing basis.
CREATE FUNCTION fn_order_minor_terms_on_insert() RETURNS trigger SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE;
BEGIN
  IF NEW.seat_model <> 'PRICED_SLOTS' THEN RETURN NEW; END IF;
  SELECT * INTO d FROM departure WHERE id = NEW.departure_id;
  IF NOT FOUND OR NEW.accepted_departure_version IS DISTINCT FROM d.published_version
     OR NEW.contract_snapshot->'minorTerms' IS DISTINCT FROM jsonb_build_object('allowed', d.minors_allowed,
          'minAge', d.minor_min_age, 'childPriceKopecks', d.child_price_kopecks) THEN
    RAISE EXCEPTION 'ORDER_MINOR_TERMS_MISMATCH' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_order_minor_terms_on_insert BEFORE INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_order_minor_terms_on_insert();

-- ---------------------------------------------------------------------------------------------
-- 4. The public projection: 0010's view, plus the published minor terms and the pause.

CREATE OR REPLACE VIEW public_departure WITH (security_barrier) AS
  SELECT d.slug, t.slug AS tour_slug, t.title AS tour_title, d.starts_on, d.ends_on, d.departure_time, d.return_time,
         d.timezone, d.price_kopecks, d.capacity, d.contract, d.contract_complete, d.content, d.booking_status, d.is_demo,
         d.published_version, d.minors_allowed, d.minor_min_age, d.child_price_kopecks, d.minor_sales_paused
    FROM departure d JOIN tour t ON t.id = d.tour_id
   WHERE d.published_at IS NOT NULL AND d.is_listed AND t.published_at IS NOT NULL AND t.is_listed
     AND NOT EXISTS (
       SELECT 1 FROM departure_organizer x LEFT JOIN content_item o ON o.id = x.organizer_id
        WHERE x.departure_id = d.id
          AND (o.id IS NULL OR o.kind <> 'organizer' OR o.published_at IS NULL OR NOT o.is_listed)
     );

-- The two pure validators stay executable like 0008's fn_json_* helpers: the orders CHECK constraint
-- calls them as the inserting login.
REVOKE ALL ON FUNCTION fn_departure_minor_terms_guard(), fn_order_minor_terms_on_insert() FROM PUBLIC;
