export type CallState =
  | "pending"
  | "created"
  | "replayed"
  | "conflict"
  | "error";

/** One line of the NDJSON stream from /api/burst. */
export type BurstEvent =
  | { type: "start"; n: number; key: string; target: string }
  | {
      type: "result";
      index: number;
      state: CallState;
      status: number;
      attempts: number;
      servedBy: string;
      bodyHash: string;
      message?: string;
    }
  | {
      type: "done";
      elapsedMs: number;
      created: number;
      replayed: number;
      conflicts: number;
      errors: number;
      distinctBodies: number;
      servedBy: Record<string, number>;
      sampleBody: string | null;
    };

export type Verdict = { label: string; ok: boolean; detail: string };

/** One HTTP attempt in the payment terminal. */
export interface Attempt {
  n: number;
  state: CallState;
  status: number;
  servedBy: string;
  /** The customer's side of the story: did they ever see this response? */
  reachedCustomer: boolean;
  startedAt: number;
  durationMs: number;
  body: string | null;
  paymentId: string | null;
}

export interface PayResult {
  key: string;
  attempts: Attempt[];
  elapsedMs: number;
}

export interface InstanceHealth {
  name: string;
  url: string;
  up: boolean;
}

export interface LedgerRow {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  created_at: string;
}

export interface LedgerKeyRow {
  key: string;
  status: string;
  response_code: number | null;
  response_body: string | null;
  request_hash: string;
  created_at: string;
}

export interface Ledger {
  payments: LedgerRow[];
  keyRow: LedgerKeyRow | null;
  available: boolean;
  reason?: string;
}
