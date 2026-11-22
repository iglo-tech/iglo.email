// The listmonk error envelope, as the shared contracts compare it. Every API error also carries a
// stable `code` (B131, D129), which listmonk's envelope does not have: the contracts check that
// additive field where it matters (test/events, test/server), and compare the rest here. The
// reference answers no `code`, so the same comparison holds for both targets.
import { ERROR_CODES } from "@/server/error-codes";

/** The body without its stable error `code`, when the body is an error envelope that carries one. */
export function listmonkEnvelope(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return body;
  }
  const { code, ...rest } = body as { code?: unknown };
  if (typeof code !== "string" || !ERROR_CODES.some((known) => known === code)) {
    return body;
  }
  return rest;
}
