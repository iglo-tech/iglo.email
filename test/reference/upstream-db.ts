import { command } from "@/test/reference/command";

// Reads one stored setting from the reference's own Postgres, not from the HTTP API. The
// `settings` table (listmonk queries/misc.sql at 6fcd95f) holds each key as JSON. The
// container is this run's, named by REFERENCE_DB_CONTAINER; `docker exec` reaches Postgres
// over its local socket, so no password leaves the harness. The key is a fixed literal.
export async function upstreamSetting(key: string): Promise<unknown> {
  const container = process.env.REFERENCE_DB_CONTAINER;
  const user = process.env.REFERENCE_DB_USER;
  const database = process.env.REFERENCE_DB_NAME;
  if (!container || !user || !database) {
    throw new Error("FAIL reference-db-unavailable");
  }
  if (!/^[a-z_.]+$/.test(key)) {
    throw new Error("FAIL reference-db-key");
  }
  const result = await command(
    [
      "docker",
      "exec",
      container,
      "psql",
      "-U",
      user,
      "-d",
      database,
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT value FROM settings WHERE key = '${key}'`,
    ],
    { timeout: 15_000 },
  );
  if (result.code !== 0) {
    throw new Error("FAIL reference-db-read");
  }
  const text = result.stdout.trim();
  if (text === "") {
    throw new Error("FAIL reference-db-missing");
  }
  return JSON.parse(text) as unknown;
}
