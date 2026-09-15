export interface Scenario {
  id: string;
  title: string;
  /** The question the customer is really asking. */
  question: string;
  setup: string;
  attempts: number;
  concurrent: boolean;
  loseResponseOn: number[];
  target: "lb" | "api-1" | "api-2";
  /** Shown before running. */
  brief: string;
  /** Shown after, once there are results to point at. */
  debrief: string;
  /** Optional terminal step the user performs themselves. */
  manualStep?: { label: string; command: string; why: string };
}

export const SCENARIOS: Scenario[] = [
  {
    id: "happy",
    title: "One click, one payment",
    question: "Does the boring case work?",
    setup: "1 request",
    attempts: 1,
    concurrent: false,
    loseResponseOn: [],
    target: "lb",
    brief:
      "Nothing clever here. Press pay, get a payment. Worth doing first so you know what a normal response looks like before anything goes wrong.",
    debrief:
      "One request, one row, one response. Every scenario below produces the same single row. That is the entire promise of the endpoint.",
  },
  {
    id: "lost-response",
    title: "The response gets lost",
    question: "The customer saw a spinner and then nothing. Did they pay?",
    setup: "2 requests, sequential, first reply dropped",
    attempts: 2,
    concurrent: false,
    loseResponseOn: [1],
    target: "lb",
    brief:
      "The first request really is sent and really is processed. We just hide the reply, which is what a dropped connection does. Watch the left pane learn nothing while the right pane records a payment. That gap is the whole problem: a lost request and a lost response look identical to the customer.",
    debrief:
      "The customer retried because they had no way to know. The second request found the key already claimed and returned the stored response instead of charging again. One row, two requests, and the customer finally gets an answer.",
  },
  {
    id: "double-click",
    title: "The impatient customer",
    question: "What if they hit pay three times in a row?",
    setup: "3 requests, all at once",
    attempts: 3,
    concurrent: true,
    loseResponseOn: [],
    target: "lb",
    brief:
      "Three requests released together, same key. This is the case that a check-then-insert implementation fails: all three would read an empty table before any of them commits, and all three would write.",
    debrief:
      "One created, the rest replayed or briefly told to retry. Notice the timings overlap: these were genuinely concurrent, not queued.",
  },
  {
    id: "failover",
    title: "An instance dies mid-checkout",
    question: "Does correctness survive losing a server?",
    setup: "4 requests, all at once, one instance down",
    attempts: 4,
    concurrent: true,
    loseResponseOn: [],
    target: "lb",
    brief:
      "Stop one instance, watch the health strip turn red, then pay. The load balancer sends everything to the survivor. The row count does not change, because the thing preventing duplicates was never inside either process.",
    debrief:
      "Every request was served by the remaining instance and the payment count held. If an in-memory lock had been doing this work, killing the process that held it would have broken it.",
    manualStep: {
      label: "Stop api-1 in your terminal",
      command: "docker compose stop api-1",
      why: "The lab cannot stop a container for you, and pretending to would defeat the point. Run it yourself and the health strip will notice within a second or two. Bring it back with docker compose start api-1.",
    },
  },
  {
    id: "stampede",
    title: "Five hundred at once",
    question: "Does it hold under real concurrency?",
    setup: "500 requests, one key",
    attempts: 0,
    concurrent: true,
    loseResponseOn: [],
    target: "lb",
    brief:
      "The scenarios above are demonstrations. This one is the measurement: every request released at the same instant against a single key.",
    debrief:
      "One blue square in a field of sage. Run it again on the v0-naive tag and the grid speckles.",
  },
];
