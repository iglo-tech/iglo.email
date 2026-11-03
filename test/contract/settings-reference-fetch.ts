// Upstream schedules SIGHUP after accepted settings writes. Retry only a
// refused connection, where no request reached the server, until it is ready.
export async function settingsFetch(
  url: string,
  init: RequestInit,
  reference: boolean,
): Promise<Response> {
  // A restart on a loaded host has outlasted a 5 s wait; the failure below says how long it waited.
  const started = Date.now();
  const deadline = started + 20_000;
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
        const detail = `attempts=${attempts} waited=${waited}ms code=${code ?? "none"} reference=${reference}`;
        throw new Error(`FAIL settings-fetch-${method}-${reason} (${detail})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
