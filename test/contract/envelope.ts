// The listmonk error envelope, as the shared contracts compare it. An owned API error also carries
// a stable `code` (B131, D129), which listmonk's envelope does not have. Call this on error bodies
// only, with the status they were answered with. In normal mode the body must carry a code that
// belongs to that status (src/server/error-codes.ts), so an owned error that loses its code, or
// carries another status's, fails; the code is then dropped, and the rest is compared with
// listmonk's words. The reference answers no `code`, so its body is returned as it is.
import { errorCodesFor } from "@/server/error-codes";
import type { Mode } from "@/test/contract/types";

export function listmonkEnvelope(body: unknown, mode: Mode, status: number): unknown {
  if (mode === "reference") {
    return body;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("FAIL error-envelope: an owned error is not a JSON object");
  }
  const { code, ...rest } = body as { code?: unknown };
  if (typeof code !== "string" || !errorCodesFor(status).some((known) => known === code)) {
    throw new Error(`FAIL error-code: an owned ${status} carries no code of its status`);
  }
  return rest;
}
