// A test-only ALTCHA v2 client: what a widget does with a SHA-256 challenge (altcha-lib-go v2.4.1
// SolveChallenge with a uint32 counter), producing the base64 payload the form posts.
export interface AltchaChallenge {
  parameters: {
    algorithm: string;
    nonce: string;
    salt: string;
    cost: number;
    keyLength: number;
    keyPrefix: string;
    expiresAt: number;
  };
  signature: string;
}

export function solveAltcha(challenge: AltchaChallenge, limit = 2_000_000) {
  const { salt, nonce, keyPrefix, keyLength } = challenge.parameters;
  const input = Buffer.concat([
    Buffer.from(salt, "hex"),
    Buffer.from(nonce, "hex"),
    Buffer.alloc(4),
  ]);
  for (let counter = 0; counter <= limit; counter++) {
    input.writeUInt32BE(counter, input.length - 4);
    const key = new Bun.CryptoHasher("sha256").update(input).digest().subarray(0, keyLength);
    const hex = key.toString("hex");
    if (hex.startsWith(keyPrefix)) return { counter, derivedKey: hex, time: 1.5 };
  }
  throw new Error("no solution");
}

export const altchaPayload = (
  challenge: AltchaChallenge,
  solution: { counter: number; derivedKey: string; time?: number } = solveAltcha(challenge),
) => btoa(JSON.stringify({ challenge, solution }));
