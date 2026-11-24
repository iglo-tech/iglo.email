import { readFileSync, statSync } from "node:fs";
import { asBody } from "@/test/read-body";
import { upstreamSetting } from "@/test/reference/upstream-db";

// Go's time.ParseDuration grammar: "0", or signed runs of number and unit (ns, us, µs, μs, ms, s, m, h).
const GO_DURATION = /^(?:[-+]?(?:(?:\d+\.?\d*|\.\d+)(?:ns|us|µs|μs|ms|s|m|h))+|0)$/;

/**
 * After an accepted settings write, upstream's stored SMTP items must reload. An enabled item whose
 * idle_timeout or wait_timeout is not a Go duration makes the reloaded process exit at boot
 * (cmd/init.go:747, lo.Fatalf). The stored value is read from the reference's own database, not from
 * the HTTP projection, so the failure names the write that left it behind (B118k).
 */
export async function assertReloadable(reference: boolean, label: string): Promise<void> {
  if (!reference) {
    return;
  }
  const items = await upstreamSetting("smtp");
  if (!Array.isArray(items)) {
    throw new Error(`FAIL settings-reload-${label} (smtp is not a list)`);
  }
  for (const [index, item] of items.entries()) {
    const entry = asBody<Record<string, unknown>>(item);
    if (entry.enabled !== true) {
      continue;
    }
    for (const field of ["idle_timeout", "wait_timeout"]) {
      const value = entry[field];
      if (typeof value !== "string" || !GO_DURATION.test(value)) {
        throw new Error(`FAIL settings-reload-${label} (smtp[${index}].${field})`);
      }
    }
  }
}

// Last lines of the reference's own log, on one printable line, without credentials.
function upstreamLogTail(): string {
  const path = process.env.REFERENCE_LOG;
  if (!path) {
    return "";
  }
  try {
    let text = readFileSync(path, "utf-8").slice(-600);
    for (const secret of [process.env.REFERENCE_API_TOKEN, process.env.REFERENCE_API_USER]) {
      if (secret) {
        text = text.split(secret).join("[redacted]");
      }
    }
    const lines = text.split("\n").filter(Boolean).slice(-4);
    return ` log=${lines
      .join(" | ")
      .replaceAll(/[^ -~]/g, "?")
      .replaceAll("(", "[")
      .replaceAll(")", "]")}`;
  } catch {
    return "";
  }
}

// Upstream schedules SIGHUP after accepted settings writes. Retry only a
// refused connection, where no request reached the server, until it is ready.
export async function settingsFetch(
  url: string,
  init: RequestInit,
  reference: boolean,
): Promise<Response> {
  const started = Date.now();
  const deadline = started + 5000;
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const response = await fetch(url, init);
      const method = /^(GET|PUT|POST|DELETE)$/.test(init.method ?? "GET")
        ? (init.method ?? "GET")
        : "OTHER";
      const readJSON = response.json.bind(response);
      response.json = async () => {
        try {
          return asBody<unknown>(await readJSON());
        } catch {
          throw new Error(`FAIL settings-json-${method}-${response.status}`);
        }
      };
      return response;
    } catch (error) {
      if (
        !reference ||
        asBody<{ code?: string }>(error).code !== "ECONNREFUSED" ||
        Date.now() >= deadline
      ) {
        const method = /^(GET|PUT|POST|DELETE)$/.test(init.method ?? "GET")
          ? (init.method ?? "GET")
          : "OTHER";
        const code = asBody<{ code?: string }>(error).code;
        const reason = code === "ECONNREFUSED" ? "refused" : "other";
        const waited = Date.now() - started;
        const detail = `attempts=${attempts} waited=${waited}ms code=${code ?? "none"} reference=${reference}${reference ? upstreamLogTail() : ""}`;
        throw new Error(`FAIL settings-fetch-${method}-${reason} (${detail})`, { cause: error });
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }
}

const INVALID_BATCH_SIZE_EXIT = "'batch_size' cannot parse value as 'int'";

/**
 * Bytes the reference's log holds now. A caller records it before a write; the read then searches
 * only the log written after it.
 */
export function upstreamLogSize(): number {
  const path = process.env.REFERENCE_LOG;
  if (!path) {
    return 0;
  }
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

// Searches the log from byte `from` on, so an exit line written before the write cannot end the read.
function upstreamLogHas(text: string, from: number): boolean {
  const path = process.env.REFERENCE_LOG;
  if (!path) {
    return false;
  }
  try {
    return readFileSync(path).subarray(from).toString("utf-8").includes(text);
  } catch {
    return false;
  }
}

// Outcome of a read after upstream accepted an invalid settings value. That write
// schedules a reload which loads the stored value and exits. Either the running
// process answers the read with 500, or the read finds the listener already closed
// and the reference's log shows the failed boot. Only these two end states are
// accepted; a healthy 200 or any other status is "unexpected".
export type InvalidSettingsReadEnd = "500" | "exited" | "unexpected";

/**
 * `logFrom` is `upstreamLogSize()` taken before the invalid write, so only the log written after it
 * can show the failed boot (B114). `deadlineMs` bounds the wait for that line.
 */
export async function invalidSettingsReadEnd(
  url: string,
  init: RequestInit,
  logFrom: number,
  deadlineMs = 10_000,
): Promise<InvalidSettingsReadEnd> {
  let status: number | undefined;
  try {
    const response = await fetch(url, init);
    status = response.status;
    await response.text();
  } catch {
    // No response: refused or closed while the reload runs. The log decides below.
  }
  if (status === 500) {
    return "500";
  }
  if (status !== undefined) {
    return "unexpected";
  }
  // Upstream's awaitReload waits up to 3 s for shutdown before it respawns, and the
  // respawned process must then fail to boot, so the exit line can trail the refusal.
  const deadline = Date.now() + deadlineMs;
  while (!upstreamLogHas(INVALID_BATCH_SIZE_EXIT, logFrom)) {
    if (Date.now() >= deadline) {
      return "unexpected";
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
  return "exited";
}
