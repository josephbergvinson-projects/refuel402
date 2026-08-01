import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  application_name: "refuel402-schema-proof",
});

const expected = [
  "refuel402_sponsorships",
  "refuel402_nonce_reservations",
  "refuel402_payment_identities",
  "refuel402_rate_limit_buckets",
  "refuel402_product_quotes",
  "refuel402_product_journeys",
  "refuel402_product_payments",
  "refuel402_product_authorizations",
  "refuel402_product_events",
];

try {
  const rows = [];
  for (const table of expected) {
    const relation = await pool.query<{ relation: string | null }>(
      "SELECT to_regclass($1)::text AS relation",
      [`public.${table}`],
    );
    const exists = relation.rows[0]?.relation === table;
    let count: number | null = null;
    if (exists) {
      const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
      count = Number(result.rows[0]?.count ?? 0);
    }
    rows.push({ table, exists, count });
  }
  const database = await pool.query<{ current_database: string; postmaster_started_at: string }>(
    "SELECT current_database(), pg_postmaster_start_time()::text AS postmaster_started_at",
  );
  console.log(JSON.stringify({
    schema: "refuel402.postgres-schema-proof.v1",
    checkedAt: new Date().toISOString(),
    readOnly: true,
    database: database.rows[0]?.current_database ?? null,
    postmasterStartedAt: database.rows[0]?.postmaster_started_at ?? null,
    tables: rows,
  }, null, 2));
  if (rows.some((row) => !row.exists)) process.exitCode = 1;
} finally {
  await pool.end();
}
