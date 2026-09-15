-- v1-idempotent schema.
--
-- The only change that matters is on idempotency_keys.key: it is now the
-- PRIMARY KEY. That single index is what serialises concurrent writers. The
-- application no longer decides who wins; the index does, and it does so
-- atomically because it is enforced inside the same transaction as the write.
--
-- payments is deliberately left WITHOUT a unique constraint on
-- idempotency_key. If both tables were constrained, the proof could not tell
-- which mechanism prevented the duplicate.

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
    key           text        PRIMARY KEY,
    request_hash  bytea       NOT NULL,
    status        text        NOT NULL CHECK (status IN ('in_progress', 'completed')),
    response_code int,
    response_body jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL DEFAULT now() + interval '24 hours',

    -- A completed row must carry a response to replay. Without this, a bug
    -- that forgets to store the body surfaces as an empty 201 to the client
    -- instead of as an error at write time.
    CONSTRAINT completed_has_response CHECK (
        status <> 'completed' OR (response_code IS NOT NULL AND response_body IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expires_idx ON idempotency_keys (expires_at);
