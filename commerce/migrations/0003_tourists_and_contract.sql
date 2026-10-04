-- The data ЕИС «Электронная путёвка» requires for every tourist (ПП РФ №417, ред. 17.04.2026), and the
-- per-order Заявка на бронирование that, with the offer, is the contract (Linear ART-47, 2026-10-04).
--
-- Every tourist: full name, date of birth, citizenship, and the identity document's type, series
-- (where it has one) and number. Nothing else: no issue date, issuer, division code, address or
-- scan. Adults only in v1, so no birth certificates.
--   RU_PASSPORT                Russian internal passport: series 4 digits, number 6 digits
--   RU_INTERNATIONAL_PASSPORT  Russian international passport: series 2 digits, number 7 digits
--   FOREIGN_DOCUMENT           a foreign citizen's document: series optional, Latin letters and digits

ALTER TABLE order_passenger
  ADD COLUMN citizenship     text NOT NULL CHECK (citizenship ~ '^[A-Z]{2}$'),
  ADD COLUMN document_type   text NOT NULL CHECK (document_type IN ('RU_PASSPORT', 'RU_INTERNATIONAL_PASSPORT', 'FOREIGN_DOCUMENT')),
  ADD COLUMN document_series text,
  ADD COLUMN document_number text NOT NULL,
  ALTER COLUMN date_of_birth SET NOT NULL,
  ADD CONSTRAINT order_passenger_document CHECK (
       (document_type = 'RU_PASSPORT' AND citizenship = 'RU'
          AND document_series ~ '^[0-9]{4}$' AND document_number ~ '^[0-9]{6}$')
    OR (document_type = 'RU_INTERNATIONAL_PASSPORT' AND citizenship = 'RU'
          AND document_series ~ '^[0-9]{2}$' AND document_number ~ '^[0-9]{7}$')
    OR (document_type = 'FOREIGN_DOCUMENT' AND citizenship <> 'RU'
          AND (document_series IS NULL OR document_series ~ '^[0-9A-Z]{1,10}$') AND document_number ~ '^[0-9A-Z]{1,20}$'));

ALTER TABLE order_contact
  ADD COLUMN customer_is_tourist boolean NOT NULL DEFAULT false;

-- The Заявка shown to the customer before paying, exactly as shown. It names the tourists, so its
-- content is personal data: erased with the rest of it; the hash stays and is what the contract
-- hash sent to Refref (legalReleaseHash) was computed from.
CREATE TABLE order_document (
  order_id   uuid NOT NULL REFERENCES orders(id),
  kind       text NOT NULL CHECK (kind = 'ZAYAVKA'),
  content    text,
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (order_id, kind)
);

-- Once the customer has chosen to pay, the Заявка is the contract: it never changes again. Only its
-- erasure (content to NULL, the hash kept) is allowed after that.
CREATE FUNCTION fn_order_document_frozen() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF (SELECT status FROM orders WHERE id = NEW.order_id) <> 'RESERVED'
     AND NOT (NEW.content IS NULL AND NEW.sha256 = OLD.sha256 AND NEW.created_at = OLD.created_at) THEN
    RAISE EXCEPTION 'ORDER_DOCUMENT_FROZEN' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER trg_order_document_frozen BEFORE UPDATE ON order_document
  FOR EACH ROW EXECUTE FUNCTION fn_order_document_frozen();

REVOKE ALL ON order_document FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON order_document TO commerce_app;
