import { Client } from "pg";
import type { Ledger } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Read-only view of what the database actually contains for one key.
 *
 * The lab hinges on the difference between what the customer was told and
 * what was actually written. Without real rows, the right pane would just be
 * the left pane in a different font.
 */
export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key");
  if (!key) return Response.json({ error: "key required" }, { status: 400 });

  const dsn = process.env.DATABASE_URL;
  if (!dsn) {
    return Response.json({
      payments: [],
      keyRow: null,
      available: false,
      reason: "DATABASE_URL is not set, so the lab cannot show you real rows.",
    } satisfies Ledger);
  }

  const client = new Client({ connectionString: dsn });
  try {
    await client.connect();
    const payments = await client.query(
      `SELECT id, amount, currency, reference, created_at
         FROM payments WHERE idempotency_key = $1 ORDER BY created_at`,
      [key],
    );
    const keyRow = await client.query(
      `SELECT key, status, response_code, response_body, request_hash, created_at
         FROM idempotency_keys WHERE key = $1`,
      [key],
    );

    return Response.json({
      payments: payments.rows,
      keyRow: keyRow.rows[0] ?? null,
      available: true,
    } satisfies Ledger);
  } catch (err) {
    return Response.json({
      payments: [],
      keyRow: null,
      available: false,
      reason: err instanceof Error ? err.message : "database unreachable",
    } satisfies Ledger);
  } finally {
    await client.end().catch(() => {});
  }
}
