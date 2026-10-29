// Native D50 signing validation; SMTP's upstream model has no DKIM fields.
import { createPrivateKey } from "node:crypto";
import { HttpError } from "@/server/response";

export interface DKIM {
  domain_name: string;
  key_selector: string;
  private_key: string;
}
export function validateDKIM(value: DKIM): DKIM {
  const fail = (): never => {
    throw new HttpError(400, "Invalid DKIM configuration.");
  };
  if (
    !value ||
    typeof value.domain_name !== "string" ||
    typeof value.key_selector !== "string" ||
    typeof value.private_key !== "string"
  )
    return fail();
  const domain = value.domain_name;
  const selector = value.key_selector;
  if (
    domain.length > 253 ||
    selector.length > 253 ||
    !domain ||
    !selector ||
    !domain
      .split(".")
      .every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part)) ||
    !selector
      .split(".")
      .every((part) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part)) ||
    Buffer.byteLength(value.private_key) > 16384 ||
    !value.private_key ||
    value.private_key.includes("\0")
  )
    return fail();
  try {
    const key = createPrivateKey(value.private_key);
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) return fail();
  } catch {
    return fail();
  }
  return value;
}
