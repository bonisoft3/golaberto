// The cluster's Postgres over the compose network, read as `psql -At` prints
// it: each value in Postgres' own text form, a row's values joined by `|`,
// rows by newlines, NULL as nothing. The checks run beside the stack, which
// hands them DATABASE_URL.

import postgres from "npm:postgres@3.4.9";

const url = Deno.env.get("DATABASE_URL");
if (url === undefined) throw new Error("DATABASE_URL is unset: the check runs beside the stack, which sets it");

type Rows = (Uint8Array | null)[][];

/** Runs a script of one statement or many, and answers every row any of them returned. */
export async function query(script: string): Promise<string> {
  // No type fetch: every value is read raw, so its round trip buys nothing.
  const sql = postgres(url!, { max: 1, onnotice: () => {}, fetch_types: false });
  try {
    // Simple protocol: a script, and values in their text form rather than parsed.
    const r = await sql.unsafe(script).simple().raw() as unknown as Rows & { command?: string };
    // One statement answers its rows; several answer one result each.
    const results: Rows[] = r.command === undefined ? r as unknown as Rows[] : [r];
    const text = new TextDecoder();
    return results.flatMap((rows) => rows.map((row) => row.map((v) => v === null ? "" : text.decode(v)).join("|"))).join("\n");
  } finally {
    await sql.end();
  }
}

/**
 * A refusal is the database's answer, not a failure of the query: an integrity
 * violation (SQLSTATE class 23). Anything else — a refused login, a database
 * still starting, a fixture's typo — is the run failing.
 */
export const refused = (e: unknown): e is InstanceType<typeof postgres.PostgresError> =>
  e instanceof postgres.PostgresError && e.code.startsWith("23");
