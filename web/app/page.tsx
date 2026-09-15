"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BurstEvent, CallState, Verdict } from "@/lib/types";

type Done = Extract<BurstEvent, { type: "done" }>;

const CELL_COLOR: Record<CallState, string> = {
  pending: "bg-paper-sunk",
  created: "bg-created",
  replayed: "bg-replayed",
  conflict: "bg-alarm/45",
  error: "bg-alarm",
};

export default function Console() {
  const [n, setN] = useState(500);
  const [key, setKey] = useState(() => `console-${Date.now()}`);
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<CallState[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  // Five hundred events arriving over a few hundred milliseconds would be five
  // hundred renders. Buffer them and paint once per frame.
  const queue = useRef<Array<{ index: number; state: CallState }>>([]);
  const frame = useRef<number | null>(null);

  const flush = useCallback(() => {
    frame.current = null;
    const batch = queue.current;
    if (!batch.length) return;
    queue.current = [];
    setStates((prev) => {
      const next = prev.slice();
      for (const { index, state } of batch) next[index] = state;
      return next;
    });
  }, []);

  const schedule = useCallback(() => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  }, [flush]);

  useEffect(() => {
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  async function run() {
    setRunning(true);
    setDone(null);
    setFault(null);
    setStates(Array<CallState>(n).fill("pending"));
    queue.current = [];

    try {
      const res = await fetch("/api/burst", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, key }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`burst endpoint returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as BurstEvent;
          if (event.type === "result") {
            queue.current.push({ index: event.index, state: event.state });
            schedule();
          } else if (event.type === "done") {
            setDone(event);
          }
        }
      }
      flush();
    } catch (err) {
      setFault(
        err instanceof Error
          ? err.message
          : "The burst could not be started.",
      );
    } finally {
      setRunning(false);
    }
  }

  const verdicts = done ? judge(done, n) : [];
  const passed = verdicts.every((v) => v.ok);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12 md:px-10">
      <header className="max-w-[62ch] border-b border-rule pb-8">
        <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">
          One key, {n} callers, one payment
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-soft">
          Every square below is a request sent at the same instant with the same
          idempotency key. Exactly one should write a row. The rest should get
          that row&apos;s stored response back, byte for byte.
        </p>
      </header>

      <div className="mt-10 grid gap-10 lg:grid-cols-[17rem_1fr]">
        <ControlRail
          n={n}
          setN={setN}
          idemKey={key}
          setKey={setKey}
          running={running}
          onRun={run}
        />

        <section>
          <Legend />
          <BurstGrid states={states} n={n} />

          {fault && (
            <p className="mt-6 border-l-2 border-alarm pl-4 text-sm leading-relaxed">
              {fault} Check that the Go API is up on{" "}
              <code className="font-mono">localhost:8080</code> and that{" "}
              <code className="font-mono">IDEM_API_URL</code> points at it.
            </p>
          )}

          {done && (
            <Results done={done} n={n} verdicts={verdicts} passed={passed} />
          )}

          {!done && !running && !fault && states.length === 0 && (
            <p className="mt-8 max-w-[58ch] text-sm leading-relaxed text-ink-soft">
              Nothing has run yet. Send a burst to fill the grid. Change the key
              between runs, or reuse one to see every caller replay a payment
              that was created minutes ago.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function ControlRail({
  n,
  setN,
  idemKey,
  setKey,
  running,
  onRun,
}: {
  n: number;
  setN: (v: number) => void;
  idemKey: string;
  setKey: (v: string) => void;
  running: boolean;
  onRun: () => void;
}) {
  return (
    <aside className="space-y-6 lg:sticky lg:top-12 lg:self-start">
      <div>
        <label htmlFor="key" className="block text-sm font-medium">
          Idempotency key
        </label>
        <input
          id="key"
          value={idemKey}
          onChange={(e) => setKey(e.target.value)}
          className="mt-2 w-full border border-rule bg-white px-3 py-2 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => setKey(`console-${Date.now()}`)}
          className="mt-2 text-sm text-ink-soft underline underline-offset-4 hover:text-ink"
        >
          Use a fresh key
        </button>
      </div>

      <div>
        <label htmlFor="n" className="block text-sm font-medium">
          Callers: <span className="font-mono">{n}</span>
        </label>
        <input
          id="n"
          type="range"
          min={10}
          max={1000}
          step={10}
          value={n}
          onChange={(e) => setN(Number(e.target.value))}
          className="mt-3 w-full accent-created"
        />
      </div>

      <button
        type="button"
        onClick={onRun}
        disabled={running}
        className="w-full bg-ink px-4 py-3 font-medium text-paper transition-colors hover:bg-created disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? "Sending…" : "Send the burst"}
      </button>

      <p className="border-t border-rule pt-5 text-sm leading-relaxed text-ink-soft">
        Requests are fanned out from the server, not the browser. Chrome opens
        about six connections per host, so a browser-side burst would queue
        itself into a straight line and pass even against a broken endpoint.
      </p>
    </aside>
  );
}

function Legend() {
  const items: Array<[CallState, string]> = [
    ["created", "wrote a row"],
    ["replayed", "got the stored response"],
    ["conflict", "still unresolved"],
    ["error", "failed"],
  ];
  return (
    <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink-soft">
      {items.map(([state, label]) => (
        <span key={state} className="flex items-center gap-2">
          <span className={`inline-block size-3 ${CELL_COLOR[state]}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

function BurstGrid({ states, n }: { states: CallState[]; n: number }) {
  const cells = states.length ? states : Array<CallState>(n).fill("pending");
  return (
    <div
      className="grid gap-[3px] border border-rule bg-paper-sunk/40 p-3"
      style={{
        gridTemplateColumns: "repeat(auto-fill, minmax(0.85rem, 1fr))",
      }}
      role="img"
      aria-label={`${n} concurrent requests, one square each`}
    >
      {cells.map((state, i) => (
        <span
          key={i}
          className={[
            "cell aspect-square",
            CELL_COLOR[state],
            // The single winner is the one thing worth emphasising.
            state === "created" ? "cell-landing ring-2 ring-ink" : "cell-settled",
          ].join(" ")}
        />
      ))}
    </div>
  );
}

function Results({
  done,
  n,
  verdicts,
  passed,
}: {
  done: Done;
  n: number;
  verdicts: Verdict[];
  passed: boolean;
}) {
  const instances = Object.entries(done.servedBy).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  return (
    <div className="mt-10 space-y-10">
      <div>
        <h2 className="text-xl font-semibold">
          {passed
            ? `One payment, ${done.replayed} replays, ${formatMs(done.elapsedMs)}`
            : `${done.created} payments came out of ${n} calls`}
        </h2>
        <p className="mt-2 max-w-[62ch] text-sm leading-relaxed text-ink-soft">
          {passed
            ? "Every caller after the first received the exact bytes stored by the winner. Nothing was recomputed."
            : "Each extra payment is a real row in the database with its own id. A caller was charged more than once."}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-8 gap-y-5 border-y border-rule py-6 font-mono text-sm sm:grid-cols-4">
        <Stat label="wrote a row" value={done.created} />
        <Stat label="replayed" value={done.replayed} />
        <Stat label="distinct bodies" value={done.distinctBodies} />
        <Stat label="failed" value={done.errors + done.conflicts} />
      </dl>

      <div>
        <h3 className="text-base font-semibold">Checks</h3>
        <ul className="mt-3 divide-y divide-rule border-y border-rule">
          {verdicts.map((v) => (
            <li
              key={v.label}
              className="flex items-baseline justify-between gap-4 py-3 text-sm"
            >
              <span className="flex items-baseline gap-3">
                <span
                  className={`inline-block size-2 shrink-0 translate-y-px ${
                    v.ok ? "bg-created" : "bg-alarm"
                  }`}
                />
                {v.label}
              </span>
              <span className="font-mono text-ink-soft">{v.detail}</span>
            </li>
          ))}
        </ul>
      </div>

      {instances.length > 0 && (
        <div>
          <h3 className="text-base font-semibold">Which instance answered</h3>
          <ul className="mt-3 space-y-2 font-mono text-sm">
            {instances.map(([name, count]) => (
              <li key={name} className="flex items-center gap-3">
                <span className="w-20 shrink-0">{name}</span>
                <span
                  className="h-3 bg-replayed"
                  style={{ width: `${(count / n) * 100}%` }}
                />
                <span className="text-ink-soft">{count}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 max-w-[62ch] text-sm leading-relaxed text-ink-soft">
            Both processes served callers and still produced one payment. The
            only thing they share is the unique index, so nothing in application
            memory could have arbitrated this.
          </p>
        </div>
      )}

      {done.sampleBody && (
        <div>
          <h3 className="text-base font-semibold">The stored response</h3>
          <pre className="mt-3 overflow-x-auto border border-rule bg-white p-4 font-mono text-xs leading-relaxed">
            {pretty(done.sampleBody)}
          </pre>
        </div>
      )}

      <p className="max-w-[62ch] border-l-2 border-rule pl-4 text-sm leading-relaxed text-ink-soft">
        These counts come from HTTP responses. The authoritative number is the
        row count in Postgres, which <code className="font-mono">make proof</code>{" "}
        queries directly. Trust that one when the two disagree.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-ink-soft">{label}</dt>
      <dd className="mt-1 text-2xl">{value}</dd>
    </div>
  );
}

function judge(d: Done, n: number): Verdict[] {
  return [
    {
      label: "Exactly one caller wrote a row",
      ok: d.created === 1,
      detail: `${d.created}`,
    },
    {
      label: "Everyone else got a replay",
      ok: d.replayed === n - 1,
      detail: `${d.replayed} of ${n - 1}`,
    },
    {
      label: "Every response was identical",
      ok: d.distinctBodies === 1,
      detail: `${d.distinctBodies} distinct`,
    },
    {
      label: "No caller was left unresolved",
      ok: d.conflicts === 0,
      detail: `${d.conflicts}`,
    },
    { label: "No request failed", ok: d.errors === 0, detail: `${d.errors}` },
  ];
}

function pretty(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatMs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}
