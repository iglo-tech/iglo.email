// Upstream schedules SIGHUP after accepted settings writes. Retry only a
// refused connection, where no request reached the server, until it is ready.
export async function settingsFetch(
  url: string,
  init: RequestInit,
  reference: boolean,
): Promise<Response> {
  const deadline = Date.now() + 5000;
  for (;;) {
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
        throw new Error(`FAIL settings-fetch-${method}-${reason}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
