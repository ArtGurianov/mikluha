-- TOUR-96 / OWNER 2026-11-01: NEW local calendar dates use Asia/Krasnoyarsk.
-- No historical publication, accepted snapshot, UTC timestamp or old migration is rewritten.
-- Working Phase A has no legal publications. Refuse to reinterpret an existing
-- publication stream; it requires a separately reviewed history-aware migration.
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM legal_publication) THEN
    RAISE EXCEPTION 'LEGAL_CALENDAR_HISTORY_REQUIRES_REVIEW' USING ERRCODE = '55000';
  END IF;
END $guard$;

CREATE FUNCTION fn_local_calendar_date(p_at timestamptz) RETURNS date
LANGUAGE sql STABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$ SELECT (p_at AT TIME ZONE 'Asia/Krasnoyarsk')::date $$;
REVOKE ALL ON FUNCTION fn_local_calendar_date(timestamptz) FROM PUBLIC;
-- public_legal invokes this helper as its reader; it grants no raw legal/audit access.
GRANT EXECUTE ON FUNCTION fn_local_calendar_date(timestamptz) TO commerce_app;

CREATE OR REPLACE FUNCTION fn_admin_publish_legal(p_id uuid, p_draft int, p_version int, p_effective date, p_approval text, p_by text) RETURNS jsonb
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
  -- New local publication dates follow the OWNER-adopted Krasnoyarsk calendar.
  IF p_effective < fn_local_calendar_date(clock_timestamp()) THEN
    RAISE EXCEPTION 'LEGAL_EFFECTIVE_IN_PAST' USING ERRCODE = '22023'; END IF;
  h := fn_sha256_jsonb(d.document);
  th := 'sha256:' || encode(sha256(convert_to(d.document #>> '{content,body}', 'UTF8')), 'hex');
  INSERT INTO legal_publication(item_id, version, draft_revision, document, document_sha256, text_sha256, effective_on, approval, approved_by, login_role)
    VALUES(p_id, v + 1, p_draft, d.document, h, th, p_effective, btrim(p_approval), v_by, session_user);
  PERFORM fn_editorial_audit('legal', p_id, 'PUBLISH', v_by, p_draft, v + 1, h,
    jsonb_build_object('effectiveOn', p_effective, 'textSha256', th));
  RETURN jsonb_build_object('outcome','PUBLISHED', 'version', v + 1, 'documentSha256', h, 'textSha256', th, 'effectiveOn', p_effective);
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW public_legal WITH (security_barrier) AS
  SELECT c.slug, p.version, p.document, p.document_sha256, p.text_sha256, p.effective_on, p.published_at
  FROM content_item c JOIN legal_publication p ON p.item_id = c.id
  WHERE p.effective_on <= fn_local_calendar_date(clock_timestamp())
    AND p.version = (SELECT max(q.version) FROM legal_publication q WHERE q.item_id = c.id
      AND q.effective_on <= fn_local_calendar_date(clock_timestamp()));
