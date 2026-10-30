-- TOUR-63. Source-only; apply with the independently authorized migration owner.
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='media_worker') THEN
  CREATE ROLE media_worker NOLOGIN; END IF; END $$;
CREATE TABLE media_asset (
  id uuid PRIMARY KEY,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_bytes bytea CHECK (octet_length(source_bytes) BETWEEN 1 AND 8388608),
  alt text NOT NULL CHECK (length(btrim(alt)) BETWEEN 1 AND 500),
  credit text NOT NULL CHECK (length(btrim(credit)) BETWEEN 1 AND 500),
  rights_basis text NOT NULL CHECK (rights_basis IN ('OWNED','CONSENT')),
  rights_reference text NOT NULL CHECK (length(btrim(rights_reference)) BETWEEN 1 AND 1000),
  rights_confirmed boolean NOT NULL CHECK (rights_confirmed),
  created_by text NOT NULL CHECK (length(created_by) BETWEEN 1 AND 200),
  state text NOT NULL DEFAULT 'UPLOADED' CHECK (state IN ('UPLOADED','READY','PUBLISH_REQUESTED','PUBLISHED','REVOKE_REQUESTED','REVOKED','REJECTED')),
  variants jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(variants)='array'),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text CHECK (last_error IS NULL OR last_error IN ('STORAGE_UNCONFIRMED','IMAGE_REJECTED','PRIVACY_UNCONFIRMED')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz, revoked_at timestamptz,
  CHECK (state <> 'UPLOADED' OR source_bytes IS NOT NULL),
  CHECK (state NOT IN ('READY','PUBLISH_REQUESTED','PUBLISHED') OR jsonb_array_length(variants)=3),
  CHECK (state NOT IN ('REVOKED','REJECTED') OR source_bytes IS NULL)
);
CREATE INDEX media_pending ON media_asset(next_attempt_at) WHERE state IN ('UPLOADED','PUBLISH_REQUESTED','REVOKE_REQUESTED');
CREATE TABLE media_event (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, asset_id uuid NOT NULL REFERENCES media_asset(id),
  actor text NOT NULL, event text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE VIEW admin_media AS SELECT id,source_sha256,alt,credit,rights_basis,rights_reference,rights_confirmed,created_by,state,
  -- Storage keys stay with the worker. Public URLs appear only after completed publication.
  CASE WHEN state='PUBLISHED' THEN (SELECT jsonb_agg(v - 'key') FROM jsonb_array_elements(variants) v) ELSE '[]'::jsonb END AS variants,
  attempts,last_error,created_at,updated_at,published_at,revoked_at FROM media_asset;
CREATE VIEW public_media AS SELECT id, alt,
  (SELECT jsonb_agg(v - 'key') FROM jsonb_array_elements(variants) v) AS variants
  FROM media_asset WHERE state='PUBLISHED';
REVOKE ALL ON media_asset,media_event,admin_media,public_media FROM PUBLIC;
GRANT SELECT ON admin_media TO admin_app,admin_publisher;
GRANT SELECT ON public_media TO commerce_app;
GRANT SELECT ON schema_migrations,schema_migration_compatibility TO media_worker;

CREATE FUNCTION fn_media_enqueue(p_id uuid,p_sha text,p_bytes bytea,p_alt text,p_credit text,p_basis text,p_reference text,p_actor text,p_confirmed boolean)
RETURNS uuid SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v media_asset;
BEGIN
  -- Bound staging globally, including concurrent uploads; bytea is not an unbounded durable inbox.
  IF p_confirmed IS NOT TRUE THEN RAISE EXCEPTION 'MEDIA_INVALID' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(630018);
  SELECT * INTO v FROM media_asset WHERE id=p_id;
  IF FOUND THEN
    IF ROW(v.source_sha256,v.alt,v.credit,v.rights_basis,v.rights_reference,v.created_by)
      IS DISTINCT FROM ROW(p_sha,p_alt,p_credit,p_basis,p_reference,p_actor) THEN
      RAISE EXCEPTION 'MEDIA_IDEMPOTENCY_CONFLICT' USING ERRCODE='22023'; END IF;
    RETURN p_id;
  END IF;
  IF p_id IS NULL OR p_sha IS NULL OR p_bytes IS NULL OR p_alt IS NULL OR p_credit IS NULL
    OR p_basis IS NULL OR p_reference IS NULL OR p_actor IS NULL OR p_confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'MEDIA_INVALID' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM media_asset WHERE source_bytes IS NOT NULL) >= 32 THEN
    RAISE EXCEPTION 'MEDIA_QUEUE_FULL' USING ERRCODE='54000'; END IF;
  INSERT INTO media_asset(id,source_sha256,source_bytes,alt,credit,rights_basis,rights_reference,created_by,rights_confirmed)
    VALUES(p_id,p_sha,p_bytes,p_alt,p_credit,p_basis,p_reference,p_actor,p_confirmed);
  INSERT INTO media_event(asset_id,actor,event) VALUES(p_id,p_actor,'UPLOADED');
  RETURN p_id;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION fn_media_request(p_id uuid,p_action text,p_actor text) RETURNS void
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v media_asset;
BEGIN
  SELECT * INTO v FROM media_asset WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIA_UNKNOWN' USING ERRCODE='22023'; END IF;
  IF p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'MEDIA_INVALID' USING ERRCODE='22023'; END IF;
  IF p_action='PUBLISH' AND v.state='READY' THEN
    UPDATE media_asset SET state='PUBLISH_REQUESTED',attempts=0,next_attempt_at=now(),last_error=NULL,updated_at=now() WHERE id=p_id;
  ELSIF p_action='REVOKE' AND v.state NOT IN ('REVOKED','REVOKE_REQUESTED') THEN
    -- Public eligibility ends in this transaction, before storage I/O. Never resurrect this ID.
    UPDATE media_asset SET state='REVOKE_REQUESTED',source_bytes=NULL,attempts=0,next_attempt_at=now(),last_error=NULL,updated_at=now() WHERE id=p_id;
  ELSIF (p_action='PUBLISH' AND v.state IN ('PUBLISH_REQUESTED','PUBLISHED'))
    OR (p_action='REVOKE' AND v.state IN ('REVOKE_REQUESTED','REVOKED')) THEN RETURN;
  ELSE RAISE EXCEPTION 'MEDIA_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  INSERT INTO media_event(asset_id,actor,event) VALUES(p_id,p_actor,p_action || '_REQUESTED');
