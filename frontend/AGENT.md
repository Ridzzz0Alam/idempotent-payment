# AGENT.md: integrating this frontend with a backend

This file is the complete spec for wiring `frontend/` to a payments API. An
agent should be able to read only this file and finish the job.

**What this is:** a Next.js 16 teaching lab for idempotent write endpoints. It
sends real requests to a real API and reads real rows from a real Postgres,
then shows the difference between what a customer could know and what actually
happened.

**What it is not:** a mock. Nothing in it simulates a backend. If the API is
not running, the lab shows errors rather than pretending.

---

## 1. Preconditions

The backend must already be running and must satisfy the contract in section 2.
It can be written in anything; the reference implementations are NestJS and
Go, and the frontend cannot tell them apart.

| Requirement | Value |
|---|---|
| Node | 20.11+ or 22+ |
| Backend reachable at | `IDEM_API_URL` (default `http://localhost:8080`) |
| Two instances reachable at | `API_1_URL`, `API_2_URL` |
| Postgres reachable at | `DATABASE_URL` |

The two-instance requirement is not decoration. Scenario 4 demonstrates that
correctness survives losing a server, which is unprovable with one instance.

---

## 2. The HTTP contract

The backend **must** implement these. Anything missing degrades a specific
feature, noted per row.

### `POST /payments`

Request:

```http
POST /payments
Content-Type: application/json
Idempotency-Key: <client-supplied string>

{ "amount": 4200, "currency": "EUR", "reference": "Order 7781" }
```

`amount` is an integer in minor units. The frontend divides by 100 for display.

Responses the frontend understands:

| Case | Status | Required headers | Body |
|---|---|---|---|
| First call for this key | `201` | `Idempotency-Replayed: false` | payment JSON |
| Repeat, winner committed | `201` | `Idempotency-Replayed: true` | byte-identical to the first |
| Repeat, winner in flight | `409` | `Retry-After` | any JSON |
| Key reused, different body | `422` | none | any JSON |
| Missing `Idempotency-Key` | `400` | none | any JSON |

Payment JSON must contain `payment_id`. Other fields are passed through and
displayed but not required:

```json
{
  "payment_id": "uuid",
  "amount": 4200,
  "currency": "EUR",
  "reference": "Order 7781",
  "status": "succeeded",
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

**Every response must carry `X-Served-By`** with the instance identity (e.g.
`api-1`). Without it the timeline and the failover scenario show `unknown` and
scenario 4 proves nothing.

### `GET /healthz`

Any `2xx`. Polled every 1.5s against each instance directly. Without it the
health strip reads permanently down.

---

## 3. Database schema the lab reads

The lab issues two `SELECT`s and never writes. It needs these columns to exist
with these names:

```sql
payments (
  id text|uuid,
  idempotency_key text,
  amount bigint,
  currency text,
  reference text,
  created_at timestamptz
)

idempotency_keys (
  key text,
  status text,
  response_code int,
  response_body text,   -- text, not jsonb; see section 8
  request_hash text,
  created_at timestamptz
)
```

Queries are in `app/api/ledger/route.ts`. If your column names differ, edit
that one file. It is the only place the frontend knows SQL.

Without `DATABASE_URL` the lab still runs; the right pane degrades to HTTP
responses only and says so.

---

## 4. Environment

`cp .env.example .env`, then:

```
IDEM_API_URL=http://localhost:8080   # through the load balancer
API_1_URL=http://localhost:8081      # instance 1, direct
API_2_URL=http://localhost:8082      # instance 2, direct
DATABASE_URL=postgres://user:pass@localhost:5432/dbname
```

These are read in `next.config.ts` **at build time**. Changing `.env` requires
restarting `npm run dev`. This trips people up.

The backend's compose file must publish per-instance ports. If it does not, add:

```yaml
api-1:
  ports: ["8081:8080"]
api-2:
  ports: ["8082:8080"]
