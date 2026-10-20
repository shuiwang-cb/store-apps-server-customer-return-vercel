import postgres from "postgres";

import { env } from "./env";

/**
 * One pool per server instance (kept across hot reloads in dev). `prepare:
 * false` because Supabase's transaction pooler does not support prepared
 * statements.
 */
const globalForSql = globalThis as unknown as { sql?: postgres.Sql };

export function db(): postgres.Sql {
  globalForSql.sql ??= postgres(env.databaseUrl(), {
    prepare: false,
    max: 5,
    idle_timeout: 20,
  });
  return globalForSql.sql;
}

export type Tx = postgres.TransactionSql;
