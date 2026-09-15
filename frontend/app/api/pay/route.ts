import type { Attempt, CallState, PayResult } from "@/lib/types";

export const dynamic = "force-dynamic";

const TARGETS: Record<string, string> = {
  lb: process.env.IDEM_API_URL ?? "http://localhost:8080",
  "api-1": process.env.API_1_URL ?? "http://localhost:8081",
  "api-2": process.env.API_2_URL ?? "http://localhost:8082",
};

type Body = {
  key: string;
  amount?: number;
  currency?: string;
  reference?: string;
  target?: keyof typeof TARGETS;
  /** How many times the customer hits Pay. */
  attempts?: number;
  /** true = all at once (impatient double-click). false = one after another. */
  concurrent?: boolean;
  /**
   * Which attempts the customer never sees a response for. The request is
   * still really sent and really processed. We only hide the reply, which is
   * exactly what a dropped response does in the wild.
   */
  loseResponseOn?: number[];
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const key = body.key?.trim();
  if (!key) return Response.json({ error: "key required" }, { status: 400 });

  const base = TARGETS[body.target ?? "lb"] ?? TARGETS.lb;
  const count = Math.min(Math.max(body.attempts ?? 1, 1), 10);
  const lost = new Set(body.loseResponseOn ?? []);
  const payload = JSON.stringify({
    amount: body.amount ?? 4200,
    currency: body.currency ?? "EUR",
    reference: body.reference ?? "invoice-7781",
  });

  const t0 = performance.now();
  let attempts: Attempt[];

  if (body.concurrent) {
    // Released together, so they genuinely race. Sequential awaits here would
    // turn a double-click into two calls minutes apart in machine terms.
    attempts = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        fire(base, key, payload, i + 1, lost.has(i + 1), t0),
      ),
    );
  } else {
    attempts = [];
    for (let i = 1; i <= count; i++) {
      attempts.push(await fire(base, key, payload, i, lost.has(i), t0));
      if (i < count) await sleep(120);
    }
  }

  const result: PayResult = {
    key,
    attempts: attempts.sort((a, b) => a.n - b.n),
    elapsedMs: Math.round(performance.now() - t0),
  };
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

async function fire(
  base: string,
  key: string,
  payload: string,
  n: number,
  responseLost: boolean,
  origin: number,
): Promise<Attempt> {
  const startedAt = Math.round(performance.now() - origin);
  const t = performance.now();

  try {
    const res = await fetch(`${base}/payments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: payload,
      cache: "no-store",
    });
    const text = await res.text();
    const replayed = res.headers.get("Idempotency-Replayed") === "true";

    let state: CallState = "error";
    if (res.status === 409) state = "conflict";
    else if (res.ok && replayed) state = "replayed";
    else if (res.ok) state = "created";

    let paymentId: string | null = null;
    try {
      paymentId = (JSON.parse(text) as { payment_id?: string }).payment_id ?? null;
    } catch {
      /* error bodies are not payments */
    }

    return {
      n,
      state,
      status: res.status,
      servedBy: res.headers.get("X-Served-By") ?? "unknown",
      reachedCustomer: !responseLost,
      startedAt,
      durationMs: Math.round(performance.now() - t),
      body: responseLost ? null : text,
      paymentId,
    };
  } catch (err) {
    return {
      n,
      state: "error",
      status: 0,
      servedBy: "unreachable",
      reachedCustomer: false,
      startedAt,
      durationMs: Math.round(performance.now() - t),
      body: err instanceof Error ? err.message : "request failed",
      paymentId: null,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
