# Diagrams

Every diagram below is Mermaid and renders directly on GitHub, GitLab, Notion,
and Obsidian. No image files to keep in sync with the code.

---

## 1. System architecture

Where each process lives and what it is allowed to talk to. The console never
reaches the Go API directly; the harness is the only thing with a database
connection besides the API itself.

```mermaid
flowchart LR
    subgraph browser["Browser"]
        UI["Console UI<br/>app/page.tsx"]
    end

    subgraph next["Next.js 16"]
        RH["Burst route handler<br/>app/api/burst/route.ts"]
    end

    subgraph edge["Load balancer"]
        NX["nginx :8080<br/>round robin"]
    end

    subgraph app["Application tier"]
        A1["api-1<br/>Go"]
        A2["api-2<br/>Go"]
    end

    subgraph data["Data tier"]
        PG[("Postgres")]
        IDX{{"PRIMARY KEY on<br/>idempotency_keys.key"}}
    end

    PROOF["Proof harness<br/>cmd/proof"]

    UI -->|"POST /api/burst"| RH
    RH -->|"N concurrent POSTs"| NX
    PROOF -->|"N concurrent POSTs"| NX
    RH -.->|"NDJSON stream"| UI

    NX --> A1
    NX --> A2
    A1 --> PG
    A2 --> PG
    PG --- IDX
    PROOF -->|"SELECT count for ground truth"| PG

    style IDX fill:#1f4e79,color:#ffffff
    style PROOF fill:#e4e7e3
```

The blue box is the only thing arbitrating anything. Both API processes are
stateless and interchangeable; that is the point of running two.

---

## 2. Request lifecycle, the winner

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
    API->>PG: UPDATE key to completed with stored body
    API->>PG: COMMIT
    Note over PG: Payment and key<br/>become visible together
    API-->>C: 201, Idempotency-Replayed: false
```

---

## 3. Request lifecycle, the losers

Two distinct loser paths depending on whether the winner has committed yet.
The second one is the branch most implementations get wrong.

```mermaid
sequenceDiagram
    autonumber
    participant C2 as Client B
    participant API as api-2
    participant PG as Postgres

    rect rgb(233, 238, 233)
    Note over C2,PG: Case 1 — winner already committed
    C2->>API: POST /payments, key k1
    API->>PG: INSERT ... ON CONFLICT DO NOTHING
    PG-->>API: 0 rows
    API->>PG: SELECT status, response_body WHERE key = k1
    PG-->>API: completed, stored bytes
    API-->>C2: 201, Idempotency-Replayed: true
    end

    rect rgb(245, 235, 234)
    Note over C2,PG: Case 2 — winner still uncommitted
    C2->>API: POST /payments, key k1
    API->>PG: INSERT ... ON CONFLICT DO NOTHING
    PG-->>API: 0 rows, no blocking
    API->>PG: SELECT ... WHERE key = k1
    PG-->>API: no rows, the claim is invisible
    API-->>C2: 409, Retry-After 1
    Note over C2: Retries and lands in Case 1
    end
```

`ON CONFLICT DO NOTHING` returning immediately instead of blocking is what
keeps 499 losers from holding connections until the winner commits.

---

## 4. The naive race

Same picture, minus the index. Every transaction reads an empty table and every
one of them writes.

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

---

## 5. Idempotency key state machine

```mermaid
stateDiagram-v2
    [*] --> in_progress: claim wins the insert
    in_progress --> completed: payment written, response stored, COMMIT
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

There is no failed state. A crash mid-write rolls back the claim along with the
payment, which frees the key rather than poisoning it.

---

## 6. Handler decision tree

```mermaid
flowchart TD
    START["POST /payments"] --> HDR{"Idempotency-Key<br/>present?"}
    HDR -->|no| E400["400 missing header"]
    HDR -->|yes| VALID{"body parses and<br/>amount is positive?"}
    VALID -->|no| E422A["422 invalid payload"]
    VALID -->|yes| CLAIM["INSERT key<br/>ON CONFLICT DO NOTHING"]

    CLAIM --> WON{"row returned?"}
    WON -->|yes| WRITE["INSERT payment<br/>store response<br/>COMMIT"]
    WRITE --> R201["201 Replayed false"]

    WON -->|no| READ["SELECT the key row"]
    READ --> VIS{"row visible?"}
    VIS -->|no| C409["409 Retry-After<br/>winner uncommitted"]
    VIS -->|yes| HASH{"request hash<br/>matches?"}
    HASH -->|no| E422B["422 key reused<br/>with different payload"]
    HASH -->|yes| ST{"status?"}
    ST -->|in_progress| C409
    ST -->|completed| R200["201 Replayed true<br/>stored bytes"]

    style R201 fill:#1f4e79,color:#ffffff
    style R200 fill:#7b8a82,color:#ffffff
    style C409 fill:#e4e7e3
```

---

## 7. Schema

```mermaid
erDiagram
    IDEMPOTENCY_KEYS ||--o| PAYMENTS : "claims, then creates"

    IDEMPOTENCY_KEYS {
        text key PK "the arbiter"
        bytea request_hash "sha256 of raw body"
        text status "in_progress or completed"
        int response_code
        jsonb response_body "exact bytes to replay"
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

`payments.idempotency_key` is left unconstrained on purpose. If both tables
enforced uniqueness, the proof could not tell which mechanism stopped the
duplicate.

---

## 8. Console data flow

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant UI as Console
    participant RH as Route handler
    participant LB as nginx
    participant API as api-1 and api-2

    U->>UI: Send the burst
    UI->>RH: POST /api/burst with n and key
    RH->>RH: Build all N requests, hold behind one gate
    RH->>RH: Release the gate
    par N concurrent
        RH->>LB: POST /payments
        LB->>API: round robin
        API-->>RH: 201 or 409
    end
    loop as each result lands
        RH-->>UI: NDJSON line
        UI->>UI: Queue, paint once per frame
    end
    RH-->>UI: done summary
    UI->>U: Grid, counts, verdicts
```

Requests are constructed before any are released. Building them inside the loop
would stagger the start by however long construction takes, which is the same
order of magnitude as the window being tested.

---

## 9. Deployment

```mermaid
flowchart TB
    subgraph host["Docker host"]
        subgraph net["compose network"]
            LB["lb<br/>nginx:1.27-alpine<br/>published :8080"]
            A1["api-1<br/>INSTANCE_ID=api-1"]
            A2["api-2<br/>INSTANCE_ID=api-2"]
            DB[("db<br/>postgres:16-alpine<br/>max_connections=200")]
        end
    end

    DEV["npm run dev<br/>:3000"]

    DEV --> LB
    LB --> A1
    LB --> A2
    A1 -->|"pool max 20"| DB
    A2 -->|"pool max 20"| DB

    A1 -.->|"healthcheck gate"| DB
    A2 -.->|"healthcheck gate"| DB
```

Pool size is deliberately far below the burst size. Losers must release their
connection immediately, or the experiment measures queueing instead of
correctness.

---

## 10. Repository history

```mermaid
gitGraph
    commit id: "naive" tag: "v0-naive"
    commit id: "fix" tag: "v1-idempotent"
    commit id: "console" tag: "v2-console"
```

The diff worth reading:

```bash
git diff v0-naive v1-idempotent -- migrations internal/store
```

Three files, and only one idea: stop asking the database a question whose
answer expires before you can act on it.
