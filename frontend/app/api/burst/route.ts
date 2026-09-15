import { createHash } from "node:crypto";
import type { BurstEvent, CallState } from "@/lib/types";

// Never prerender or cache a burst.
export const dynamic = "force-dynamic";

const API = process.env.IDEM_API_URL ?? "http://localhost:8080";

type Body = {
  n?: number;
  key?: string;
  retries?: number;
  payload?: unknown;
};

export async function POST(request: Request) {
  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const n = clamp(body.n ?? 500, 1, 2000);
  const retries = clamp(body.retries ?? 20, 0, 100);
  const key = body.key?.trim() || `console-${Date.now()}`;
  const payload = JSON.stringify(
    body.payload ?? { amount: 4200, currency: "EUR", reference: "invoice-7781" },
  );

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (event: BurstEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

      emit({ type: "start", n, key, target: API });

      // Every request is constructed before any of them is released. Building
      // them inside the loop would stagger the start by however long
      // construction takes, which is exactly the window we are trying to hit.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const bodies = new Set<string>();
      const servedBy: Record<string, number> = {};
      let created = 0;
      let replayed = 0;
      let conflicts = 0;
      let errors = 0;
      let sampleBody: string | null = null;

      const tasks = Array.from({ length: n }, (_, index) =>
        (async () => {
          await gate;
          const r = await fire(key, payload, retries);

          if (r.servedBy) servedBy[r.servedBy] = (servedBy[r.servedBy] ?? 0) + 1;
          if (r.state === "created") {
            created++;
            bodies.add(r.bodyHash);
            sampleBody ??= r.raw;
          } else if (r.state === "replayed") {
            replayed++;
            bodies.add(r.bodyHash);
          } else if (r.state === "conflict") conflicts++;
          else errors++;

          emit({
            type: "result",
            index,
            state: r.state,
            status: r.status,
            attempts: r.attempts,
            servedBy: r.servedBy,
            bodyHash: r.bodyHash,
            message: r.message,
          });
        })(),
      );

      const t0 = performance.now();
      release();
      await Promise.all(tasks);

      emit({
        type: "done",
        elapsedMs: Math.round(performance.now() - t0),
        created,
        replayed,
        conflicts,
        errors,
        distinctBodies: bodies.size,
        servedBy,
        sampleBody,
      });

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Stop any intermediate proxy from buffering the stream into one chunk.
      "X-Accel-Buffering": "no",
    },
  });
}

type Attempt = {
  state: CallState;
  status: number;
  attempts: number;
  servedBy: string;
  bodyHash: string;
  raw: string;
  message?: string;
};

async function fire(
  key: string,
  payload: string,
  retries: number,
): Promise<Attempt> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${API}/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: payload,
        cache: "no-store",
      });
      const text = await res.text();

      // 409 means the winner holds the key but has not committed. That is the
      // endpoint working, not failing, so retry rather than record a failure.
      if (res.status === 409 && attempt <= retries) {
        await sleep(attempt * 25);
        continue;
      }

      const servedBy = res.headers.get("X-Served-By") ?? "unknown";
      const isReplay = res.headers.get("Idempotency-Replayed") === "true";
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 12);

      let state: CallState = "error";
      if (res.status === 409) state = "conflict";
      else if (res.ok && isReplay) state = "replayed";
      else if (res.ok) state = "created";

      return {
        state,
        status: res.status,
        attempts: attempt,
        servedBy,
        bodyHash: hash,
        raw: text,
        message: res.ok ? undefined : text.slice(0, 160),
      };
    } catch (err) {
      return {
        state: "error",
        status: 0,
        attempts: attempt,
        servedBy: "unreachable",
        bodyHash: "",
        raw: "",
        message: err instanceof Error ? err.message : "request failed",
      };
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.trunc(v)));
