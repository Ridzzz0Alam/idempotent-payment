"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { Attempt, CallState, PayResult } from "@/lib/types";

const STATE_LABEL: Record<CallState, string> = {
  pending: "in flight",
  created: "wrote a row",
  replayed: "replayed",
  conflict: "told to retry",
  error: "failed",
};

const STATE_BG: Record<CallState, string> = {
  pending: "bg-paper-sunk",
  created: "bg-created",
  replayed: "bg-replayed",
  conflict: "bg-alarm/45",
  error: "bg-alarm",
};

/**
 * The left pane. Shows only what a customer could actually know: the button
 * they pressed and whatever response came back. Attempts whose reply was lost
 * leave this pane in the dark on purpose.
 */
export function Checkout({
  amount,
  currency,
  reference,
  running,
  result,
  onPay,
  canPay,
}: {
  amount: number;
  currency: string;
  reference: string;
  running: boolean;
  result: PayResult | null;
  onPay: () => void;
  canPay: boolean;
}) {
  const reduce = useReducedMotion();
  const seen = result?.attempts.filter((a) => a.reachedCustomer) ?? [];
  const latest = seen
    .filter((a) => a.state === "created" || a.state === "replayed")
    .at(-1);
  const blind = (result?.attempts.length ?? 0) - seen.length;

  return (
    <div className="border border-rule bg-white">
      <div className="border-b border-rule px-6 py-4">
        <p className="text-xs uppercase tracking-wider text-ink-soft">
          What the customer sees
        </p>
      </div>

      <div className="px-6 py-8">
        <p className="text-sm text-ink-soft">{reference}</p>
        <p className="mt-1 font-mono text-4xl">
          {(amount / 100).toFixed(2)}{" "}
          <span className="text-2xl text-ink-soft">{currency}</span>
        </p>

        <button
          type="button"
          onClick={onPay}
          disabled={running || !canPay}
          className="mt-6 w-full bg-ink px-4 py-3 font-medium text-paper transition-colors hover:bg-created disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? "Processing…" : "Pay"}
        </button>

        <div className="mt-6 min-h-[7rem]">
          <AnimatePresence mode="wait">
            {running && (
              <motion.p
                key="spinner"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-sm text-ink-soft"
              >
                Waiting for the bank…
              </motion.p>
            )}

            {!running && latest && (
              <motion.div
                key={`ok-${latest.n}`}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="border-l-2 border-created pl-4"
              >
                <p className="font-medium">Payment confirmed</p>
                <p className="mt-1 font-mono text-xs break-all text-ink-soft">
                  {latest.paymentId}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-ink-soft">
                  {blind > 0
                    ? `It took ${blind + seen.length} attempts to get this answer. The customer only ever saw one of them.`
                    : "Answered on the first try."}
                </p>
              </motion.div>
            )}

            {!running && !latest && result && (
              <motion.div
                key="blind"
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="border-l-2 border-alarm pl-4"
              >
                <p className="font-medium">No response</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                  The customer has no idea whether they were charged. From here
                  a lost request and a lost reply are indistinguishable, so the
                  only move is to try again.
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/**
 * The right pane. Every attempt, including the ones the customer never saw,
 * laid out on a shared time axis so overlap is visible rather than asserted.
 */
export function Timeline({ result }: { result: PayResult | null }) {
  const reduce = useReducedMotion();
  if (!result || result.attempts.length === 0) {
    return (
      <p className="text-sm leading-relaxed text-ink-soft">
        Requests will appear here as they land, on a shared time axis. Attempts
        the customer never saw are drawn too. The server does not forget them
        just because the reply went missing.
      </p>
    );
  }

  const span = Math.max(
    ...result.attempts.map((a) => a.startedAt + a.durationMs),
    1,
  );

  return (
    <div className="space-y-2">
      {result.attempts.map((a) => (
        <motion.div
          key={a.n}
          initial={reduce ? false : { opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: reduce ? 0 : a.n * 0.05 }}
          className="grid grid-cols-[2rem_1fr_9rem] items-center gap-3 text-sm"
        >
          <span className="font-mono text-ink-soft">#{a.n}</span>

          <div className="relative h-6 bg-paper-sunk/50">
            <div
              className={`absolute inset-y-0 ${STATE_BG[a.state]}`}
              style={{
                left: `${(a.startedAt / span) * 100}%`,
                width: `${Math.max((a.durationMs / span) * 100, 2)}%`,
              }}
              title={`${a.durationMs} ms on ${a.servedBy}`}
            />
            {!a.reachedCustomer && (
              <span className="absolute inset-y-0 right-1 flex items-center text-[0.65rem] uppercase tracking-wide text-alarm">
                reply lost
              </span>
            )}
          </div>

          <span className="font-mono text-xs text-ink-soft">
            {a.status || "—"} {STATE_LABEL[a.state]}
            <br />
            {a.servedBy}
          </span>
        </motion.div>
      ))}

      <p className="pt-2 font-mono text-xs text-ink-soft">
        {result.elapsedMs} ms total
      </p>
    </div>
  );
}

export function attemptSummary(attempts: Attempt[]) {
  return {
    created: attempts.filter((a) => a.state === "created").length,
    replayed: attempts.filter((a) => a.state === "replayed").length,
    conflicts: attempts.filter((a) => a.state === "conflict").length,
    errors: attempts.filter((a) => a.state === "error").length,
  };
}
