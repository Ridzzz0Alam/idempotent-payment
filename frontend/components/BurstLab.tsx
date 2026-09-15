"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BurstEvent, CallState, Verdict } from "@/lib/types";

type Done = Extract<BurstEvent, { type: "done" }>;

const CELL: Record<CallState, string> = {
  pending: "bg-paper-sunk",
  created: "bg-created",
  replayed: "bg-replayed",
  conflict: "bg-alarm/45",
  error: "bg-alarm",
};

export function BurstLab({ onFinished }: { onFinished?: () => void }) {
  const [n, setN] = useState(500);
  const [running, setRunning] = useState(false);
  const [states, setStates] = useState<CallState[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [fault, setFault] = useState<string | null>(null);

  // Five hundred events over a few hundred milliseconds would be five hundred
  // renders. Buffer them and paint once per frame.
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

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

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
        body: JSON.stringify({ n, key: `burst-${Date.now()}` }),
      });
      if (!res.ok || !res.body) throw new Error(`burst returned ${res.status}`);

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
            if (frame.current === null)
              frame.current = requestAnimationFrame(flush);
          } else if (event.type === "done") {
            setDone(event);
          }
        }
      }
      flush();
      onFinished?.();
    } catch (err) {
      setFault(err instanceof Error ? err.message : "burst failed");
    } finally {
      setRunning(false);
    }
  }

  const cells = states.length ? states : Array<CallState>(n).fill("pending");
  const verdicts: Verdict[] = done
    ? [
        {
          label: "Exactly one caller wrote a row",
          ok: done.created === 1,
          detail: `${done.created}`,
        },
        {
          label: "Everyone else got a replay",
          ok: done.replayed === n - 1,
          detail: `${done.replayed} of ${n - 1}`,
        },
        {
          label: "Every response was identical",
          ok: done.distinctBodies === 1,
          detail: `${done.distinctBodies} distinct`,
        },
        { label: "No request failed", ok: done.errors === 0, detail: `${done.errors}` },
      ]
    : [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-6">
        <label className="text-sm">
          Callers: <span className="font-mono">{n}</span>
          <input
            type="range"
            min={50}
            max={1000}
            step={50}
            value={n}
            onChange={(e) => setN(Number(e.target.value))}
            className="mt-2 block w-56 accent-created"
          />
        </label>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="bg-ink px-5 py-2.5 font-medium text-paper transition-colors hover:bg-created disabled:opacity-40"
        >
          {running ? "Sending…" : "Send the stampede"}
        </button>
      </div>

      <div
        className="grid gap-[3px] border border-rule bg-paper-sunk/40 p-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(0.8rem, 1fr))" }}
        role="img"
        aria-label={`${n} concurrent requests, one square each`}
      >
        {cells.map((state, i) => (
          <span
            key={i}
            className={`cell aspect-square ${CELL[state]} ${
              state === "created" ? "ring-2 ring-ink" : ""
            }`}
          />
        ))}
      </div>

      {fault && (
        <p className="border-l-2 border-alarm pl-4 text-sm">{fault}</p>
      )}

      {done && (
        <div className="space-y-4">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-4 border-y border-rule py-5 font-mono text-sm sm:grid-cols-4">
            {[
              ["wrote a row", done.created],
              ["replayed", done.replayed],
              ["distinct bodies", done.distinctBodies],
              ["failed", done.errors + done.conflicts],
            ].map(([label, value]) => (
              <div key={label as string}>
                <dt className="text-xs text-ink-soft">{label}</dt>
                <dd className="mt-1 text-2xl">{value}</dd>
              </div>
            ))}
          </dl>

          <ul className="divide-y divide-rule border-y border-rule">
            {verdicts.map((v) => (
              <li
                key={v.label}
                className="flex items-baseline justify-between gap-4 py-2.5 text-sm"
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

          <p className="max-w-[62ch] border-l-2 border-rule pl-4 text-sm leading-relaxed text-ink-soft">
            These counts come from HTTP responses. The authoritative number is
            the row count in Postgres, which{" "}
            <code className="font-mono">make proof</code> queries directly.
            Trust that one when the two disagree.
          </p>
        </div>
      )}
    </div>
  );
}
