-- The Refref checkout of an order (ART-47 slice 2; refref docs/28): what Refref resolved, the frozen
-- snapshot both parties hash, the one checkout attempt, and what Refref's read-back said.
--
--   RESERVED + resolution   the customer has seen the final price and may pay
--   PAYMENT_PENDING         the snapshot is frozen; the attempt exists or is being created with one
--                           fixed Idempotency-Key. Never a second attempt for an order.
--   PAID                    Refref's read-back: the obligation SATISFIED by a SUCCEEDED Payment of
--                           exactly the payable amount. Never the browser's return.
--   FULFILLED               the booking is confirmed and Refref has the fulfillment acknowledgement
--   HELD                    something only a person may resolve (hold_reason); seats stay taken
--   CANCELLED               Refref confirmed the attempt can no longer settle, or no attempt was
--                           ever created; seats free

ALTER TABLE orders
  ADD COLUMN state_hash             text CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN referral_resolution_id uuid,
  ADD COLUMN terms_version_id       uuid,
  ADD COLUMN attribution_source     text,
  ADD COLUMN resolution_expires_at  timestamptz,
  ADD COLUMN discount_kopecks       bigint CHECK (discount_kopecks >= 0),
  ADD COLUMN payable_kopecks        bigint CHECK (payable_kopecks > 0),
  ADD COLUMN snapshot               jsonb,
  ADD COLUMN snapshot_hash          text CHECK (snapshot_hash ~ '^refref-jcs-1:[0-9a-f]{64}$'),
  ADD COLUMN payment_pending_since  timestamptz,
  ADD COLUMN checkout_attempt_id    uuid UNIQUE,
  ADD COLUMN last_session           text CHECK (last_session ~ '^[A-Z_:]{1,60}$'),
  ADD COLUMN payment_id             uuid UNIQUE,
  ADD COLUMN paid_at                timestamptz,
  ADD COLUMN fulfilled_at           timestamptz,
  ADD COLUMN last_reconciled_at     timestamptz,
  ADD COLUMN hold_reason            text CHECK (hold_reason ~ '^[A-Z_:0-9]{1,80}$'),
  ADD CONSTRAINT orders_resolution_whole CHECK (
    (referral_resolution_id IS NULL) = (resolution_expires_at IS NULL)
    AND (referral_resolution_id IS NULL) = (discount_kopecks IS NULL)
    AND (referral_resolution_id IS NULL) = (payable_kopecks IS NULL)),
  ADD CONSTRAINT orders_payable CHECK (payable_kopecks IS NULL OR payable_kopecks = amount_kopecks - discount_kopecks),
  ADD CONSTRAINT orders_frozen CHECK (
    status IN ('RESERVED', 'EXPIRED')
    OR (status = 'CANCELLED' AND snapshot IS NULL)
    OR (snapshot IS NOT NULL AND snapshot_hash IS NOT NULL AND payment_pending_since IS NOT NULL)),
  ADD CONSTRAINT orders_paid CHECK (status NOT IN ('PAID', 'FULFILLED') OR (payment_id IS NOT NULL AND paid_at IS NOT NULL)),
  ADD CONSTRAINT orders_fulfilled CHECK ((status = 'FULFILLED') = (fulfilled_at IS NOT NULL) OR status = 'REFUNDED'),
  ADD CONSTRAINT orders_held CHECK ((status = 'HELD') = (hold_reason IS NOT NULL));

CREATE INDEX orders_payment_pending ON orders (payment_pending_since) WHERE status IN ('PAYMENT_PENDING', 'PAID');
