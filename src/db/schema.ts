import { sql } from "drizzle-orm";
import {
  bigint,
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

// v0-naive. Note what is missing: `key` has no primary key and no unique
// index. Uniqueness is "enforced" by a SELECT in application code, which is
// only enforcement if the read and the write are atomic. They are not.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    key: text("key").notNull(),
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
  (t) => [index("idempotency_keys_key_idx").on(t.key)],
);

export type Payment = typeof payments.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
