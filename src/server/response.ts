// JSON responses and HTTP errors are adapted from listmonk's cmd/handlers.go
// and Echo v5.4.0's JSON and default HTTP error handler.
import { STATUS_CODES } from "node:http";
import { defaultErrorCode } from "@/server/error-codes";
import type { ErrorCode } from "@/server/error-codes";

/** What an error carries beside `message` and `code` (B131, D129). */
export interface ErrorDetails {
  /**
   * The subscriber holding an address the request named, when the caller may see it: its external
   * ID, which is `null` when that subscriber has none (D129).
   */
  conflict?: { external_id: string | null };
}

/**
 * `Retry-After` for a 429 or 503 whose route names no wait (B131): a retry is worth trying after
 * this many seconds. A route with a known wait (a limiter's window) sends its own.
 */
const RETRY_AFTER_SECONDS = new Map<number, string>([
  [429, "1"],
  [503, "30"],
]);

function json(value: unknown, status: number): Response {
  const body = JSON.stringify(value)
    .replaceAll("<", String.raw`\u003c`)
    .replaceAll(">", String.raw`\u003e`)
    .replaceAll("&", String.raw`\u0026`)
    .replaceAll("\u2028", String.raw`\u2028`)
    .replaceAll("\u2029", String.raw`\u2029`);
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
    readonly code: ErrorCode = defaultErrorCode(status),
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** The headers an error sends: its own, and `Retry-After` for a 429 or 503 that names none. */
function errorHeaders(error: HttpError): Headers {
  const headers = new Headers(error.headers);
  const retry = RETRY_AFTER_SECONDS.get(error.status);
  if (retry !== undefined && !headers.has("Retry-After")) {
    headers.set("Retry-After", retry);
  }
  return headers;
}

export function errorResponse(error: HttpError, method: string): Response {
  const headers = errorHeaders(error);
  if (method === "HEAD") {
    return new Response(null, { status: error.status, headers });
  }
  const response = json(
    {
      message: error.message || STATUS_CODES[error.status] || "",
      code: error.code,
      ...error.details,
    },
    error.status,
  );
  for (const [name, value] of headers) {
    response.headers.set(name, value);
  }
  return response;
}
