-- v1-idempotent schema. Applied on boot by every instance, so every statement
-- is IF NOT EXISTS.
--
-- The only change that matters is on idempotency_keys.key: it is now the
-- PRIMARY KEY. That index serialises concurrent writers. The application no
-- longer decides who wins; the index does, atomically, because it is enforced
-- inside the same transaction as the write.
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
    request_hash  text        NOT NULL,
    status        text        NOT NULL CHECK (status IN ('in_progress', 'completed')),
    response_code int,
    -- text, not jsonb. jsonb normalises key order and whitespace, so a replay
    -- would return different bytes than the original response even though the
    -- value is equal. Idempotency is a promise about bytes.
    response_body text,
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
