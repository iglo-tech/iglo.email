// Adapted from listmonk internal/captcha/captcha.go at 6fcd95f, and the parts of
// github.com/altcha-org/altcha-lib-go/v2 v2.4.1 (altcha.go, algorithms.go, canonical_json.go)
// it calls: CreateChallenge with a deterministic counter and DeriveKeySHA, and VerifySolution's
// re-derive path. Only the challenge shape listmonk issues is produced or accepted
// (docs/design/07-api-and-ui.md, D72).
import { randomInt } from "node:crypto";
import type { Clock } from "@/clock";

export type Provider = "" | "altcha" | "hcaptcha";

/** security.captcha as stored. */
export interface CaptchaOptions {
  altcha: { enabled: boolean; complexity: number };
  hcaptcha: { enabled: boolean; key: string; secret: string };
}

/** captcha.New: ALTCHA wins when both are enabled. */
export function captchaProvider(options: CaptchaOptions): Provider {
  if (options.altcha.enabled) return "altcha";
  if (options.hcaptcha.enabled) return "hcaptcha";
  return "";
}

export interface Captcha {
  /** GenerateChallenge for ALTCHA: the JSON text of a signed challenge. */
  challenge(complexity: number): Promise<string>;
  /** Verify: never throws; any error is a refusal. */
  verify(provider: Provider, value: string): Promise<boolean>;
}

export interface CaptchaDeps {
  clock: Clock;
  options: () => CaptchaOptions;
  /** hCaptcha siteverify; tests pass a local fake. */
  hcaptchaUrl?: string;
  /** Used signatures held at once; past this, ALTCHA refuses until some expire. */
  maxUsed?: number;
}

export const hcaptchaUrl = "https://hcaptcha.com/siteverify";
const challengeTtlMs = 5 * 60_000;
const hcaptchaTimeoutMs = 5_000;
const hcaptchaMaxBody = 64 * 1024;
/** A genuine payload is under 1 KiB; this bounds decoding and parsing. */
const maxPayload = 4096;
const saltLength = 16;
const nonceLength = 16;
const keyLength = 32;
const keyPrefixLength = keyLength / 2;
const hexPattern = /^(?:[0-9a-f]{2})*$/;
const encoder = new TextEncoder();

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** The challenge parameters listmonk issues; altcha-lib signs exactly these keys. */
interface Parameters {
  algorithm: "SHA-256";
  nonce: string;
  salt: string;
  cost: 1;
  keyLength: 32;
  keyPrefix: string;
  expiresAt: number;
}

/** canonicalJSON of those parameters: keys sorted, no whitespace. Values are hex or integers. */
function canonical(p: Parameters): string {
  return (
    `{"algorithm":${JSON.stringify(p.algorithm)},"cost":${p.cost},"expiresAt":${p.expiresAt},` +
    `"keyLength":${p.keyLength},"keyPrefix":"${p.keyPrefix}","nonce":"${p.nonce}","salt":"${p.salt}"}`
  );
}

