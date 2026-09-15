import {
  Global,
  Inject,
  Module,
  type OnApplicationShutdown,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

import * as schema from "./schema";

export const PG_POOL = Symbol("PG_POOL");
export const DB = Symbol("DB");

export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>("DATABASE_URL"),
          // Deliberately far below the burst size. Losers must release their
          // connection immediately; if they hold it, the experiment measures
          // queueing rather than correctness.
          max: Number(config.get("PG_POOL_MAX") ?? 20),
          idleTimeoutMillis: 30_000,
        });

        await waitForDatabase(pool);
        await applyMigration(pool);
        return pool;
      },
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Db => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown() {
    await this.pool.end();
  }
}

async function waitForDatabase(pool: Pool) {
  const log = new Logger("Db");
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      log.warn(`database not ready, attempt ${attempt}/30`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("database never became ready");
}

// Both instances race to run this on boot, which is why the SQL is written
// with IF NOT EXISTS throughout.
async function applyMigration(pool: Pool) {
  const candidates = [
    join(process.cwd(), "migrations", "0001_schema.sql"),
    join(__dirname, "..", "..", "migrations", "0001_schema.sql"),
  ];
  for (const path of candidates) {
    try {
      const sql = await readFile(path, "utf8");
      await pool.query(sql);
      new Logger("Db").log(`applied ${path}`);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  throw new Error("0001_schema.sql not found");
}
