# Retry-safe payments endpoint: NestJS + TypeScript

One write endpoint that is safe to call twice. `POST /payments` with an
`Idempotency-Key` header returns the same payment for the same key, forever,
no matter how many callers arrive at once or which instance they land on.

## Architecture

Two identical API instances sit behind nginx and share one Postgres. Nothing
is shared between the processes except the database index, which is the whole
point: if a single process were serving every request, a reviewer could
reasonably ask whether some in-process lock was doing the work.

```mermaid
flowchart LR
    subgraph browser["Browser"]
        UI["Lab UI<br/>frontend/app/page.tsx"]
    end

    subgraph next["Next.js 16"]
        RH["Route handlers<br/>frontend/app/api/*"]
    end

    subgraph edge["Load balancer"]
        NX["nginx :8080<br/>round robin"]
    end

    subgraph app["Application tier"]
        A1["api-1<br/>NestJS + Fastify"]
        A2["api-2<br/>NestJS + Fastify"]
    end

    subgraph data["Data tier"]
        PG[("Postgres 16")]
        IDX{{"PRIMARY KEY on<br/>idempotency_keys.key"}}
    end

    PROOF["Proof harness<br/>backend/proof/proof.ts"]

    UI -->|"/api/pay, /api/burst"| RH
    RH -->|"N concurrent POSTs"| NX
    PROOF -->|"N concurrent POSTs"| NX
    RH -.->|"NDJSON stream"| UI

    NX --> A1
    NX --> A2
    A1 -->|"pool max 20"| PG
    A2 -->|"pool max 20"| PG
    PG --- IDX
    RH -.->|"GET /healthz on :8081, :8082"| A1
    RH -.-> A2
    RH -->|"read-only SELECT"| PG
    PROOF -->|"SELECT count for ground truth"| PG

    style IDX fill:#1f4e79,color:#ffffff
    style PROOF fill:#e4e7e3,color:#111111
```

The blue box is the only thing arbitrating anything. Both API processes are
stateless and interchangeable.

## The mechanism

`idempotency_keys.key` is a PRIMARY KEY. The service does not ask whether the
key exists. It inserts, and reads the conflict as its answer:

```ts
const claimed = await tx
  .insert(idempotencyKeys)
  .values({ key, requestHash: hash, status: "in_progress" })
  .onConflictDoNothing({ target: idempotencyKeys.key })
  .returning({ key: idempotencyKeys.key });
```

Zero rows back means someone else owns the key. One row back means you won and
may write the payment. **The claim and the payment insert commit in the same
transaction**, so there is never a key without its payment or a payment
without its key.

`onConflictDoNothing` is load-bearing. Unlike `DO UPDATE`, it does not block on
a conflicting uncommitted row; it returns immediately. At 500 concurrent that
is the difference between 499 losers releasing their connection in microseconds
and 499 losers queueing behind the winner until the pool is exhausted.

### The winner

One transaction covers the claim and the write, so both become visible in the
same instant.

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant API as api-1
    participant PG as Postgres

    C->>API: POST /payments<br/>Idempotency-Key: k1
    API->>PG: BEGIN
    API->>PG: INSERT idempotency_keys k1 in_progress<br/>ON CONFLICT DO NOTHING RETURNING key
    PG-->>API: 1 row, claim won
    API->>PG: INSERT payments
    API->>PG: UPDATE key to completed<br/>with the exact response bytes
    API->>PG: COMMIT
    Note over PG: Payment and key<br/>become visible together
    API-->>C: 201, Idempotency-Replayed: false
```

### The losers

Two distinct loser paths, depending on whether the winner has committed yet.
The second one is the branch most implementations get wrong.

```mermaid
sequenceDiagram
    autonumber
    participant C2 as Client B
    participant API as api-2
    participant PG as Postgres

    rect rgb(233, 238, 233)
    Note over C2,PG: Case 1. Winner already committed
    C2->>API: POST /payments, key k1
    API->>PG: INSERT ... ON CONFLICT DO NOTHING
    PG-->>API: 0 rows
    API->>PG: SELECT status, response_body WHERE key = k1
    PG-->>API: completed, stored bytes
    API-->>C2: 201, Idempotency-Replayed: true
    end

    rect rgb(245, 235, 234)
    Note over C2,PG: Case 2. Winner still uncommitted
    C2->>API: POST /payments, key k1
    API->>PG: INSERT ... ON CONFLICT DO NOTHING
    PG-->>API: 0 rows, no blocking
    API->>PG: SELECT ... WHERE key = k1
    PG-->>API: no rows, the claim is invisible
    API-->>C2: 409, Retry-After 1
    Note over C2: Retries and lands in Case 1
    end
