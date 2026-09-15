-- Applied on boot by every instance (see migrate() in cmd/api/main.go), so
-- every statement is IF NOT EXISTS.
--
-- The only change that matters is on idempotency_keys.key: it is the PRIMARY
-- KEY. That index serialises concurrent writers. The application does not
-- decide who wins; the index does, atomically, because the claim is enforced
-- inside the same transaction as the payment write (see Store.Create in
-- internal/store/store.go).
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
    -- bytea, not text: Store.Create hashes the raw request body with
    -- sha256.Sum256 and inserts the digest bytes directly, no hex encoding.
    request_hash  bytea       NOT NULL,
    status        text        NOT NULL CHECK (status IN ('in_progress', 'completed')),
    response_code int,
    -- bytea, not text or jsonb. The exact bytes json.Marshal produced for the
    -- winner are stored so a replay returns them unchanged. jsonb in
    -- particular normalises key order and whitespace, which would make a
    -- replay byte-different from the original response for an equal value.
    response_body bytea,
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
