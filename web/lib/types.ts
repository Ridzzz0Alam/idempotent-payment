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

export type Verdict = {
  label: string;
  ok: boolean;
  detail: string;
};
