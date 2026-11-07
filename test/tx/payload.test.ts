// The journal payload at the boundary the tx send path uses (B26): what it accepts and what
// decoding it costs in memory.
import { expect, test } from "bun:test";
import { decodePayload, encodePayload } from "@/messaging/payload";

const message = (content: Uint8Array) => ({
  from: "a@example.test",
  to: ["b@example.test"],
  subject: "s",
  contentType: "html" as const,
  body: Buffer.from("<p>x</p>"),
  attachments: [{ name: "a.bin", content }],
});

test("an attachment round-trips and only canonical base64 is accepted back", () => {
  const content = new Uint8Array([0, 1, 2, 250, 251]);
  const payload = encodePayload(message(content), null);
  expect([...decodePayload(payload).message.attachments![0]!.content]).toEqual([...content]);
  const encoded = Buffer.from(content).toString("base64");
  const tampered = (value: string) => payload.replace(encoded, value);
  expect(encoded).toBe("AAEC+vs=");
  // Wrong length, a foreign character, early padding, whitespace and a non-zero trailing bit.
  for (const bad of ["AAEC+vs", "AAEC+v!=", "AA=C+vs=", "AAEC +vs=", "AAEC+vt=", "AAEC+vs==="])
    expect(() => decodePayload(tampered(bad))).toThrow();
});

test("decoding a 4 MiB attachment does not spike memory far above its size", async () => {
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/payload-memory-probe.ts`], {
    stdout: "pipe",
    stderr: "inherit",
  });
  const growth = Number(await new Response(child.stdout).text());
  expect(await child.exited).toBe(0);
  // A regex that repeats a four-character group kept a backtrack frame for each: ~140 MiB here.
  expect(growth).toBeLessThan(48 * 1024 * 1024);
}, 30_000);
