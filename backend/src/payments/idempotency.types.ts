/** What the service tells the controller. No HTTP concepts in the service. */
export type Outcome =
  | { kind: "created"; code: number; body: string }
  | { kind: "replayed"; code: number; body: string }
  /** The winner holds the key but has not committed. Retry shortly. */
  | { kind: "in_progress" }
  /** Same key, different payload. Replaying would discard their request. */
  | { kind: "mismatch" };

export interface PaymentResponse {
  payment_id: string;
  amount: number;
  currency: string;
  reference: string;
  status: "succeeded";
  created_at: string;
}
