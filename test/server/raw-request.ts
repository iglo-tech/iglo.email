// Send an exact request target for URI cases that fetch normalizes before sending.
import { request } from "node:http";

export function rawGet(origin: string, path: string, headers: Record<string, string> = {}) {
  const url = new URL(origin);
  if (url.protocol !== "http:") throw new Error("Raw test requests require HTTP");
  return new Promise<{ status: number; contentType: string | null; body: string }>(
    (resolve, reject) => {
      const call = request(
        {
          hostname: url.hostname,
          port: url.port,
          path,
          agent: false,
          headers: { Connection: "close", ...headers },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              contentType: response.headers["content-type"] ?? null,
              body,
            }),
          );
        },
      );
      call.setTimeout(5_000, () => call.destroy(new Error("Raw test request timed out")));
      call.once("error", reject);
      call.end();
    },
  );
}
