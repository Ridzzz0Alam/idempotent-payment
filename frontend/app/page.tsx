"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";

import { BurstLab } from "@/components/BurstLab";
import { Checkout, Timeline, attemptSummary } from "@/components/Checkout";
import { InstanceStrip, LedgerView } from "@/components/Observatory";
import { SCENARIOS, type Scenario } from "@/lib/scenarios";
import type { InstanceHealth, Ledger, PayResult } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";

const AMOUNT = 4200;
const CURRENCY = "EUR";
const REFERENCE = "Order 7781, annual subscription";

export default function Lab() {
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]);
  const [key, setKey] = useState(() => `lab-${Date.now()}`);
  const [result, setResult] = useState<PayResult | null>(null);
  const [running, setRunning] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const { data: instances } = usePoll<InstanceHealth[]>("/api/instances", 1500);
  const { data: ledger, refresh: refreshLedger } = usePoll<Ledger>(
    `/api/ledger?key=${encodeURIComponent(key)}`,
    2500,
  );

  // A new scenario deserves a clean key, or you would be replaying the last
  // scenario's payment and learning nothing.
  useEffect(() => {
    setKey(`lab-${Date.now()}`);
    setResult(null);
    setFault(null);
  }, [scenario.id]);

  async function pay() {
    setRunning(true);
    setFault(null);
    try {
      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          key,
          amount: AMOUNT,
          currency: CURRENCY,
          reference: REFERENCE,
          attempts: scenario.attempts,
          concurrent: scenario.concurrent,
          loseResponseOn: scenario.loseResponseOn,
          target: scenario.target,
        }),
      });
      if (!res.ok) throw new Error(`pay endpoint returned ${res.status}`);
      setResult((await res.json()) as PayResult);
      void refreshLedger();
    } catch (err) {
      setFault(
        err instanceof Error ? err.message : "the request could not be sent",
      );
    } finally {
      setRunning(false);
    }
  }

  const isBurst = scenario.id === "stampede";
  const summary = result ? attemptSummary(result.attempts) : null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-12 md:px-10">
      <header className="max-w-[64ch]">
        <p className="font-mono text-xs uppercase tracking-wider text-ink-soft">
          Idempotency lab
        </p>
        <h1 className="mt-3 text-4xl font-semibold tracking-tight md:text-5xl">
          The customer never knows what happened
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-soft">
          A lost request and a lost reply look identical from the outside, so
          retrying is the only sane move. Everything below is about making that
          retry harmless. Left pane is what the customer can see. Right pane is
          what actually happened.
        </p>
      </header>

      <div className="mt-8 border-y border-rule py-4">
        <InstanceStrip instances={instances} />
      </div>

      <nav className="mt-8 flex flex-wrap gap-2" aria-label="Scenarios">
        {SCENARIOS.map((s) => {
          const active = s.id === scenario.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setScenario(s)}
              className={`border px-4 py-2 text-left text-sm transition-colors ${
                active
                  ? "border-ink bg-ink text-paper"
                  : "border-rule hover:border-ink"
              }`}
            >
              {s.title}
            </button>
          );
        })}
      </nav>

      <ScenarioBrief scenario={scenario} />

      {isBurst ? (
        <section className="mt-10">
          <BurstLab />
        </section>
      ) : (
        <>
          <section className="mt-10 grid gap-10 lg:grid-cols-2">
            <div className="space-y-6">
              <Checkout
                amount={AMOUNT}
                currency={CURRENCY}
                reference={REFERENCE}
                running={running}
                result={result}
                onPay={pay}
                canPay={true}
              />
              {fault && (
                <p className="border-l-2 border-alarm pl-4 text-sm leading-relaxed">
                  {fault} Check that the API is up on{" "}
                  <code className="font-mono">localhost:8080</code>.
                </p>
              )}
              <p className="text-sm leading-relaxed text-ink-soft">
                {scenario.setup}. The key stays the same across every attempt,
                which is what makes them retries rather than new purchases.
              </p>
            </div>

            <div className="space-y-8">
              <div>
                <h3 className="text-xs uppercase tracking-wider text-ink-soft">
                  Every request, including the invisible ones
                </h3>
                <div className="mt-4">
                  <Timeline result={result} />
                </div>
              </div>

              <div>
                <h3 className="text-xs uppercase tracking-wider text-ink-soft">
                  What is actually in the database
                </h3>
                <div className="mt-4">
                  <LedgerView ledger={ledger} activeKey={key} />
                </div>
              </div>
            </div>
          </section>

          <AnimatePresence>
            {summary && (
              <Debrief
                key={scenario.id + result?.attempts.length}
                scenario={scenario}
                created={summary.created}
                replayed={summary.replayed}
                rows={ledger?.payments.length ?? 0}
              />
            )}
          </AnimatePresence>
        </>
      )}

      <footer className="mt-16 max-w-[64ch] border-t border-rule pt-6 text-sm leading-relaxed text-ink-soft">
        Every number here comes from a real request against a real Postgres. The
        lab has a read-only database connection so it can show you rows instead
        of asking you to take a response at its word.
      </footer>
    </main>
  );
}

function ScenarioBrief({ scenario }: { scenario: Scenario }) {
  const reduce = useReducedMotion();
  const [copied, setCopied] = useState(false);

  return (
    <motion.section
      key={scenario.id}
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-6 max-w-[68ch]"
    >
      <h2 className="text-xl font-semibold">{scenario.question}</h2>
      <p className="mt-3 leading-relaxed text-ink-soft">{scenario.brief}</p>

      {scenario.manualStep && (
        <div className="mt-5 border-l-2 border-ink pl-4">
          <p className="text-sm font-medium">{scenario.manualStep.label}</p>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(scenario.manualStep!.command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
            className="mt-2 border border-rule bg-white px-3 py-2 font-mono text-sm hover:border-ink"
          >
            {copied ? "copied" : scenario.manualStep.command}
          </button>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">
            {scenario.manualStep.why}
          </p>
        </div>
      )}
    </motion.section>
  );
}

function Debrief({
  scenario,
  created,
  replayed,
  rows,
}: {
  scenario: Scenario;
  created: number;
  replayed: number;
  rows: number;
}) {
  const reduce = useReducedMotion();
  const clean = rows <= 1;

  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="mt-12 max-w-[68ch] border-t border-rule pt-8"
    >
      <h3 className="text-xl font-semibold">
        {clean
          ? `${created + replayed} requests, ${rows} payment`
          : `${rows} payments from one key`}
      </h3>
      <p className="mt-3 leading-relaxed text-ink-soft">{scenario.debrief}</p>

      {!clean && (
        <p className="mt-4 border-l-2 border-alarm pl-4 leading-relaxed">
          More than one row means the endpoint is not doing its job. If you are
          on the <code className="font-mono">v0-naive</code> tag, that is the
          expected result and the whole point of keeping it around.
        </p>
      )}
    </motion.section>
  );
}
