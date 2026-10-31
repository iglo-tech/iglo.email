// JSON responses and HTTP errors are adapted from listmonk's cmd/handlers.go
// and Echo v5.4.0's JSON and default HTTP error handler.
import { STATUS_CODES } from "node:http";

function json(value: unknown, status: number): Response {
  const body = JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return new Response(`${body}\n`, { status, headers: { "Content-Type": "application/json" } });
}

export function ok(data: unknown, status = 200, extra: Record<string, unknown> = {}): Response {
  return json({ data, ...extra }, status);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message = "",
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function errorResponse(error: HttpError, method: string): Response {
  if (method === "HEAD")
    return new Response(null, { status: error.status, headers: error.headers });
  const response = json(
    { message: error.message || STATUS_CODES[error.status] || "" },
    error.status,
  );
  for (const [name, value] of Object.entries(error.headers)) response.headers.set(name, value);
  return response;
}
