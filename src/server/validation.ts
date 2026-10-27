// Small validation boundaries are adapted from listmonk's cmd/handlers.go and cmd/utils.go.
import type { Middleware, RequestContext } from "@/server/context";
import { HttpError } from "@/server/response";

export const hasID: Middleware = (context, next) => {
  const raw = context.params.id ?? "";
  if (!/^[+-]?\d+$/.test(raw)) throw new HttpError(400, "invalid ID");
  const value = BigInt(raw);
  if (value < 1n || value > 9223372036854775807n) throw new HttpError(400, "invalid ID");
  context.id = value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  return next();
};

export function getID(context: RequestContext): number | bigint {
  if (context.id === undefined) throw new Error("ID middleware is required");
  return context.id;
}

// Go's len(string) counts UTF-8 bytes, not JavaScript UTF-16 code units.
export function strHasLen(value: string, min: number, max: number): boolean {
  const length = new TextEncoder().encode(value).length;
  return length >= min && length <= max;
}

export async function bindJSON(request: Request): Promise<unknown> {
  let body: string;
  try {
    body = await request.text();
  } catch {
    throw new HttpError(400);
  }
  // Echo leaves input fields at their defaults when there is nothing to bind.
  if (body.length === 0) return {};
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") throw new HttpError(415);
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400);
  }
}
