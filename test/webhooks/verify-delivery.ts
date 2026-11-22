import { createHmac, timingSafeEqual } from "node:crypto";

/** Seconds either side of the signed time that a delivery may carry. */
const TOLERANCE_SECONDS = 300;

export interface Delivery {
  id: string;
  event: string;
  occurred_at: string;
  data: unknown;
}

/**
 * Verify one delivery and return it. `raw` is the exact request body, `header` is the
 * X-Iglo-Email-Signature value, `secrets` are the current secret and any rotated one still in its
 * overlap, and `applied(id)` tells whether this delivery id was already applied. Throws on failure.
 */
export function verifyDelivery(
  raw: string,
  header: string,
  secrets: ReadonlyArray<string>,
  applied: (id: string) => boolean,
  now = Date.now() / 1000,
): Delivery {
  const time = Number(/(?:^|,)t=(\d+)/.exec(header)?.[1]);
  if (!Number.isSafeInteger(time) || Math.abs(now - time) > TOLERANCE_SECONDS) {
    throw new Error("bad_timestamp");
  }
  const given = [...header.matchAll(/v1=([0-9a-f]{64})/g)].map(([, hex]) =>
    Buffer.from(hex ?? "", "hex"),
  );
  const valid = secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${time}.${raw}`).digest();
    return given.some((signature) => timingSafeEqual(signature, expected));
  });
  if (!valid) {
    throw new Error("bad_signature");
  }
  const delivery: Delivery = JSON.parse(raw);
  if (applied(delivery.id)) {
    throw new Error("replay");
  }
  return delivery;
}
