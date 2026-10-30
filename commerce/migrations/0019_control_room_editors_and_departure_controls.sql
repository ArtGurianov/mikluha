-- TOUR-64 Stage A / TOUR-65. Source-only clean installation: no sales activation.
-- Consumer of 0017's seat truth; no native allocation/payment workflow is introduced.
ALTER TABLE departure ADD COLUMN control_version int NOT NULL DEFAULT 0 CHECK (control_version >= 0),
  ADD COLUMN close_batch_id uuid;

CREATE TABLE departure_control_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), actor text NOT NULL, login_role text NOT NULL
);
CREATE TABLE departure_control_batch_member (
  batch_id uuid NOT NULL REFERENCES departure_control_batch(id), departure_id uuid NOT NULL REFERENCES departure(id),
  closed_version int NOT NULL, PRIMARY KEY(batch_id, departure_id)
);
ALTER TABLE departure ADD FOREIGN KEY(close_batch_id) REFERENCES departure_control_batch(id);
CREATE TRIGGER trg_control_batch_immutable BEFORE UPDATE OR DELETE ON departure_control_batch
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_control_batch_no_truncate BEFORE TRUNCATE ON departure_control_batch
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_control_member_immutable BEFORE UPDATE OR DELETE ON departure_control_batch_member
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_control_member_no_truncate BEFORE TRUNCATE ON departure_control_batch_member
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();

-- Even an explicit CLOSED -> CLOSED supersedes a batch. Capacity/listing touches are conservative:
-- they also require a fresh explicit resume, rather than reviving an old batch's intent.
CREATE FUNCTION fn_departure_control_version() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  NEW.control_version := OLD.control_version + 1;
  NEW.close_batch_id := NULL;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_departure_control_version BEFORE UPDATE OF booking_status, capacity, is_listed ON departure
  FOR EACH ROW EXECUTE FUNCTION fn_departure_control_version();

