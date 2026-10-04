-- mikluha-commerce: orders, seats, the personal data they need, and the booking switch
-- (docs/DECISIONS.md #9, Linear ART-47 owner decisions of 2026-10-04).
--
-- Personal data lives ONLY in order_contact and order_passenger, so erasing it is deleting rows:
-- `orders` keeps what explains money and capacity (departure, seats, amounts, states, the accepted
-- terms) and nothing that identifies a person.
--
-- Run by the database owner. The service connects as a login role that is a member of
-- commerce_app (commerce/README.md): it reads and writes orders, deletes personal data, and changes
-- the booking switch only through fn_set_sales_open, which records who and why.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commerce_app') THEN
    CREATE ROLE commerce_app NOLOGIN;
  END IF;
END $$;

-- One row: are new bookings and payments accepted? Closed until an operator opens it.
CREATE TABLE sales_switch (
  singleton  boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  open       boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL,
  reason     text NOT NULL
);
INSERT INTO sales_switch VALUES (true, false, now(), 'migration', 'initial state: closed');

CREATE TABLE sales_switch_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  open       boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  changed_by text NOT NULL CHECK (length(changed_by) BETWEEN 1 AND 100),
  reason     text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500)
);

CREATE FUNCTION fn_set_sales_open(p_open boolean, p_by text, p_reason text)
RETURNS void SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
BEGIN
  INSERT INTO sales_switch_event (open, changed_at, changed_by, reason) VALUES (p_open, now(), p_by, p_reason);
  UPDATE sales_switch SET open = p_open, changed_at = now(), changed_by = p_by, reason = p_reason;
END $fn$ LANGUAGE plpgsql;

-- Read by every sale in its own transaction, holding a share lock to the end of it: a sale and a
-- change of the switch never interleave, so once a close commits no later sale can commit.
CREATE FUNCTION fn_sales_open_for_sale()
RETURNS boolean VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $fn$
  SELECT open FROM sales_switch FOR SHARE
$fn$ LANGUAGE sql;

-- RESERVED         seats held until reserved_until; nothing sent to Refref yet
-- PAYMENT_PENDING  a checkout attempt exists: the seats stay taken until Refref's read-back says
--                  how it ended, however long that takes (never resold on a timer)
-- PAID / FULFILLED an accepted payment; fulfilled once confirmed to the customer
-- HELD             needs a person (an ambiguous outcome after expiry): seats stay taken
-- EXPIRED / CANCELLED  ended unpaid: seats free, personal data erased within 24 hours
-- REFUNDED         paid, then fully refunded
CREATE TABLE orders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_ref            text NOT NULL UNIQUE CHECK (order_ref ~ '^mk-[0-9a-z]{12}$'),
  departure_slug       text NOT NULL,
  trip_starts_on       date NOT NULL,
  trip_ends_on         date NOT NULL CHECK (trip_ends_on >= trip_starts_on),
  seats                int  NOT NULL CHECK (seats BETWEEN 1 AND 6),
  unit_price_kopecks   bigint NOT NULL CHECK (unit_price_kopecks > 0),
  amount_kopecks       bigint NOT NULL CHECK (amount_kopecks = unit_price_kopecks * seats),
  status               text NOT NULL CHECK (status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD',
                                                       'EXPIRED','CANCELLED','REFUNDED')),
  reserved_until       timestamptz NOT NULL,
  legal_release_ref    text NOT NULL,
  legal_release_hash   text NOT NULL CHECK (legal_release_hash ~ '^sha256:[0-9a-f]{64}$'),
  adults_only_confirmed boolean NOT NULL CHECK (adults_only_confirmed),
  created_at           timestamptz NOT NULL DEFAULT now(),
  closed_at            timestamptz,
  legal_hold           boolean NOT NULL DEFAULT false,
  legal_hold_reason    text,
  pd_erased_at         timestamptz,
  CHECK ((status IN ('EXPIRED','CANCELLED','REFUNDED')) = (closed_at IS NOT NULL)),
  CHECK (legal_hold = (legal_hold_reason IS NOT NULL))
);
CREATE INDEX orders_departure_taken ON orders (departure_slug)
  WHERE status IN ('RESERVED','PAYMENT_PENDING','PAID','FULFILLED','HELD');
CREATE INDEX orders_reserved_until ON orders (reserved_until) WHERE status = 'RESERVED';

CREATE TABLE order_contact (
  order_id  uuid PRIMARY KEY REFERENCES orders(id),
  full_name text NOT NULL,
  phone     text NOT NULL,
  email     text NOT NULL
);

CREATE TABLE order_passenger (
  order_id      uuid NOT NULL REFERENCES orders(id),
  position      int  NOT NULL CHECK (position BETWEEN 1 AND 6),
  full_name     text NOT NULL,
  date_of_birth date,
  PRIMARY KEY (order_id, position)
);

-- Every change of an order's state, for capacity and money questions later. No personal data.
CREATE TABLE order_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id),
  at         timestamptz NOT NULL DEFAULT now(),
  event      text NOT NULL CHECK (event ~ '^[A-Z_]{1,40}$'),
  detail     text CHECK (detail IS NULL OR detail ~ '^[A-Za-z0-9_:.-]{1,100}$')
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON FUNCTION fn_set_sales_open(boolean, text, text) FROM PUBLIC;
GRANT SELECT ON sales_switch, sales_switch_event TO commerce_app;
REVOKE ALL ON FUNCTION fn_sales_open_for_sale() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION fn_set_sales_open(boolean, text, text), fn_sales_open_for_sale() TO commerce_app;
GRANT SELECT, INSERT, UPDATE ON orders TO commerce_app;
GRANT SELECT, INSERT, DELETE ON order_contact, order_passenger TO commerce_app;
GRANT SELECT, INSERT ON order_event TO commerce_app;
GRANT SELECT ON schema_migrations TO commerce_app;
