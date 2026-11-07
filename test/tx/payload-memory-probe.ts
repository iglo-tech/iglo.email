// Child process of payload.test.ts: prints how far peak RSS rises while a journal payload with a
// 4 MiB attachment is decoded (the kernel's high-water mark, so a short spike is seen).
import { readFileSync, writeFileSync } from "node:fs";
import { decodePayload, encodePayload } from "@/messaging/payload";

const peak = () =>
  Number(/VmHWM:\s+(\d+) kB/.exec(readFileSync("/proc/self/status", "utf8"))![1]) * 1024;
const content = new Uint8Array(4 * 1024 * 1024);
crypto.getRandomValues(content.subarray(0, 65536));
const payload = encodePayload(
  {
    from: "a@example.test",
    to: ["b@example.test"],
    subject: "s",
    contentType: "html",
    body: Buffer.from("<p>x</p>"),
    attachments: [{ name: "a.bin", content }],
  },
  null,
);
Bun.gc(true);
writeFileSync("/proc/self/clear_refs", "5");
const before = peak();
const decoded = decodePayload(payload);
if (decoded.message.attachments?.[0]?.content.byteLength !== content.byteLength)
  throw new Error("attachment lost");
process.stdout.write(String(peak() - before));
