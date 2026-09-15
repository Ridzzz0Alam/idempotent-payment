import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { Agent, request } from "undici";

type State = "created" | "replayed" | "conflict" | "error";

interface Result {
  state: State;
  status: number;
  attempts: number;
  servedBy: string;
  bodyHash: string;
}

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    db: {
      type: "string",
      default:
        process.env.DATABASE_URL ?? "postgres://idem:idem@localhost:5432/idem",
    },
    n: { type: "string", default: "500" },
    retries: { type: "string", default: "20" },
    key: { type: "string" },
    label: { type: "string", default: "current" },
  },
});

const N = Number(values.n);
const RETRIES = Number(values.retries);
const BASE = values.url!;
const KEY = values.key ?? `proof-${Date.now()}`;
const PAYLOAD = JSON.stringify({
  amount: 4200,
  currency: "EUR",
  reference: "invoice-7781",
});

// Node's default dispatcher caps concurrent connections per origin. Left
// alone it would quietly serialise the burst, and the naive build would pass.
// An explicit agent sized to the caller count is the difference between
// testing the database and testing undici.
const agent = new Agent({
  connections: N,
  pipelining: 0,
  keepAliveTimeout: 30_000,
});

async function fire(): Promise<Result> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await request(`${BASE}/payments`, {
        method: "POST",
        dispatcher: agent,
        headers: {
          "content-type": "application/json",
          "idempotency-key": KEY,
        },
        body: PAYLOAD,
      });
      const text = await res.body.text();

      // 409 means the winner holds the key but has not committed yet. That is
      // the endpoint working, not failing.
      if (res.statusCode === 409 && attempt <= RETRIES) {
        await sleep(attempt * 25);
        continue;
      }

      const header = (name: string) => {
        const v = res.headers[name];
        return (Array.isArray(v) ? v[0] : v) ?? "";
      };

      const replayed = header("idempotency-replayed") === "true";
      const ok = res.statusCode >= 200 && res.statusCode < 300;

      return {
        state:
          res.statusCode === 409
            ? "conflict"
            : ok && replayed
              ? "replayed"
              : ok
                ? "created"
                : "error",
        status: res.statusCode,
        attempts: attempt,
        servedBy: header("x-served-by") || "unknown",
        bodyHash: createHash("sha256").update(text).digest("hex").slice(0, 12),
      };
    } catch {
      return {
        state: "error",
        status: 0,
        attempts: attempt,
        servedBy: "unreachable",
        bodyHash: "",
      };
    }
  }
}

async function main() {
  console.log(`firing ${N} concurrent requests at ${BASE}`);
  console.log(`key: ${KEY}\n`);

  // Every request is created before any of them is released. Awaiting inside
  // a loop, or letting the first calls start while the last are still being
  // constructed, staggers the start past the window being tested.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const tasks = Array.from({ length: N }, async () => {
    await gate;
    return fire();
  });

  const t0 = performance.now();
  release();
  const results = await Promise.all(tasks);
  const elapsed = Math.round(performance.now() - t0);

  await report(results, elapsed);
  await agent.close();
}

async function report(results: Result[], elapsed: number) {
  const bodies = new Map<string, number>();
  const instances = new Map<string, number>();
  let created = 0;
  let replayed = 0;
  let conflicts = 0;
  let errors = 0;
  let maxAttempts = 0;

  for (const r of results) {
    instances.set(r.servedBy, (instances.get(r.servedBy) ?? 0) + 1);
    maxAttempts = Math.max(maxAttempts, r.attempts);
    if (r.state === "created" || r.state === "replayed") {
      bodies.set(r.bodyHash, (bodies.get(r.bodyHash) ?? 0) + 1);
    }
    if (r.state === "created") created++;
    else if (r.state === "replayed") replayed++;
    else if (r.state === "conflict") conflicts++;
    else errors++;
  }

  const { rows, keys } = await counts();

  console.log(`=== ${values.label} ===`);
  row("wall clock", `${elapsed} ms`);
  row("payment rows created", rows);
  row("idempotency key rows", keys);
  row("HTTP 201 created", created);
  row("HTTP replays", replayed);
  row("distinct bodies", bodies.size);
  row("unresolved 409s", conflicts);
  row("errors", errors);
  row("max attempts by one", maxAttempts);
  row(
    "served by",
    [...instances.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("  "),
  );

  if (bodies.size > 1) {
    console.log("\ndistinct response bodies (each one is a separate payment):");
    for (const [hash, count] of bodies) console.log(`  ${hash}  x${count}`);
  }

  const checks: Array<[string, boolean, string]> = [
    ["exactly one payment row", rows === 1, String(rows)],
    ["exactly one 201 created", created === 1, String(created)],
    ["all others replayed", replayed === N - 1, `${replayed}, want ${N - 1}`],
    ["one distinct response body", bodies.size === 1, String(bodies.size)],
    ["no errors", errors === 0, String(errors)],
    ["no unresolved conflicts", conflicts === 0, String(conflicts)],
  ];

  console.log("");
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(`[${ok ? "PASS" : "FAIL"}] ${name.padEnd(28)} ${detail}`);
  }

  if (failed > 0) {
    console.log(
      `\n${failed}/${checks.length} checks failed. Duplicates: ${rows - 1} extra payment rows.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`\nall ${checks.length} checks passed.`);
}

async function counts() {
  const client = new Client({ connectionString: values.db });
  await client.connect();
  try {
    const p = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM payments WHERE idempotency_key = $1",
      [KEY],
    );
    const k = await client.query<{ n: string }>(
      "SELECT count(*) AS n FROM idempotency_keys WHERE key = $1",
      [KEY],
    );
    return { rows: Number(p.rows[0].n), keys: Number(k.rows[0].n) };
  } finally {
    await client.end();
  }
}

const row = (label: string, value: string | number) =>
  console.log(`${label.padEnd(22)}${value}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

void main();