```

## Response contract

| Situation | Status | Headers |
|---|---|---|
| First call | `201` | `Idempotency-Replayed: false` |
| Repeat after the winner committed | `201` | `Idempotency-Replayed: true` |
| Repeat while the winner is still in flight | `409` | `Retry-After: 1` |
| Same key, different body | `422` | none |
| No `Idempotency-Key` header | `400` | none |
| Body fails validation | `400` | none |

The `409` is the branch most implementations get wrong. When a duplicate
arrives before the winner commits, the key row is claimed but invisible, so
there is no stored response to replay. Returning `200` with an empty body there
is a data-loss bug wearing a success code.

Every branch above, in one picture. Validation runs before the handler body,
because NestJS applies pipes while resolving parameters, so a malformed body
is rejected before the missing-header check is ever reached.

```mermaid
flowchart TD
    START["POST /payments"] --> VALID{"body passes<br/>ValidationPipe?"}
    VALID -->|no| E400A["400<br/>invalid payload"]
    VALID -->|yes| HDR{"Idempotency-Key<br/>present?"}
    HDR -->|no| E400B["400<br/>missing header"]
    HDR -->|yes| CLAIM["INSERT key<br/>ON CONFLICT DO NOTHING"]

    CLAIM --> WON{"row returned?"}
    WON -->|yes| WRITE["INSERT payment<br/>store response bytes<br/>COMMIT"]
    WRITE --> R201["201<br/>Replayed: false"]

    WON -->|no| READ["SELECT the key row,<br/>outside the transaction"]
    READ --> VIS{"row visible?"}
    VIS -->|no| C409["409, Retry-After 1<br/>winner uncommitted"]
    VIS -->|yes| HASH{"request hash<br/>matches?"}
    HASH -->|no| E422["422<br/>key reused with<br/>a different payload"]
    HASH -->|yes| ST{"status?"}
    ST -->|in_progress| C409
    ST -->|completed| R201R["201<br/>Replayed: true<br/>stored bytes"]

    style R201 fill:#1f4e79,color:#ffffff
    style R201R fill:#7b8a82,color:#ffffff
    style C409 fill:#e4e7e3,color:#111111
```

## Key lifecycle

```mermaid
stateDiagram-v2
    [*] --> in_progress: claim wins the insert
    in_progress --> completed: payment written,<br/>response stored, COMMIT
    in_progress --> [*]: transaction rolls back,<br/>key and payment vanish together
    completed --> [*]: reaped after expires_at

    note right of in_progress
        Invisible to other transactions.
        Duplicates arriving here get 409.
    end note

    note right of completed
        Response bytes are stored, not
        regenerated. Every replay is
        byte identical.
    end note
```

There is no failed state. A crash mid-write rolls back the claim along with
the payment, which frees the key rather than poisoning it.

## Schema

```mermaid
erDiagram
    IDEMPOTENCY_KEYS ||--o| PAYMENTS : "claims, then creates"

    IDEMPOTENCY_KEYS {
        text key PK "the arbiter"
        text request_hash "sha256 hex of the raw body"
        text status "in_progress or completed"
        int response_code
        text response_body "exact bytes to replay"
        timestamptz created_at
        timestamptz expires_at
    }

    PAYMENTS {
        uuid id PK
        text idempotency_key "indexed, deliberately NOT unique"
        bigint amount
        text currency
        text reference
        timestamptz created_at
    }
```

`response_body` is `text`, not `jsonb`. Postgres normalises jsonb, so key order
and whitespace are not preserved, and a replay would return different bytes
than the original response for an equal value. Idempotency is a promise about
bytes.

`payments.idempotency_key` is left unconstrained on purpose. If both tables
enforced uniqueness, the proof could not tell which mechanism stopped the
duplicate.

## Layout

```
backend/
├── src/
│   ├── main.ts                    Fastify adapter, rawBody, validation, shutdown hooks
│   ├── app.module.ts
│   ├── db/
│   │   ├── schema.ts              Drizzle tables, where the PRIMARY KEY lives
│   │   └── db.module.ts           pool, boot-time migration, graceful close
│   ├── payments/
│   │   ├── payments.service.ts    the claim. read this one.
│   │   ├── payments.controller.ts HTTP mapping only, no logic
│   │   ├── idempotency.types.ts   Outcome union
│   │   └── dto/create-payment.dto.ts
│   └── health/health.controller.ts
├── proof/proof.ts                 500 concurrent callers, one key, DB assertions
└── migrations/0001_schema.sql
frontend/                         Next.js lab; AGENT.md is its integration spec
docs/DIAGRAMS.md                  every diagram, including deployment
```

`payments.service.ts` is the only interesting file. Everything else is
transport, wiring, or measurement.

## Running it

```bash
cd backend && npm install
make up          # postgres + two API instances + nginx on :8080
make proof       # 500 concurrent requests, one key
make lab         # the interactive lab on :3000
```

`make up`, `make down`, `make proof`, and `make lab` run from the repo root.
The `Makefile` and `docker-compose.yml` there orchestrate `backend/` and
`frontend/`.

Expected:

```
payment rows created  1
HTTP 201 created      1
HTTP replays          499
distinct bodies       1
served by             api-1=251  api-2=249

