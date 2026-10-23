-- PR #46 review: only a new writer can attest that no createAttempt was ever dispatched.
-- Historical rows remain UNKNOWN, including rows written by an older process during an upgrade.
ALTER TABLE orders ADD COLUMN attempt_creation_state text NOT NULL DEFAULT 'UNKNOWN'
  CHECK (attempt_creation_state IN ('NOT_STARTED', 'STARTED', 'UNKNOWN'));

CREATE FUNCTION fn_attempt_creation_evidence() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF OLD.attempt_creation_state <> 'NOT_STARTED' AND NEW.attempt_creation_state = 'NOT_STARTED' THEN
    RAISE EXCEPTION 'ATTEMPT_CREATION_EVIDENCE_IRREVERSIBLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
CREATE TRIGGER trg_attempt_creation_evidence BEFORE UPDATE OF attempt_creation_state ON orders
  FOR EACH ROW EXECUTE FUNCTION fn_attempt_creation_evidence();
REVOKE ALL ON FUNCTION fn_attempt_creation_evidence() FROM PUBLIC;
