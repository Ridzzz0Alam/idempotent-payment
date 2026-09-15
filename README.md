# Retry-safe payments endpoint — NestJS + TypeScript

One write endpoint that is safe to call twice. `POST /payments` with an
`Idempotency-Key` header returns the same payment for the same key, forever,
no matter how many callers arrive at once or which instance they land on.

## The mechanism

`idempotency_keys.key` is a PRIMARY KEY. The service does not ask whether the
key exists — it inserts, and reads the conflict as its answer:

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
a conflicting uncommitted row — it returns immediately. At 500 concurrent that
is the difference between 499 losers releasing their connection in microseconds
and 499 losers queueing behind the winner until the pool is exhausted.

## Response contract

| Situation | Status | Headers |
|---|---|---|
| First call | `201` | `Idempotency-Replayed: false` |
| Repeat after the winner committed | `201` | `Idempotency-Replayed: true` |
| Repeat while the winner is still in flight | `409` | `Retry-After: 1` |
| Same key, different body | `422` | — |
| No `Idempotency-Key` header | `400` | — |

The `409` is the branch most implementations get wrong. When a duplicate
arrives before the winner commits, the key row is claimed but invisible, so
there is no stored response to replay. Returning `200` with an empty body there
is a data-loss bug wearing a success code.

## Layout

```
src/
├── main.ts                    Fastify adapter, rawBody, validation, shutdown hooks
├── app.module.ts
├── db/
│   ├── schema.ts              Drizzle tables — the PRIMARY KEY lives here
│   └── db.module.ts           pool, boot-time migration, graceful close
├── payments/
│   ├── payments.service.ts    ← the claim. read this one.
│   ├── payments.controller.ts HTTP mapping only, no logic
│   ├── idempotency.types.ts   Outcome union
│   └── dto/create-payment.dto.ts
└── health/health.controller.ts
proof/proof.ts                 500 concurrent callers, one key, DB assertions
web/                           Next.js console (unchanged from the Go build)
```

`payments.service.ts` is the only interesting file. Everything else is
transport, wiring, or measurement.

## Running it

```bash
npm install
make up          # postgres + two API instances + nginx on :8080
make proof       # 500 concurrent requests, one key
```

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

Two instances share one Postgres on purpose. If all 500 requests hit a single
process, a reviewer can reasonably ask whether some in-process lock is doing
the work. Splitting them across instances rules that out: the only thing both
processes share is the index.

## The naive version

```bash
git checkout v0-naive
make down && make up && make proof
```

`v0-naive` drops the primary key and does the obvious thing — `SELECT` the
key, insert if missing. It passes every sequential test and produces something
like 17 payment rows under concurrency.

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
git diff v0-naive v1-idempotent -- migrations src
```

## The console

`web/` is the Next.js 16 console, carried over from the Go build **with no
changes**. It only ever speaks HTTP to `:8080`, so the backend language is
invisible to it — which is a reasonable argument that the API contract is the
real interface.

```bash
cd web && npm install
IDEM_API_URL=http://localhost:8080 npm run dev
```

The fan-out runs server-side in a route handler. Chrome opens about six
connections per host, so a browser-side burst would serialise itself and pass
even against `v0-naive`.

## Housekeeping

Rows are stamped with `expires_at` (24h). Reap them or the table grows forever:

```sql
DELETE FROM idempotency_keys WHERE expires_at < now();
```

Reap only `completed` rows. An `in_progress` row cannot survive a crash —
because the claim and the write share a transaction, the rollback takes it
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