[PASS] exactly one payment row       1
[PASS] exactly one 201 created       1
[PASS] all others replayed           499
[PASS] one distinct response body    1
[PASS] no errors                     0
[PASS] no unresolved conflicts       0
```

## The naive version

```bash
git checkout v0-naive
make down && make up && make proof
```

`v0-naive` drops the primary key and does the obvious thing: `SELECT` the key,
insert if missing. It passes every sequential test and produces something like
17 payment rows under concurrency.

```mermaid
sequenceDiagram
    autonumber
    participant A as Client A
    participant B as Client B
    participant PG as Postgres

    A->>PG: SELECT WHERE key = k1
    B->>PG: SELECT WHERE key = k1
    PG-->>A: no rows
    PG-->>B: no rows
    Note over A,B: Both checks were correct<br/>about a past that already expired
    A->>PG: INSERT payment pay_aaa
    B->>PG: INSERT payment pay_bbb
    A->>PG: COMMIT
    B->>PG: COMMIT
    Note over PG: Two payments, one key
```

Under `READ COMMITTED`, each transaction's `SELECT` sees a snapshot taken when
that statement began. Every request that checks before any of them commits
sees an empty table, and every one of them inserts. The check is not wrong
about the past; it is answering a question whose answer expires before it can
be acted on.

`make down` between tags is not optional. The schemas differ and
`IF NOT EXISTS` will leave the old table in place, so you would be testing new
code against old constraints.

The whole fix:

```bash
git diff v0-naive v1-idempotent -- backend/migrations backend/src
```

## The lab

`frontend/` is a Next.js 16 teaching lab. Left pane is what a customer could
know; right pane is every request that was really sent and the rows really in
Postgres. Five scenarios: a normal payment, a lost response, a triple click, an
instance dying mid-checkout, and the 500-caller burst.

It speaks HTTP to `:8080` for payments, polls `:8081` and `:8082` for
instance health, and reads the two tables through a read-only connection. The
backend language is invisible to it, which is a reasonable argument that the
API contract is the real interface.

```bash
make up
make lab         # http://localhost:3000
```

For scenario 4, run `docker compose stop api-1` yourself, then
`docker compose start api-1`. There is deliberately no button for it.
[`frontend/AGENT.md`](frontend/AGENT.md) has the full contract, invariants,
and a verification checklist.

The fan-out runs server-side in a route handler. Chrome opens about six
connections per host, so a browser-side burst would serialise itself and pass
even against `v0-naive`.

## Housekeeping

Rows are stamped with `expires_at` (24h). Reap them or the table grows forever:

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

Reap only `completed` rows. An `in_progress` row cannot survive a crash.
Because the claim and the write share a transaction, the rollback takes it
with the payment. If you ever see a stale one, the transaction boundary has
been broken somewhere.

## Known edges

- **Request hashing** is `sha256` over the raw bytes, so a client sending
  semantically identical but differently formatted JSON gets a `422`.
  Canonicalise first if your clients are not byte-stable.
- **Key reuse cannot be detected during the in-flight window.** The winner's
  row is invisible, so a mismatched payload gets `409`, then `422` on retry.
- **Keys are global.** Before this goes near real money, scope them per API
  client, or two customers can collide.
- **No read replica.** A standby serving replays can miss a commit that
  already landed on the primary and return `404` for a payment that exists. If
  you add one, capture `pg_current_wal_insert_lsn()` on commit and have the
  replica path wait on `pg_last_wal_replay_lsn()`.

## More diagrams

[`docs/DIAGRAMS.md`](docs/DIAGRAMS.md) has the full set, including the
deployment topology, the console's streaming data flow, and the repository
history.
