/**
 * Applies migrations/*.sql in name order, each once, recording them in
 * schema_migrations. Run with DATABASE_URL set: `npm run migrate`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {} });
const dir = join(import.meta.dirname, "..", "migrations");

try {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  const applied = new Set(
    (await sql<{ name: string }[]>`select name from schema_migrations`).map(
      (row) => row.name,
    ),
  );
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    await sql.begin(async (tx) => {
      await tx.unsafe(readFileSync(join(dir, name), "utf8"));
      await tx`insert into schema_migrations (name) values (${name})`;
    });
    console.log(`applied ${name}`);
  }
  console.log("migrations up to date");
} finally {
  await sql.end();
}