-- Caller has the row then departure advisory lock. This function does not release seats or change
-- uncertain operations. Existing orders and purchase revisions are read only via canonical 0017.
CREATE FUNCTION fn_admin_departure_open_refusal(p_id uuid) RETURNS text
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE;
BEGIN
  SELECT * INTO d FROM departure WHERE id = p_id;
  IF d.booking_status = 'CANCELLED' OR d.cancellation_requested_at IS NOT NULL THEN RETURN 'DEPARTURE_CANCELLED'; END IF;
  IF d.published_at IS NULL OR NOT d.is_listed OR d.is_demo
     OR NOT EXISTS (SELECT 1 FROM public_departure WHERE slug = d.slug) THEN
    RETURN 'DEPARTURE_NOT_PUBLIC'; END IF;
  IF d.starts_on IS NULL OR d.departure_time IS NULL OR d.timezone IS NULL
     OR (d.starts_on + d.departure_time::time) AT TIME ZONE d.timezone <= clock_timestamp() THEN
    RETURN 'DEPARTURE_STARTED'; END IF;
  IF d.capacity IS NULL OR d.capacity < 1 OR d.price_kopecks IS NULL OR NOT d.contract_complete THEN
    RETURN 'DEPARTURE_INCOMPLETE'; END IF;
  IF fn_departure_taken_seats(d.slug, clock_timestamp()) > d.capacity THEN RETURN 'CAPACITY_BELOW_TAKEN'; END IF;
  RETURN NULL;
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_departure_controls(p_id uuid, p_expected int, p_status text, p_capacity int,
  p_listed boolean, p_by text) RETURNS jsonb
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE; v_by text := fn_editorial_actor(p_by); v_refusal text;
BEGIN
  IF p_status IS NOT NULL AND p_status NOT IN ('OPEN','CLOSED') THEN
    RAISE EXCEPTION 'DEPARTURE_STATUS_INVALID' USING ERRCODE = '22023'; END IF;
  IF p_status IS NULL AND p_capacity IS NULL AND p_listed IS NULL THEN
    RAISE EXCEPTION 'DEPARTURE_CONTROL_INVALID' USING ERRCODE = '22023'; END IF;
  -- Same leading lock order as checkout: global switch before any departure lock.
  IF p_status = 'OPEN' AND NOT fn_sales_open_for_sale() THEN
    RAISE EXCEPTION 'GLOBAL_OPERATOR_STOP' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure-status-batch', 0));
  SELECT * INTO d FROM departure WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
  IF d.control_version IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'DEPARTURE_CONTROL_CONFLICT' USING ERRCODE = '55000'; END IF;
  IF d.booking_status = 'CANCELLED' THEN RAISE EXCEPTION 'DEPARTURE_CANCELLED' USING ERRCODE = '55000'; END IF;
  IF p_capacity IS NOT NULL THEN
    IF p_capacity < 1 OR p_capacity > 100000 OR p_capacity < fn_departure_taken_seats(d.slug, clock_timestamp()) THEN
      RAISE EXCEPTION 'CAPACITY_BELOW_TAKEN' USING ERRCODE = '55000'; END IF;
    UPDATE departure SET capacity = p_capacity WHERE id = p_id;
  END IF;
  IF p_listed IS NOT NULL THEN
    IF p_listed AND d.published_at IS NULL THEN RAISE EXCEPTION 'DEPARTURE_NOT_PUBLIC' USING ERRCODE = '55000'; END IF;
    IF NOT p_listed AND d.booking_status = 'OPEN' AND p_status IS DISTINCT FROM 'CLOSED' THEN
      RAISE EXCEPTION 'DEPARTURE_CLOSE_BEFORE_HIDE' USING ERRCODE = '55000'; END IF;
    UPDATE departure SET is_listed = p_listed WHERE id = p_id;
  END IF;
  IF p_status = 'OPEN' THEN
    v_refusal := fn_admin_departure_open_refusal(p_id);
    IF v_refusal IS NOT NULL THEN RAISE EXCEPTION '%', v_refusal USING ERRCODE = '55000'; END IF;
  END IF;
  IF p_status IS NOT NULL THEN UPDATE departure SET booking_status = p_status WHERE id = p_id; END IF;
  PERFORM fn_editorial_audit('departure', p_id, 'CONTROLS', v_by, NULL, NULL, NULL,
    jsonb_build_object('bookingStatus', p_status, 'capacity', p_capacity, 'isListed', p_listed));
  SELECT * INTO d FROM departure WHERE id = p_id;
  RETURN jsonb_build_object('controlVersion', d.control_version, 'bookingStatus', d.booking_status,
    'capacity', d.capacity, 'isListed', d.is_listed);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_pause_all(p_by text) RETURNS jsonb
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE; v_id uuid; v_version int; v_count int := 0; v_by text := fn_editorial_actor(p_by);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('departure-status-batch', 0));
  INSERT INTO departure_control_batch(actor, login_role) VALUES(v_by, session_user) RETURNING id INTO v_id;
  FOR d IN SELECT * FROM departure WHERE booking_status = 'OPEN' ORDER BY id FOR NO KEY UPDATE LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
    UPDATE departure SET booking_status = 'CLOSED' WHERE id = d.id RETURNING control_version INTO v_version;
    UPDATE departure SET close_batch_id = v_id WHERE id = d.id;
    INSERT INTO departure_control_batch_member VALUES(v_id, d.id, v_version);
    PERFORM fn_editorial_audit('departure', d.id, 'BATCH_CLOSE', v_by, NULL, NULL, NULL, jsonb_build_object('batchId', v_id));
    v_count := v_count + 1;
  END LOOP;
  RETURN jsonb_build_object('batchId', v_id, 'closed', v_count);
END $fn$ LANGUAGE plpgsql;

CREATE FUNCTION fn_admin_resume_batch(p_id uuid, p_by text) RETURNS jsonb
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE; v_by text := fn_editorial_actor(p_by); v_opened int := 0; v_skipped jsonb := '[]'; v_refusal text;
BEGIN
  IF NOT fn_sales_open_for_sale() THEN RAISE EXCEPTION 'GLOBAL_OPERATOR_STOP' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure-status-batch', 0));
  IF NOT EXISTS (SELECT 1 FROM departure_control_batch WHERE id = p_id) THEN
    RAISE EXCEPTION 'BATCH_UNKNOWN' USING ERRCODE = '55000'; END IF;
  FOR d IN SELECT x.* FROM departure x JOIN departure_control_batch_member m ON m.departure_id = x.id
      WHERE m.batch_id = p_id ORDER BY x.id FOR NO KEY UPDATE OF x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
    v_refusal := CASE WHEN d.booking_status <> 'CLOSED' OR d.close_batch_id IS DISTINCT FROM p_id
      OR d.control_version <> (SELECT closed_version FROM departure_control_batch_member WHERE batch_id = p_id AND departure_id = d.id)
      THEN 'BATCH_SUPERSEDED' ELSE fn_admin_departure_open_refusal(d.id) END;
    IF v_refusal IS NULL THEN
      UPDATE departure SET booking_status = 'OPEN' WHERE id = d.id;
      PERFORM fn_editorial_audit('departure', d.id, 'BATCH_RESUME', v_by, NULL, NULL, NULL, jsonb_build_object('batchId', p_id));
      v_opened := v_opened + 1;
    ELSE v_skipped := v_skipped || jsonb_build_array(jsonb_build_object('id', d.id, 'reason', v_refusal)); END IF;
  END LOOP;
  RETURN jsonb_build_object('batchId', p_id, 'opened', v_opened, 'skipped', v_skipped);
