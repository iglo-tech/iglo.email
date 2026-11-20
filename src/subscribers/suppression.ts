// Keyed hashes that name a self-wiped person without storing their address or external ID (B124,
// D125). The secret is the database's own (migration 23), so a copy of the rows alone names nobody.
// Each input is prefixed by its kind, so an address and an external ID that spell the same text
// never collide.
import { createHmac } from "node:crypto";
import { trimSpace } from "@/lists/store";
import { simpleLower } from "@/subscribers/unicode-lower";

/** The address as the subscriber table stores it: trimmed and lower-cased, as sanitizeEmail does. */
export const normalisedEmail = (email: string) => simpleLower(trimSpace(email));

export const emailHash = (secret: Uint8Array, email: string) =>
  createHmac("sha256", secret)
    .update(`email:${normalisedEmail(email)}`)
    .digest("hex");

export const externalHash = (secret: Uint8Array, externalId: string) =>
  createHmac("sha256", secret).update(`external:${externalId}`).digest("hex");
