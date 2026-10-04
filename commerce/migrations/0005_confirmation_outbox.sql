-- ART-47 slice 3c: the exact offer shown with the order and a small transactional-email outbox.

-- Existing pre-launch rows cannot be reconstructed from today's public page. They deliberately
-- remain NULL and therefore fail closed at payment; every new reservation stores the exact text.
ALTER TABLE orders
  ADD COLUMN legal_release_content text,
  ADD COLUMN document_access_hash text UNIQUE CHECK (document_access_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT orders_legal_release_content CHECK (
    legal_release_content IS NULL OR length(legal_release_content) > 0);

CREATE TABLE email_outbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id           uuid NOT NULL REFERENCES orders(id),
  type               text NOT NULL CHECK (type = 'BOOKING_CONFIRMATION'),
  recipient_email    text,
  access_token       text CHECK (access_token IS NULL OR access_token ~ '^[A-Za-z0-9_-]{43}$'),
  idempotency_key    text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 64),
  state              text NOT NULL CHECK (state IN ('PENDING','SENDING','ACCEPTED','ATTENTION')),
  provider_job_id    text,
  attempts           int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  first_attempt_at   timestamptz,
  next_attempt_at    timestamptz NOT NULL,
  lease_until        timestamptz,
  last_error_code    text CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{1,60}$'),
  created_at         timestamptz NOT NULL,
  sent_at            timestamptz,
  UNIQUE (order_id, type),
  CHECK ((attempts = 0) = (first_attempt_at IS NULL)),
  CHECK ((state = 'ACCEPTED') = (provider_job_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK (state NOT IN ('PENDING','SENDING') OR access_token IS NOT NULL),
  CHECK (state <> 'SENDING' OR lease_until IS NOT NULL)
);
CREATE INDEX email_outbox_due ON email_outbox (next_attempt_at)
  WHERE state IN ('PENDING','SENDING');

REVOKE ALL ON email_outbox FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON email_outbox TO commerce_app;
