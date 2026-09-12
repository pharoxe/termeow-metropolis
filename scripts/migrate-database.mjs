import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run database migrations.");

const sql = postgres(databaseUrl, { max: 1, idle_timeout: 10, connect_timeout: 15, connection: { application_name: "termeow-migrator" } });
const directory = path.resolve("db/migrations");

try {
  await sql.unsafe("CREATE SCHEMA IF NOT EXISTS termeow");
  await sql.unsafe("CREATE TABLE IF NOT EXISTS termeow.schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const files = (await readdir(directory)).filter((file) => /^\d+.*\.sql$/.test(file)).sort();
  for (const file of files) {
    const applied = await sql`SELECT 1 FROM termeow.schema_migrations WHERE version = ${file}`;
    if (applied.length) continue;
    const source = await readFile(path.join(directory, file), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(source);
      await tx`INSERT INTO termeow.schema_migrations (version) VALUES (${file})`;
    });
    console.log(`Applied ${file}`);
  }
} finally {
  await sql.end();
}