```

`8080` stays on the load balancer. Normal traffic goes through it; the direct
ports exist for health polling only.

---

## 5. Install and run

```bash
cd frontend
cp .env.example .env     # then edit if your ports differ
npm install
npm run dev              # http://localhost:3000
```

Production:

```bash
npm run build && npm start
```

---

## 6. File map

```
frontend/
├── app/
│   ├── page.tsx                 lab shell, scenario state, layout
│   ├── layout.tsx               fonts
│   ├── globals.css              Tailwind v4 @theme tokens
│   └── api/
│       ├── pay/route.ts         1–10 attempts, sequential or concurrent
│       ├── burst/route.ts       N-way fan-out, streams NDJSON
│       ├── ledger/route.ts      read-only Postgres  ← edit if columns differ
│       └── instances/route.ts   health poll of both instances
├── components/
│   ├── Checkout.tsx             customer pane + request timeline
│   ├── Observatory.tsx          health strip + database ledger
│   └── BurstLab.tsx             500-cell grid
└── lib/
    ├── scenarios.ts             the five scenarios  ← edit to add one
    ├── types.ts                 shared shapes
    └── usePoll.ts               polling hook
```

Where to make common changes:

| Change | File |
|---|---|
| Different column names | `app/api/ledger/route.ts` |
| Different header names | `app/api/pay/route.ts` and `app/api/burst/route.ts` |
| Add or edit a scenario | `lib/scenarios.ts` |
| Colours, fonts | `app/globals.css` |
| Payment amount or reference | `app/page.tsx`, constants at the top |

---

## 7. Verification

Run in order. Each step assumes the previous passed.

- [ ] `GET http://localhost:3000` renders without console errors
- [ ] Health strip shows **api-1 up, api-2 up**
- [ ] Scenario 1 "One click, one payment" → confirmation, `payments` shows 1 row
- [ ] Scenario 2 "The response gets lost" → left pane reports no response after attempt 1, `payments` still shows 1 row, attempt 2 is marked replayed
- [ ] Scenario 3 "The impatient customer" → exactly 1 created, timeline bars visibly overlap, 1 row
- [ ] `docker compose stop api-1` → strip shows api-1 down within ~2s; scenario 4 → all requests served by `api-2`, still 1 row
- [ ] `docker compose start api-1` → strip returns to up
- [ ] Scenario 5 → 1 blue cell, the rest sage, all checks pass

If scenario 3 produces more than one blue, either the backend is on its naive
tag or the idempotency logic is broken. Both are worth knowing.

---

## 8. Invariants: do not "improve" these

These look like inefficiencies. They are load-bearing.

**The browser never calls the payments API directly.** Every request is fanned
out from a route handler on the Node side. Chrome opens about six connections
per host over HTTP/1.1, so a browser-side burst serialises itself into a queue
and passes even against a broken backend. Moving fetches into the client turns
the lab into a liar.

**Lost responses are hidden, not faked.** In scenario 2 the request is really
sent and really processed; only the reply is withheld from the customer pane.
Short-circuiting it client-side would make the timeline a drawing instead of a
record.

**There is no kill-server button.** Scenario 4 asks the user to run
`docker compose stop api-1` themselves. The lab cannot stop a container, and a
button that pretended to would undermine the only thing this project exists to
demonstrate. Do not add one.

**`response_body` must be `text`, not `jsonb`.** Postgres normalises jsonb:
key order and whitespace are not preserved. Stored as jsonb, a replay returns
different bytes than the original `201` for the same value, and the
byte-identity claim quietly becomes false.

**The database connection is read-only in practice.** The lab only `SELECT`s.
Do not add writes; the backend owns that table.

---

## 9. Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Health strip both down | per-instance ports not published | add `ports:` to compose, `docker compose up -d` |
| `served by: unknown` | backend omits `X-Served-By` | set the header on every response |
| Right pane says DATABASE_URL not set | env missing or dev server not restarted | set it, restart `npm run dev` |
| Ledger errors on column | schema differs | edit `app/api/ledger/route.ts` |
| Scenario 2 shows a confirmation on attempt 1 | `loseResponseOn` ignored | check the array reaches `app/api/pay/route.ts` |
| Burst is slow and sequential | requests built inside the loop | they must be constructed first, then released together |
| Every attempt returns 409 | winner never commits | backend bug, not frontend; check the backend logs |

---

## 10. Using this with a different backend

The frontend is self-contained and has no imports outside its own folder. To
attach it to any API implementing section 2:

1. Copy `frontend/` into the target repo.
2. Set the four env vars in section 4.
3. If column names differ, edit `app/api/ledger/route.ts`.
4. Run section 7's checklist.

Nothing else references the backend. If the checklist passes, the integration
is done.
