-- ART-358 / PR #40: forward correction of migration 0009. Preserve applied migration checksums.
-- One classification per published-version/draft identity; MATERIAL replay never creates more
-- move/cancel work and cannot be reclassified through the ordinary publish command.
-- Fail-closed organizer visibility propagates to departures and their reports.

ALTER TABLE departure_execution_change ADD CONSTRAINT departure_execution_change_identity
  UNIQUE (departure_id, from_version, draft_revision);

CREATE OR REPLACE FUNCTION fn_publish_departure_change(p_departure_id uuid, p_expected_draft_revision int,
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
  v_existing departure_execution_change%ROWTYPE;
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
  -- MATERIAL does not advance either CAS token. Resolve a retry under the departure row lock,
  -- before checking current order eligibility or graph state: it returns the recorded result.
  SELECT * INTO v_existing FROM departure_execution_change
   WHERE departure_id = p_departure_id AND from_version = v_published AND draft_revision = v_draft.revision;
  IF FOUND THEN
    IF v_existing.classification = 'MATERIAL' AND p_classification = 'MATERIAL'
       AND v_existing.notice = btrim(p_notice) THEN
      RETURN jsonb_build_object('outcome', v_existing.outcome, 'version', v_existing.from_version,
        'changeId', v_existing.id, 'affectedOrders', cardinality(v_existing.affected_order_refs));
    END IF;
    RAISE EXCEPTION 'EXECUTION_CHANGE_CONFLICT: this published version and draft revision are already classified'
      USING ERRCODE = '55000';
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

CREATE OR REPLACE VIEW public_departure WITH (security_barrier) AS
  SELECT d.slug, t.slug AS tour_slug, t.title AS tour_title, d.starts_on, d.ends_on, d.departure_time, d.return_time,
         d.timezone, d.price_kopecks, d.capacity, d.contract, d.contract_complete, d.content, d.booking_status, d.is_demo,
         d.published_version
    FROM departure d JOIN tour t ON t.id = d.tour_id
   WHERE d.published_at IS NOT NULL AND d.is_listed AND t.published_at IS NOT NULL AND t.is_listed
     AND NOT EXISTS (
       SELECT 1 FROM departure_organizer x LEFT JOIN content_item o ON o.id = x.organizer_id
        WHERE x.departure_id = d.id
          AND (o.id IS NULL OR o.kind <> 'organizer' OR o.published_at IS NULL OR NOT o.is_listed)
     );

CREATE OR REPLACE VIEW public_report WITH (security_barrier) AS
  SELECT c.slug, c.document->>'title' AS title, t.slug AS tour_slug, d.slug AS departure_slug,
         fn_json_date(c.document->'date') AS date, (c.document->'noindex')::boolean AS noindex,
         c.document->'content' AS content, c.published_version
    FROM content_item c JOIN tour t ON t.id = c.tour_id LEFT JOIN departure d ON d.id = c.departure_id
   WHERE c.kind = 'report' AND c.published_at IS NOT NULL AND c.is_listed
     AND t.published_at IS NOT NULL AND t.is_listed
     AND (c.departure_id IS NULL OR EXISTS (SELECT 1 FROM public_departure p WHERE p.slug = d.slug));

