import { readFileSync } from "node:fs";

// Last lines of the reference's own log, on one printable line, without credentials.
function upstreamLogTail(): string {
  const path = process.env.REFERENCE_LOG;
  if (!path) {
    return "";
  }
  try {
    let text = readFileSync(path, "utf8").slice(-600);
    for (const secret of [process.env.REFERENCE_API_TOKEN, process.env.REFERENCE_API_USER]) {
      if (secret) text = text.split(secret).join("[redacted]");
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
          return await readJSON();
        } catch {
          throw new Error(`FAIL settings-json-${method}-${response.status}`);
        }
      };
      return response;
    } catch (error) {
      if (
        !reference ||
        (error as { code?: string }).code !== "ECONNREFUSED" ||
        Date.now() >= deadline
      ) {
        const method = /^(GET|PUT|POST|DELETE)$/.test(init.method ?? "GET")
          ? (init.method ?? "GET")
          : "OTHER";
        const code = (error as { code?: string }).code;
        const reason = code === "ECONNREFUSED" ? "refused" : "other";
        const waited = Date.now() - started;
        const detail = `attempts=${attempts} waited=${waited}ms code=${code ?? "none"} reference=${reference}${reference ? upstreamLogTail() : ""}`;
        throw new Error(`FAIL settings-fetch-${method}-${reason} (${detail})`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

const INVALID_BATCH_SIZE_EXIT = "'batch_size' cannot parse value as 'int'";

function upstreamLogHas(text: string): boolean {
  const path = process.env.REFERENCE_LOG;
  if (!path) {
    return false;
  }
  try {
    return readFileSync(path, "utf8").includes(text);
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

export async function invalidSettingsReadEnd(
  url: string,
  init: RequestInit,
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
  const deadline = Date.now() + 10_000;
  while (!upstreamLogHas(INVALID_BATCH_SIZE_EXIT)) {
    if (Date.now() >= deadline) {
      return "unexpected";
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return "exited";
}