/** DeriveKeySHA with cost 1: SHA-256(salt || nonce || uint32be(counter)), keyLength bytes. */
async function deriveKey(salt: Uint8Array, nonce: Uint8Array, counter: number) {
  const input = new Uint8Array(salt.length + nonce.length + 4);
  input.set(salt, 0);
  input.set(nonce, salt.length);
  new DataView(input.buffer).setUint32(salt.length + nonce.length, counter, false);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return digest.slice(0, keyLength);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isUint = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/** Go's base64.StdEncoding.DecodeString, which also skips CR and LF. */
function decodeBase64(text: string): string | undefined {
  const compact = text.replace(/[\r\n]/g, "");
  if (compact.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return undefined;
  return Buffer.from(compact, "base64").toString("utf8");
}

/** The challenge and solution of a payload, or undefined for any shape altcha-lib would not sign. */
function parsePayload(value: string) {
  if (value.length > maxPayload) return undefined;
  const json = decodeBase64(value);
  if (json === undefined) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isObject(payload) || !isObject(payload.challenge) || !isObject(payload.solution))
    return undefined;
  const { parameters: p, signature } = payload.challenge;
  const { counter, derivedKey } = payload.solution;
  if (!isObject(p) || typeof signature !== "string" || typeof derivedKey !== "string")
    return undefined;
  if (!isUint(counter, 0xffff_ffff)) return undefined;
  // Keys altcha-lib would add to the signed text are never issued here, so they cannot verify.
  for (const key of ["keySignature", "memoryCost", "parallelism"])
    if (p[key] !== undefined && p[key] !== null && p[key] !== "" && p[key] !== 0) return undefined;
  if (p.data !== undefined && p.data !== null) return undefined;
  const parameters = {
    algorithm: p.algorithm,
    nonce: p.nonce,
    salt: p.salt,
    cost: p.cost,
    keyLength: p.keyLength,
    keyPrefix: p.keyPrefix,
    expiresAt: p.expiresAt,
  };
  if (
    parameters.algorithm !== "SHA-256" ||
    parameters.cost !== 1 ||
    parameters.keyLength !== keyLength ||
    typeof parameters.nonce !== "string" ||
    typeof parameters.salt !== "string" ||
    typeof parameters.keyPrefix !== "string" ||
    !hexPattern.test(parameters.nonce) ||
    !hexPattern.test(parameters.salt) ||
    !hexPattern.test(parameters.keyPrefix) ||
    !parameters.keyPrefix ||
    !Number.isSafeInteger(parameters.expiresAt) ||
    !/^[0-9a-f]{64}$/.test(signature)
  )
    return undefined;
  return { parameters: parameters as Parameters, signature, counter, derivedKey };
}

/** A body of at most `limit` bytes, or undefined past it. */
async function boundedText(response: Response, limit: number): Promise<string | undefined> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createCaptcha(deps: CaptchaDeps): Promise<Captcha> {
  const maxUsed = deps.maxUsed ?? 50_000;
  const verifyUrl = () => deps.hcaptchaUrl ?? hcaptchaUrl;
  // captcha.New draws a random HMAC key per process. Challenges do not outlive a restart, so
  // used signatures need no rows: after a restart none of them verifies (D69: one process).
  const key = await crypto.subtle.importKey(
    "raw",
    random(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  /** Signature to expiry in ms. tmptokens with a 5 minute TTL upstream. */
  const used = new Map<string, number>();
  let lastSweep = 0;
  const sweep = (now: number) => {
    if (now - lastSweep < 1000) return;
    lastSweep = now;
    for (const [signature, expires] of used) if (expires < now) used.delete(signature);
  };

  async function challenge(complexity: number): Promise<string> {
    const limit = Math.min(complexity < 0 ? 30_000 : complexity, 0xffff_ffff);
    const counter = randomInt(0, limit + 1);
    const salt = random(saltLength);
    const nonce = random(nonceLength);
    const derived = await deriveKey(salt, nonce, counter);
    const parameters: Parameters = {
      algorithm: "SHA-256",
      nonce: toHex(nonce),
      salt: toHex(salt),
      cost: 1,
      keyLength,
      keyPrefix: toHex(derived.subarray(0, keyPrefixLength)),
      expiresAt: Math.floor((deps.clock.now().getTime() + challengeTtlMs) / 1000),
    };
    const signature = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(parameters))),
    );
    // json.Marshal(challenge): the field order of altcha-lib's structs.
    return JSON.stringify({ parameters, signature: toHex(signature) });
  }

  async function verifyAltcha(value: string): Promise<boolean> {
    const payload = parsePayload(value);
    if (!payload) return false;
    const { parameters, signature } = payload;
    // isExpired: expiresAt < now in seconds, with sub-second precision.
    if (parameters.expiresAt * 1000 < deps.clock.now().getTime()) return false;
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "hex"),
      encoder.encode(canonical(parameters)),
    );
    if (!valid) return false;
    const derived = await deriveKey(
      Buffer.from(parameters.salt, "hex"),
      Buffer.from(parameters.nonce, "hex"),
      payload.counter,
    );
    const expected = toHex(derived);
    if (payload.derivedKey !== expected || !expected.startsWith(parameters.keyPrefix)) return false;
    // Disallow token reuse. The check and the mark run without an await between them.
    const now = deps.clock.now().getTime();
    sweep(now);
    if (used.has(signature) || used.size >= maxUsed) return false;
    used.set(signature, parameters.expiresAt * 1000);
    return true;
  }

  async function verifyHCaptcha(token: string): Promise<boolean> {
    try {
      const response = await fetch(verifyUrl(), {
        method: "POST",
        body: new URLSearchParams({ secret: deps.options().hcaptcha.secret, response: token }),
        redirect: "error",
        signal: AbortSignal.timeout(hcaptchaTimeoutMs),
      });
      const text = await boundedText(response, hcaptchaMaxBody);
      if (!response.ok || text === undefined) return false;
      const body = JSON.parse(text) as unknown;
      return isObject(body) && body.success === true;
    } catch {
      return false;
    }
  }

  return {
    challenge,
    async verify(provider, value) {
      if (!value) return false;
      try {
        if (provider === "altcha") return await verifyAltcha(value);
        if (provider === "hcaptcha") return await verifyHCaptcha(value);
      } catch {
        /* Refused below. */
      }
      return false;
    },
  };
}