END $fn$ LANGUAGE plpgsql;

-- Stage A Admin publication cannot enter the unfinished paid-order change workflow. Keep the
-- existing Stage B primitives and immutable history intact; this is a separate, bounded entry.
CREATE FUNCTION fn_publish_departure_stage_a(p_id uuid, p_draft int, p_version int, p_by text) RETURNS jsonb
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE d departure%ROWTYPE; doc jsonb;
BEGIN
  SELECT * INTO d FROM departure WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DEPARTURE_UNKNOWN' USING ERRCODE = '55000'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('departure:' || d.slug, 0));
  SELECT document INTO doc FROM departure_draft WHERE departure_id = p_id;
  IF EXISTS (SELECT 1 FROM orders WHERE departure_id = d.id OR departure_slug = d.slug)
      AND ROW(doc->'contract', doc->>'startsOn', doc->>'endsOn', doc->>'departureTime', doc->>'returnTime', doc->>'timezone')
        IS DISTINCT FROM ROW(coalesce(d.contract, 'null'::jsonb), d.starts_on::text, d.ends_on::text, d.departure_time, d.return_time, d.timezone) THEN
    RAISE EXCEPTION 'ORDER_CHANGE_STAGE_B_REQUIRED' USING ERRCODE = '55000'; END IF;
  RETURN fn_publish_departure_change(p_id, p_draft, p_version, NULL, NULL, p_by);
END $fn$ LANGUAGE plpgsql;

