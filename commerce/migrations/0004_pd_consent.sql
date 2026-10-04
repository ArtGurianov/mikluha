-- ART-47 slice 3b: personal-data consent is a separate versioned artifact attached to the order.
-- It is never part of legal_release_ref/hash (the tourism contract) and never sent to Refref.
-- The exact published text is retained so payment can verify that its hash still describes what
-- the booking form showed.

ALTER TABLE orders
  ADD COLUMN pd_consent_ref         text NOT NULL CHECK (length(pd_consent_ref) BETWEEN 1 AND 200),
  ADD COLUMN pd_consent_hash        text NOT NULL CHECK (pd_consent_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN pd_consent_content     text NOT NULL CHECK (length(pd_consent_content) > 0),
  ADD COLUMN pd_consent_accepted_at timestamptz NOT NULL;
