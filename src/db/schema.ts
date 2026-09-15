import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    amount: bigint("amount", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    reference: text("reference").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("payments_idem_key_idx").on(t.idempotencyKey)],
);

// The arbiter. `key` is the primary key, so Postgres decides who wins a race
// between concurrent writers, inside the same transaction as the payment
// insert. No application code is involved in that decision.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").primaryKey(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull(),
    responseCode: integer("response_code"),
    // text, not jsonb. jsonb normalises key order and whitespace, so a replay
    // would return different bytes than the original response even though the
    // value is equal. Idempotency is a promise about bytes.
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    index("idempotency_keys_expires_idx").on(t.expiresAt),
    check("status_check", sql`${t.status} IN ('in_progress', 'completed')`),
    check(
      "completed_has_response",
      sql`${t.status} <> 'completed' OR (${t.responseCode} IS NOT NULL AND ${t.responseBody} IS NOT NULL)`,
    ),
  ],
);

export type Payment = typeof payments.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
