/**
 * The database connection. Server-only.
 *
 * - With DATABASE_URL set (the Postgres address of your Supabase project) every
 *   server shares that one database. This is what a hosted site must use.
 * - Without it, a small Postgres database stored in data/pglite on this
 *   computer is used, so the site can be developed and tested with no account.
 *
 * Both understand the same SQL, so nothing else in the code knows the difference.
 */
import path from "node:path";
import { SCHEMA } from "./schema";

type Runner = {
  query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>;
  exec: (sql: string) => Promise<unknown>;
};

// Kept on globalThis so a code reload during development reuses the open
// database instead of opening the same local files twice.
const shared = globalThis as { __beautshyDb?: Promise<Runner> | undefined };

async function connect(): Promise<Runner> {
  const url = process.env["DATABASE_URL"];
  let runner: Runner;
  if (url) {
    const { default: pg } = await import("pg");
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: 10,
      // Hosted Postgres requires an encrypted connection.
      ...(local ? {} : { ssl: await sslOptions() }),
    });
    pool.on("error", (err) => console.error("[db] connection error:", err));
    runner = {
      query: (sql, params) => pool.query(sql, params),
      exec: (sql) => pool.query(sql),
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    // Tests get a fresh database in memory; otherwise it is kept in data/pglite.
    const folder = process.env["VITEST"] ? undefined : path.join(process.cwd(), "data", "pglite");
    if (folder) {
      console.warn(
        "[db] DATABASE_URL is not set: using the local database in data/pglite. " +
          "A hosted site must set DATABASE_URL, or its data is lost on every restart.",
      );
    }
    const db = new PGlite(folder);
    runner = {
      query: (sql, params) => db.query(sql, params),
      exec: (sql) => db.exec(sql),
    };
  }
  await runner.exec(SCHEMA);
  return runner;
}

/** Supabase's own certificate authority (public, not a secret). */
const CA_FILE = path.join(process.cwd(), "certs", "supabase-ca.crt");

/**
 * With Supabase's certificate in certs/supabase-ca.crt, the database's identity
 * is checked, so nobody between this server and Supabase can pretend to be it.
 * Without the file the connection is still encrypted but not checked, and a
 * warning is logged. Get the file from the Supabase dashboard: Database
 * Settings > SSL Configuration > Download certificate.
 */
async function sslOptions(): Promise<{ rejectUnauthorized: boolean; ca?: string }> {
  try {
    const { readFile } = await import("node:fs/promises");
    return { rejectUnauthorized: true, ca: await readFile(CA_FILE, "utf8") };
  } catch {
    console.warn(
      "[db] certs/supabase-ca.crt is missing: the database connection is encrypted " +
        "but the database's certificate is not checked.",
    );
    return { rejectUnauthorized: false };
  }
}

/** Run one SQL statement and return its rows. Values go in `params` ($1, $2, ...). */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  shared.__beautshyDb ??= connect().catch((err: unknown) => {
    shared.__beautshyDb = undefined; // try again on the next request
    throw err;
  });
  const runner = await shared.__beautshyDb;
  return (await runner.query(sql, params)).rows as T[];
}
