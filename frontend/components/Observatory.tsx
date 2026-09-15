"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { InstanceHealth, Ledger } from "@/lib/types";

/**
 * Real health, polled directly against each instance. Stopping a container in
 * a terminal turns one of these red within a second or two, which is the
 * honest version of a "kill server" button that would only have pretended.
 */
export function InstanceStrip({
  instances,
}: {
  instances: InstanceHealth[] | null;
}) {
  const reduce = useReducedMotion();
  const list = instances ?? [
    { name: "api-1", url: "", up: false },
    { name: "api-2", url: "", up: false },
  ];
  const down = list.filter((i) => !i.up).length;

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
      {list.map((i) => (
        <span key={i.name} className="flex items-center gap-2 font-mono text-sm">
          <motion.span
            animate={
              reduce ? undefined : { scale: i.up ? [1, 1.25, 1] : 1 }
            }
            transition={{ duration: 1.6, repeat: i.up ? Infinity : 0 }}
            className={`inline-block size-2.5 rounded-full ${
              i.up ? "bg-created" : "bg-alarm"
            }`}
          />
          {i.name}
          <span className="text-ink-soft">{i.up ? "up" : "down"}</span>
        </span>
      ))}

      <AnimatePresence>
        {down > 0 && down < list.length && (
          <motion.span
            initial={reduce ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="text-sm text-ink-soft"
          >
            One instance is gone. Everything routes to the survivor.
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The actual rows. Without this the right pane would just be the left pane in
 * a different font: a claim about the database rather than a look at it.
 */
export function LedgerView({
  ledger,
  activeKey,
}: {
  ledger: Ledger | null;
  activeKey: string;
}) {
  const reduce = useReducedMotion();

  if (ledger && !ledger.available) {
    return (
      <p className="border-l-2 border-rule pl-4 text-sm leading-relaxed text-ink-soft">
        {ledger.reason} Set it in <code className="font-mono">frontend/.env</code> to
        see the real rows instead of taking the response at its word.
      </p>
    );
  }

  const rows = ledger?.payments ?? [];
  const keyRow = ledger?.keyRow ?? null;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-baseline justify-between">
          <h4 className="text-sm font-medium">payments</h4>
          <span
            className={`font-mono text-sm ${
              rows.length > 1 ? "text-alarm" : "text-ink-soft"
            }`}
          >
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
        </div>

        <div className="mt-2 border-y border-rule">
          {rows.length === 0 && (
            <p className="py-3 text-sm text-ink-soft">
              No payment for this key yet.
            </p>
          )}
          <AnimatePresence initial={false}>
            {rows.map((r) => (
              <motion.div
                key={r.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                className="flex items-baseline justify-between gap-4 border-b border-rule py-2 font-mono text-xs last:border-b-0"
              >
                <span className="truncate text-ink-soft">{r.id}</span>
                <span>
                  {(r.amount / 100).toFixed(2)} {r.currency}
                </span>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {rows.length > 1 && (
          <p className="mt-2 border-l-2 border-alarm pl-4 text-sm leading-relaxed">
            Each of these is a separate charge with its own id. This is the
            failure the endpoint exists to prevent.
          </p>
        )}
      </div>

      <div>
        <h4 className="text-sm font-medium">idempotency_keys</h4>
        <div className="mt-2 border-y border-rule py-2">
          {!keyRow && (
            <p className="text-sm text-ink-soft">No key row yet.</p>
          )}
          {keyRow && (
            <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-1 font-mono text-xs">
              <dt className="text-ink-soft">key</dt>
              <dd className="truncate">{keyRow.key}</dd>
              <dt className="text-ink-soft">status</dt>
              <dd>{keyRow.status}</dd>
              <dt className="text-ink-soft">code</dt>
              <dd>{keyRow.response_code ?? "—"}</dd>
              <dt className="text-ink-soft">hash</dt>
              <dd className="truncate">{keyRow.request_hash.slice(0, 24)}…</dd>
            </dl>
          )}
        </div>

        {keyRow?.response_body && (
          <div className="mt-3">
            <p className="text-xs text-ink-soft">
              stored response: these exact bytes are what every replay returns
            </p>
            <pre className="mt-1 overflow-x-auto border border-rule bg-white p-3 font-mono text-[0.7rem] leading-relaxed">
              {pretty(keyRow.response_body)}
            </pre>
          </div>
        )}
      </div>

      <p className="font-mono text-xs break-all text-ink-soft">key: {activeKey}</p>
    </div>
  );
}

function pretty(raw: string) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
