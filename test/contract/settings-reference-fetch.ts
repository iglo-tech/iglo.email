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
      return await fetch(url, init);
    } catch (error) {
      if (
        !reference ||
        (error as { code?: string }).code !== "ECONNREFUSED" ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
