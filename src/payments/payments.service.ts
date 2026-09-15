import { Inject, Injectable } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import { DB, type Db } from "../db/db.module";
import { idempotencyKeys, payments } from "../db/schema";
import type { CreatePaymentDto } from "./dto/create-payment.dto";
import type { Outcome, PaymentResponse } from "./idempotency.types";

@Injectable()
export class PaymentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Claims the idempotency key by inserting it, and treats the resulting
   * conflict as the answer rather than asking a question first.
   *
   * The claim and the payment insert share one transaction. That is the whole
   * design. Because they commit together, there is no window in which a key
   * exists without its payment, or a payment without its key.
   */
  async create(
    key: string,
    rawBody: Buffer,
    dto: CreatePaymentDto,
  ): Promise<Outcome> {
    const hash = createHash("sha256").update(rawBody).digest("hex");

    const outcome = await this.db.transaction(async (tx) => {
      // ---- CLAIM ---------------------------------------------------------
      // onConflictDoNothing does not block on a conflicting uncommitted row;
      // it returns zero rows immediately. At 500 concurrent that is the
      // difference between 499 losers releasing their connection in
      // microseconds and 499 losers queueing behind the winner until the pool
      // is exhausted.
      const claimed = await tx
        .insert(idempotencyKeys)
        .values({ key, requestHash: hash, status: "in_progress" })
        .onConflictDoNothing({ target: idempotencyKeys.key })
        .returning({ key: idempotencyKeys.key });

      if (claimed.length === 0) {
        // Someone else owns this key. Nothing here is ours to roll back, and
        // the read has to happen outside this transaction to see their commit.
        return null;
      }

      // ---- WINNER --------------------------------------------------------
      const response = buildResponse(dto);
      const body = JSON.stringify(response);

      await tx.insert(payments).values({
        id: response.payment_id,
        idempotencyKey: key,
        amount: response.amount,
        currency: response.currency,
        reference: response.reference,
        createdAt: new Date(response.created_at),
      });

      // Store the exact bytes returned to this caller, so every later replay
      // is byte-identical rather than regenerated from the row.
      await tx
        .update(idempotencyKeys)
        .set({ status: "completed", responseCode: 201, responseBody: body })
        .where(eq(idempotencyKeys.key, key));

      // Payment and key become visible in the same instant.
      return { kind: "created", code: 201, body } satisfies Outcome;
    });

    return outcome ?? this.replay(key, hash);
  }

  /** Serves a request whose key was already claimed by someone else. */
  private async replay(key: string, hash: string): Promise<Outcome> {
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, key))
      .limit(1);

    // The claim conflicted but the row is invisible, so the winner is holding
    // an uncommitted insert. There is no stored response to return yet.
    if (!row) return { kind: "in_progress" };
    if (row.requestHash !== hash) return { kind: "mismatch" };
    if (row.status !== "completed") return { kind: "in_progress" };

    return {
      kind: "replayed",
      code: row.responseCode ?? 201,
      body: row.responseBody ?? "",
    };
  }

  /** Row count for a key. The proof uses this as ground truth. */
  async countPayments(key: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(payments)
      .where(eq(payments.idempotencyKey, key));
    return row?.n ?? 0;
  }
}

function buildResponse(dto: CreatePaymentDto): PaymentResponse {
  return {
    payment_id: randomUUID(),
    amount: dto.amount,
    currency: dto.currency,
    reference: dto.reference,
    status: "succeeded",
    created_at: new Date().toISOString(),
  };
}
