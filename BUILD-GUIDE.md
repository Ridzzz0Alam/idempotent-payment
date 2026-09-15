# NestJS build guide

Same system, TypeScript instead of Go. The schema, the nginx config, the
response contract, and the Next.js console are unchanged — only the service
layer was rewritten, which is the useful part of the exercise.

Versions: NestJS 12.0.1, Node 22, `pg` 8.13, Postgres 16.

## File order

Bottom-up, same reasoning as the Go version: write what has no dependencies
first so the compiler stays useful.

| # | File | Why here |
|---|---|---|
| 1 | `package.json`, `tsconfig.json`, `nest-cli.json` | `npm install` before anything imports |
| 2 | `migrations/001_schema.sql` | every type below mirrors it |
| 3 | `src/db/db.module.ts` | pool + migration runner, depends on nothing |
| 4 | `src/payments/dto.ts` | validation shape |
| 5 | `src/payments/payments.service.ts` | **the whole point** |
| 6 | `src/payments/payments.controller.ts` | needs the service's `Outcome` type |
| 7 | `src/app.module.ts` | wires 3, 5, 6 |
| 8 | `src/main.ts` | compiles |
| 9 | `Dockerfile`, `docker-compose.yml`, `deploy/nginx.conf`, `Makefile` | runs |
| 10 | `proof/proof.ts` | proves it |

Build the naive version first if you want the `v0-naive` tag: in step 3 drop
the `PRIMARY KEY` to a plain index, and in step 5 write `create()` as a
`SELECT` followed by an `INSERT`. Tag it, watch the proof fail, then fix both
files. Faking that history afterwards makes the diff worthless.

## Running it

```bash
npm install
make up          # postgres + two Nest instances + nginx on :8080
make proof       # 500 concurrent, one key
```

Manual check — run it twice:

```bash
curl -i -X POST localhost:8080/payments \
  -H 'Idempotency-Key: manual-1' -H 'Content-Type: application/json' \
  -d '{"amount":4200,"currency":"EUR","reference":"inv-1"}'
```

Second call: `Idempotency-Replayed: true`, identical body.

The console works unchanged. Point it at the same port:

```bash
cd ../web && IDEM_API_URL=http://localhost:8080 npm run dev
```

## What differs from the Go version

**Raw body capture.** `NestFactory.create(AppModule, { rawBody: true })` keeps
the original bytes on `req.rawBody`. The fingerprint must hash what the client
actually sent — hashing the re-serialised DTO gives different bytes for the
same request, so every legitimate retry would come back `422`. This is the
single easiest thing to get wrong in the port.

**Manual transaction handling.** Go's `defer tx.Rollback()` has no equivalent,
so the service uses `try/catch/finally` with an explicit `ROLLBACK` and
`client.release()`. The connection must be checked out of the pool once and all
four statements run on that same client; `pool.query()` picks an arbitrary
connection each call, which would scatter your transaction across connections
and silently break atomicity.

**Singleton service, on purpose.** Nest makes request-scoped providers easy,
and an in-memory cache or lock in `PaymentsService` would look like it was
helping. It would pass a single-instance test and fail the moment you run two.
Only the unique index arbitrates.

**`undici` agent in the harness.** Node pools connections per origin, so the
proof sets `new Agent({ connections: N })`. Without it the burst throttles
itself and the naive version can pass.

## What is identical

The SQL, on purpose. `INSERT ... ON CONFLICT (key) DO NOTHING RETURNING key`
inside one transaction, `DO NOTHING` rather than `DO UPDATE` so 499 losers do
not block against a pool of 20. Raw `pg` rather than Prisma or TypeORM keeps
that statement visible — an ORM would hide the one line the project exists to
demonstrate.

Response contract is unchanged: `201` + `Replayed: false` on first write,
`201` + `Replayed: true` on replay, `409` + `Retry-After` while the winner is
uncommitted, `422` on key reuse with a different payload.

## Where people get stuck

**Every retry returns 422.** `rawBody: true` is missing from the bootstrap, so
the hash is computed from the re-serialised DTO.

**`rowCount` is null, not 0.** `pg` types it `number | null`. Check
`=== 0`, not falsiness, or a legitimate claim reads as a conflict.

**Transaction appears not to roll back.** You used `this.pool.query()` somewhere
inside the transaction instead of the checked-out `client`.

**Proof passes against the naive build.** The `undici` agent is not widened, so
the requests queued instead of racing.
