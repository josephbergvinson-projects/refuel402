import { Client } from "pg";

// The destructive PostgreSQL suites TRUNCATE the same shared tables. Vitest runs
// test files in parallel workers, so without cross-process serialization whichever
// suite runs second loses rows the first is still asserting on. A session-scoped
// advisory lock on a dedicated connection serializes them wherever they are
// invoked from, so `npm test` cannot go spuriously red or silently green.
const DESTRUCTIVE_SUITE_LOCK_KEY = 402_402_403;

let holder: Client | null = null;

export async function acquireDestructiveSuiteLock(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [DESTRUCTIVE_SUITE_LOCK_KEY]);
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  holder = client;
}

export async function releaseDestructiveSuiteLock(): Promise<void> {
  const client = holder;
  holder = null;
  if (!client) return;
  await client.query("SELECT pg_advisory_unlock($1)", [DESTRUCTIVE_SUITE_LOCK_KEY]).catch(() => undefined);
  await client.end().catch(() => undefined);
}
