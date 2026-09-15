-- v0-naive schema. Applied on boot by every instance, so every statement is
-- IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS payments (
    id              uuid        PRIMARY KEY,
    idempotency_key text        NOT NULL,
    amount          bigint      NOT NULL,
    currency        text        NOT NULL,
    reference       text        NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_idem_key_idx ON payments (idempotency_key);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key           text        NOT NULL,
    request_hash  text        NOT NULL,
    status        text        NOT NULL,
    response_code int,
    response_body text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idempotency_keys_key_idx ON idempotency_keys (key);
