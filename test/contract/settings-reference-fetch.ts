import { readFileSync } from "node:fs";

// Last lines of the reference's own log, on one printable line, without credentials.
function upstreamLogTail(): string {
  const path = process.env.REFERENCE_LOG;
  if (!path) return "";
  try {
    let text = readFileSync(path, "utf8").slice(-600);
    for (const secret of [process.env.REFERENCE_API_TOKEN, process.env.REFERENCE_API_USER])
      if (secret) text = text.split(secret).join("[redacted]");
    const lines = text.split("\n").filter(Boolean).slice(-4);
    return ` log=${lines
      .join(" | ")
      .replace(/[^ -~]/g, "?")
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
  const deadline = started + 5_000;
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
        throw new Error(`FAIL settings-fetch-${method}-${reason} (${detail})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