END $$ LANGUAGE plpgsql;

-- Claim locks are held by the worker transaction through read-back. OWNER revocation serializes
-- with publication, so a late worker cannot re-publish after a completed withdrawal.
-- Withdrawal never exhausts its retries: objects of a withdrawn photo must not stay public
-- while waiting for an operator. Admission/publication stop after five attempts.
CREATE FUNCTION fn_media_claim() RETURNS SETOF media_asset
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT * FROM media_asset WHERE state IN ('UPLOADED','PUBLISH_REQUESTED','REVOKE_REQUESTED')
    AND (attempts<5 OR state='REVOKE_REQUESTED') AND next_attempt_at<=now()
  ORDER BY (state='REVOKE_REQUESTED') DESC,created_at LIMIT 1 FOR UPDATE SKIP LOCKED
$$ LANGUAGE sql;
CREATE FUNCTION fn_media_complete(p_id uuid,p_state text,p_variants jsonb) RETURNS void
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v media_asset;
BEGIN
  SELECT * INTO v FROM media_asset WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR NOT ((v.state='UPLOADED' AND p_state IN ('READY','REJECTED'))
    OR (v.state='PUBLISH_REQUESTED' AND p_state='PUBLISHED')
    OR (v.state='REVOKE_REQUESTED' AND p_state='REVOKED')) THEN
    RAISE EXCEPTION 'MEDIA_STATE_CONFLICT' USING ERRCODE='22023'; END IF;
  IF p_state='READY' THEN
    IF jsonb_typeof(p_variants) IS DISTINCT FROM 'array' OR jsonb_array_length(p_variants)<>3 THEN
      RAISE EXCEPTION 'MEDIA_INVALID' USING ERRCODE='22023'; END IF;
  ELSIF p_variants IS DISTINCT FROM v.variants THEN
    RAISE EXCEPTION 'MEDIA_INVALID' USING ERRCODE='22023'; END IF;
  UPDATE media_asset SET state=p_state,variants=p_variants,source_bytes=NULL,attempts=0,last_error=NULL,
    updated_at=now(),published_at=CASE WHEN p_state='PUBLISHED' THEN now() ELSE published_at END,
    revoked_at=CASE WHEN p_state='REVOKED' THEN now() ELSE revoked_at END WHERE id=p_id;
  INSERT INTO media_event(asset_id,actor,event) VALUES(p_id,'media-worker',p_state);
END $$ LANGUAGE plpgsql;
CREATE FUNCTION fn_media_retry(p_id uuid) RETURNS void
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE media_asset SET attempts=least(attempts+1,5),
    next_attempt_at=now()+CASE WHEN attempts+1>=5 THEN interval '15 minutes' ELSE interval '1 minute' END,
    last_error=CASE WHEN last_error='PRIVACY_UNCONFIRMED' THEN last_error ELSE 'STORAGE_UNCONFIRMED' END,updated_at=now()
  WHERE id=p_id AND state IN ('UPLOADED','PUBLISH_REQUESTED','REVOKE_REQUESTED')
$$ LANGUAGE sql;
-- Admission privacy failures stop processing and schedule cleanup of every known key, including
-- partially written originals. They must not leave a possibly public original waiting for manual action.
CREATE FUNCTION fn_media_quarantine(p_id uuid) RETURNS void
SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE media_asset SET state='REVOKE_REQUESTED',source_bytes=NULL,attempts=0,next_attempt_at=now(),
    last_error='PRIVACY_UNCONFIRMED',updated_at=now()
    WHERE id=p_id AND state IN ('UPLOADED','PUBLISH_REQUESTED');
  IF FOUND THEN INSERT INTO media_event(asset_id,actor,event) VALUES(p_id,'media-worker','PRIVACY_QUARANTINED'); END IF;
END $$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION fn_media_quarantine(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_media_quarantine(uuid) TO media_worker;
REVOKE ALL ON FUNCTION fn_media_enqueue(uuid,text,bytea,text,text,text,text,text,boolean),fn_media_request(uuid,text,text),
  fn_media_claim(),fn_media_complete(uuid,text,jsonb),fn_media_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_media_enqueue(uuid,text,bytea,text,text,text,text,text,boolean) TO admin_app;
GRANT EXECUTE ON FUNCTION fn_media_request(uuid,text,text) TO admin_publisher;
GRANT EXECUTE ON FUNCTION fn_media_claim(),fn_media_complete(uuid,text,jsonb),fn_media_retry(uuid) TO media_worker;
