# Idempotency lab

> Wiring this to a backend? Read **[AGENT.md](AGENT.md)** instead. It is the
> complete integration spec, written to be followed start to finish.

An interactive teaching tool for the payments API in the parent directory. Not
a dashboard: a set of scenarios you run against a real backend and a real
Postgres.

## The idea

The page is split. **Left is what the customer can see**: a checkout, a button,
whatever response came back. **Right is the truth**: every request that was
actually sent, which instance served it, and the rows now in the database.

The gap between those two panes is the entire lesson. A customer whose reply
got lost cannot tell the difference between "nothing happened" and "you were
charged", so they retry, and the server has to make that harmless.

## Scenarios

1. **One click, one payment.** The boring case, so you know what normal looks like.
2. **The response gets lost.** The first reply is hidden from the customer. The request is still really sent and really processed. Watch the left pane learn nothing while the right pane records a payment, then watch the retry replay instead of charging again.
3. **The impatient customer.** Three requests released together on one key. This is the case a check-then-insert implementation fails.
4. **An instance dies mid-checkout.** Real failover, described below.
5. **Five hundred at once.** The burst grid. One blue square is a row being written; sage is a stored response coming back.

## Real failover, not a fake button

Scenario 4 asks you to run `docker compose stop api-1` yourself. The lab polls
each instance directly and the health strip turns red within a second or two.

There is no kill button because the lab cannot stop a container, and a button
that only *pretended* to would undermine the one thing this project is for.
Bring it back with `docker compose start api-1`.

## Setup

From the repo root, with the backend already up (`make up`):

```bash
make lab        # copies .env.example to .env if needed, installs, runs on :3000
```

Or by hand:

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

```
IDEM_API_URL=http://localhost:8080   # through the load balancer
API_1_URL=http://localhost:8081      # direct, for health and targeted sends
API_2_URL=http://localhost:8082
DATABASE_URL=postgres://idem:idem@localhost:5432/idem
```

The defaults match the root `docker-compose.yml`, so the example file works
unchanged. `DATABASE_URL` is read-only in practice: the lab only ever SELECTs.
Without it the right pane degrades to showing HTTP responses, which is exactly
the kind of second-hand evidence the project argues against.

## Two deliberate constraints

**The browser never calls the payments API directly.** Every request is fanned
out from a route handler. Chrome opens about six connections per host, so a
browser-side burst would serialise itself and pass even against the broken
build.

**Lost responses are hidden, not faked.** When a scenario drops a reply, the
request is still sent and still processed. Simulating the failure client-side
would make the timeline a drawing rather than a record.

## Reading a run

- **blue**: this request wrote a row
- **sage**: this request got the stored response back
- **faded red**: told to retry; the winner had claimed the key but not yet committed
- **red**: failed

More than one blue in a single run means duplicates. On `v1-idempotent` that
should never happen. On `v0-naive` it is the expected result.
