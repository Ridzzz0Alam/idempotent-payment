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
   * NAIVE implementation: read the key, and if it is not there, write it.
   *
   * Correct in every sequential test. Wrong the moment two requests overlap,
   * because the SELECT and the INSERT are two separate decisions with a gap
   * between them, and the world changes in that gap.
   */
  async create(
    key: string,
    rawBody: Buffer,
    dto: CreatePaymentDto,
  ): Promise<Outcome> {
    const hash = createHash("sha256").update(rawBody).digest("hex");

    return this.db.transaction(async (tx) => {
      // ---- CHECK ---------------------------------------------------------
      const [existing] = await tx
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, key))
        .limit(1);

      if (existing) {
        if (existing.requestHash !== hash) return { kind: "mismatch" };
        if (existing.status !== "completed") return { kind: "in_progress" };
        return {
          kind: "replayed",
          code: existing.responseCode ?? 201,
          body: existing.responseBody ?? "",
        };
      }

      // ---- ...AND THEN ACT -----------------------------------------------
      // Every concurrent request that reached the CHECK before any of them
      // committed also arrives here. Nothing in the database stops them.
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

      await tx.insert(idempotencyKeys).values({
        key,
        requestHash: hash,
        status: "completed",
        responseCode: 201,
        responseBody: body,
      });

      return { kind: "created", code: 201, body };
    });
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
