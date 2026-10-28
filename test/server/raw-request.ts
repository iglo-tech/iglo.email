// Send exact request targets without fetch's URL normalization; each owns its connection.
import { request } from "node:http";

interface RawOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  responseHeaders?: readonly string[];
}

export function rawRequest(origin: string, path: string, options: RawOptions = {}) {
  const url = new URL(origin);
  if (url.protocol !== "http:") throw new Error("Raw test requests require HTTP");
  return new Promise<{
    status: number;
    contentType: string | null;
    body: string;
    headers?: Readonly<Record<string, string | null>>;
  }>((resolve, reject) => {
    const call = request(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: url.port,
        path,
        method: options.method ?? "GET",
        agent: false,
        headers: { Connection: "close", ...options.headers },
        signal: options.signal,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > 1_000_000) call.destroy(new Error("Response exceeds size limit"));
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? null,
            body,
            ...(options.responseHeaders
              ? {
                  headers: Object.fromEntries(
                    options.responseHeaders.map((name) => {
                      const value = response.headers[name.toLowerCase()];
                      return [
                        name.toLowerCase(),
                        Array.isArray(value) ? value.join(", ") : (value ?? null),
                      ];
                    }),
                  ),
                }
              : {}),
          }),
        );
      },
    );
    const timer = setTimeout(() => call.destroy(new Error("Raw test request timed out")), 5_000);
    call.once("close", () => clearTimeout(timer));
    call.once("error", reject);
    call.end(options.body);
  });
}

export function rawGet(origin: string, path: string, headers: Record<string, string> = {}) {
  return rawRequest(origin, path, { headers });
}