-- Legal publication is immutable evidence with explicit approval, separate from signing a
-- processing instruction or selecting a payment/PD-consent release for checkout.
CREATE TABLE legal_publication (
  item_id uuid NOT NULL REFERENCES content_item(id), version int NOT NULL CHECK(version > 0),
  draft_revision int NOT NULL, document jsonb NOT NULL,
  document_sha256 text NOT NULL CHECK(document_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  text_sha256 text NOT NULL CHECK(text_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  effective_on date NOT NULL, approval text NOT NULL CHECK(length(btrim(approval)) BETWEEN 1 AND 2000),
  approved_by text NOT NULL, login_role text NOT NULL, published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(item_id, version)
);
CREATE TRIGGER trg_legal_publication_immutable BEFORE UPDATE OR DELETE ON legal_publication
  FOR EACH ROW EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE TRIGGER trg_legal_publication_no_truncate BEFORE TRUNCATE ON legal_publication
  FOR EACH STATEMENT EXECUTE FUNCTION fn_editorial_history_immutable();
CREATE FUNCTION fn_admin_publish_legal(p_id uuid, p_draft int, p_version int, p_effective date, p_approval text, p_by text) RETURNS jsonb
SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
DECLARE c content_item%ROWTYPE; d content_item_draft%ROWTYPE; v int; v_by text := fn_editorial_actor(p_by); h text; th text;
BEGIN
  SELECT * INTO c FROM content_item WHERE id = p_id FOR NO KEY UPDATE;
  IF NOT FOUND OR c.kind <> 'legal' THEN RAISE EXCEPTION 'CONTENT_UNKNOWN' USING ERRCODE = '55000'; END IF;
  SELECT coalesce(max(version), 0) INTO v FROM legal_publication WHERE item_id = p_id;
  IF v IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'PUBLISHED_VERSION_CONFLICT' USING ERRCODE = '55000'; END IF;
  SELECT * INTO d FROM content_item_draft WHERE item_id = p_id;
  IF NOT FOUND OR d.revision IS DISTINCT FROM p_draft THEN RAISE EXCEPTION 'DRAFT_REVISION_CONFLICT' USING ERRCODE = '55000'; END IF;
  IF p_effective IS NULL OR p_approval IS NULL OR length(btrim(p_approval)) NOT BETWEEN 1 AND 2000
      OR NOT coalesce(fn_json_keys(d.document, ARRAY['slug','title','content']), false)
      OR d.document->>'slug' IS DISTINCT FROM c.slug OR NOT coalesce(fn_json_text(d.document->'title'), false)
      OR NOT coalesce(fn_json_text(d.document #> '{content,body}'), false) THEN
    RAISE EXCEPTION 'LEGAL_APPROVAL_INVALID' USING ERRCODE = '22023'; END IF;
  -- A text published today cannot claim to have governed earlier days (same Moscow date as public_legal).
  IF p_effective < (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date THEN
    RAISE EXCEPTION 'LEGAL_EFFECTIVE_IN_PAST' USING ERRCODE = '22023'; END IF;
  h := fn_sha256_jsonb(d.document);
  th := 'sha256:' || encode(sha256(convert_to(d.document #>> '{content,body}', 'UTF8')), 'hex');
  INSERT INTO legal_publication(item_id, version, draft_revision, document, document_sha256, text_sha256, effective_on, approval, approved_by, login_role)
    VALUES(p_id, v + 1, p_draft, d.document, h, th, p_effective, btrim(p_approval), v_by, session_user);
  PERFORM fn_editorial_audit('legal', p_id, 'PUBLISH', v_by, p_draft, v + 1, h,
    jsonb_build_object('effectiveOn', p_effective, 'textSha256', th));
  RETURN jsonb_build_object('outcome','PUBLISHED', 'version', v + 1, 'documentSha256', h, 'textSha256', th, 'effectiveOn', p_effective);
END $fn$ LANGUAGE plpgsql;
-- Legal rows retain their own publication stream, so first-publication identity is protected
-- even though the older content_item projection intentionally has no legal publication pointer.
CREATE FUNCTION fn_legal_identity_immutable() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM legal_publication WHERE item_id = OLD.id) THEN
    IF TG_OP = 'DELETE' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.slug IS DISTINCT FROM OLD.slug
       OR NEW.kind IS DISTINCT FROM OLD.kind THEN
      RAISE EXCEPTION 'CONTENT_IDENTITY_IMMUTABLE' USING ERRCODE = '55000'; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_legal_identity_immutable BEFORE UPDATE OR DELETE ON content_item
  FOR EACH ROW WHEN (OLD.kind = 'legal') EXECUTE FUNCTION fn_legal_identity_immutable();
REVOKE ALL ON FUNCTION fn_legal_identity_immutable() FROM PUBLIC;
CREATE VIEW public_legal WITH (security_barrier) AS
  SELECT c.slug, p.version, p.document, p.document_sha256, p.text_sha256, p.effective_on, p.published_at
  FROM content_item c JOIN legal_publication p ON p.item_id = c.id
  WHERE p.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
    AND p.version = (SELECT max(q.version) FROM legal_publication q WHERE q.item_id = c.id
      AND q.effective_on <= (clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date);

-- Redacted read models preserve the runtime's inability to read raw operator/purchase tables.
CREATE VIEW admin_sales_status AS SELECT open FROM sales_switch;
CREATE VIEW admin_departure_inventory AS
  SELECT id, fn_departure_taken_seats(slug, clock_timestamp())::int AS taken_seats FROM departure;
REVOKE ALL ON departure_control_batch, departure_control_batch_member, legal_publication, public_legal,
  admin_sales_status, admin_departure_inventory FROM PUBLIC;
GRANT SELECT ON departure_control_batch, departure_control_batch_member, legal_publication, admin_sales_status, admin_departure_inventory TO admin_app;
GRANT SELECT ON public_legal TO commerce_app;
REVOKE ALL ON FUNCTION fn_departure_control_version(), fn_admin_departure_open_refusal(uuid),
  fn_admin_departure_controls(uuid,int,text,int,boolean,text), fn_admin_pause_all(text), fn_admin_resume_batch(uuid,text),
  fn_publish_departure_stage_a(uuid,int,int,text), fn_admin_publish_legal(uuid,int,int,date,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_admin_departure_controls(uuid,int,text,int,boolean,text), fn_admin_pause_all(text),
  fn_admin_resume_batch(uuid,text), fn_publish_departure_stage_a(uuid,int,int,text),
  fn_admin_publish_legal(uuid,int,int,date,text,text) TO admin_publisher;
