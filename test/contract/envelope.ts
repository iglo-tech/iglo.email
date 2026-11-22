// The listmonk error envelope, as the shared contracts compare it. An owned API error also carries
// a stable `code` (B131, D129), which listmonk's envelope does not have. Call this on error bodies
// only. In normal mode the body must carry one of the known codes, so an owned error that loses its
// code fails; the code is then dropped, and the rest is compared with listmonk's words. The reference
// answers no `code`, so its body is returned as it is.
import { ERROR_CODES } from "@/server/error-codes";
import type { Mode } from "@/test/contract/types";

export function listmonkEnvelope(body: unknown, mode: Mode): unknown {
  if (mode === "reference") {
    return body;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("FAIL error-envelope: an owned error is not a JSON object");
  }
  const { code, ...rest } = body as { code?: unknown };
  if (typeof code !== "string" || !ERROR_CODES.some((known) => known === code)) {
    throw new Error("FAIL error-code: an owned error carries no known code");
  }
  return rest;
}
