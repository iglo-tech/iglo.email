// B119: uploads that arrive over HTTP leave no bytes reachable after a forced collection. The
// measurement and the heap-snapshot evidence are in docs/perf/B119-media-buffer.md.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";

const MiB = 1024 * 1024;
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) {
    await close();
  }
});

/** The body of one multipart upload, built as one buffer so the request owns its bytes. */
function upload(index: number, headers: Record<string, string>, url: string) {
  const boundary = `----b119-${index}`;
  const head = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; ` +
      `filename="retained-${index}.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + 8 * MiB + tail.length);
  body.set(head, 0);
  body.fill(index & 0xff, head.length, head.length + 8 * MiB);
  body.set(tail, head.length + 8 * MiB);
  return fetch(url, {
    method: "POST",
    headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

/**
 * External memory after a full collection: the bytes of typed arrays made in JavaScript (a
 * request body, `Buffer.concat`) and of ArrayBuffers from native code. `arrayBuffers` alone
 * misses the first kind, so it cannot see an upload's body.
 */
function heldAfterCollection() {
  Bun.gc(true);
  Bun.gc(true);
  return process.memoryUsage().external;
}

test("uploads over HTTP leave no bytes reachable after a forced collection", async () => {
  const f = await campaignsFixture();
  cleanups.push(() => f.close());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => f.router.handle(f.app, request, "127.0.0.1"),
  });
  cleanups.push(() => server.stop(true));
  const headers = { ...f.sessionHeaders, origin: "http://fixture.test", host: "fixture.test" };
  const url = `http://127.0.0.1:${server.port}/api/media`;
  const base = heldAfterCollection();
  // Eight in flight at once: the admission limit (8 uploads in progress), so none is refused.
  const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => upload(i, headers, url)));
  expect(responses.map((response) => response.status)).toEqual(Array(8).fill(200));
  await Promise.all(responses.map((response) => response.text()));
  // Eight uploads of 8 MiB. Retaining every upload holds 64 MiB; the bound admits four uploads'
  // worth of allocator and collector noise, so any retention of a body fails it.
  expect(heldAfterCollection() - base).toBeLessThan(32 * MiB);
}, 30_000);
