-- Owner-held evidence only. The distributed template is NOT a signed processing instruction.
-- Neither runtime nor operator may attest a signature; owner records verified evidence separately.
-- New bookings freeze exact local times AND timezone with their dates/price. Historical rows stay
-- NULL rather than being backfilled from today's mutable CMS; new payment for them is refused.
ALTER TABLE orders
  ADD COLUMN trip_departure_time text CHECK (trip_departure_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN trip_return_time text CHECK (trip_return_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN trip_timezone text CHECK (length(trip_timezone) BETWEEN 1 AND 100),
  ADD CONSTRAINT frozen_trip_schedule_complete CHECK (
    (trip_departure_time IS NULL AND trip_return_time IS NULL AND trip_timezone IS NULL)
    OR (trip_departure_time IS NOT NULL AND trip_return_time IS NOT NULL AND trip_timezone IS NOT NULL)
  );
CREATE FUNCTION fn_frozen_trip_schedule() RETURNS trigger SET search_path = pg_catalog, public AS $fn$
BEGIN
  IF ROW(NEW.trip_departure_time, NEW.trip_return_time, NEW.trip_timezone)
     IS DISTINCT FROM ROW(OLD.trip_departure_time, OLD.trip_return_time, OLD.trip_timezone) THEN
    RAISE EXCEPTION 'FROZEN_TRIP_SCHEDULE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
REVOKE ALL ON FUNCTION fn_frozen_trip_schedule() FROM PUBLIC;
CREATE TRIGGER trg_frozen_trip_schedule BEFORE UPDATE OF trip_departure_time, trip_return_time, trip_timezone
  ON orders FOR EACH ROW EXECUTE FUNCTION fn_frozen_trip_schedule();

CREATE TABLE processing_instruction (
  document_ref text PRIMARY KEY CHECK (length(document_ref) BETWEEN 1 AND 200),
  version text NOT NULL CHECK (length(version) BETWEEN 1 AND 40),
  processor_ref text NOT NULL CHECK (length(processor_ref) BETWEEN 1 AND 100),
  template_ref text NOT NULL CHECK (length(template_ref) BETWEEN 1 AND 300),
  template_sha256 text NOT NULL CHECK (template_sha256 ~ '^sha256:[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('DRAFT', 'SIGNED')),
  signed_at date,
  effective_at date,
  sha256 text CHECK (sha256 ~ '^sha256:[0-9a-f]{64}$'),
  signed_document_ref text CHECK (length(signed_document_ref) BETWEEN 1 AND 300),
  UNIQUE (processor_ref, version),
  CHECK (
    (status = 'DRAFT' AND signed_at IS NULL AND effective_at IS NULL AND sha256 IS NULL AND signed_document_ref IS NULL)
    OR (status = 'SIGNED' AND signed_at IS NOT NULL AND effective_at IS NOT NULL
        AND effective_at >= signed_at AND sha256 IS NOT NULL AND signed_document_ref IS NOT NULL)
  )
);
REVOKE ALL ON processing_instruction FROM PUBLIC, commerce_app, commerce_operator;
GRANT SELECT ON processing_instruction TO commerce_app, commerce_operator;
INSERT INTO processing_instruction
  (document_ref, version, processor_ref, template_ref, template_sha256, status)
VALUES ('pd-processing-instruction-refref-v1', '1.0', 'refref',
  'commerce/legal/pd-processing-instruction-refref-v1.md',
  'sha256:3b4231e8e6426c9c9c4df33fae373a8a0eb14aa08c31237a34461e2b2c1a09f9', 'DRAFT');
