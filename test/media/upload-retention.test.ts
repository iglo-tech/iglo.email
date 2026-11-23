// B119: uploads that arrive over HTTP leave no bytes reachable after a forced collection. The
// measurement and the heap-snapshot evidence are in docs/perf/B119-media-buffer.md.
import { readdirSync, readlinkSync, statSync } from "node:fs";
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture } from "@/test/campaigns/fixture";

const MiB = 1024 * 1024;
/**
 * The most one upload's bytes may leave held after a forced collection. Normal growth is 0.3 to
 * 0.5 MiB (docs/perf/B119-media-buffer.md), and one retained 8 MiB body is above this limit.
 */
const RETAINED_LIMIT = 4 * MiB;
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
 * Bytes held in memfd files of this process: the store Bun gives a large Blob or File on Linux,
 * which is the upload's copy of its body. `external` does not count it, and neither does
 * `arrayBuffers`. It is read from /proc, which only Linux has (the harness is Linux-only, D89), so
 * it is null elsewhere.
 */
function memfdBytes(): number | null {
  if (process.platform !== "linux") {
    return null;
  }
  let total = 0;
  for (const fd of readdirSync("/proc/self/fd")) {
    const path = `/proc/self/fd/${fd}`;
    try {
      if (readlinkSync(path).startsWith("/memfd:")) {
        total += statSync(path).size;
      }
    } catch {
      // The descriptor closed between the listing and the read, so it holds nothing now.
    }
  }
  return total;
}

/**
 * What a full collection leaves held. `external` covers typed arrays made in JavaScript (a request
 * body, `Buffer.concat`) and native ArrayBuffers (`arrayBuffer()`); it does not cover the memfd
 * store of a Blob or File, which is why the memfd bytes are read too.
 */
function heldAfterCollection() {
  Bun.gc(true);
  Bun.gc(true);
  return { external: process.memoryUsage().external, memfd: memfdBytes() };
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
  // Eight uploads of 8 MiB. Keeping one body, or one File's store, leaves 8 MiB held: above the
  // limit. Keeping all eight leaves 64 MiB.
  const held = heldAfterCollection();
  expect(held.external - base.external).toBeLessThan(RETAINED_LIMIT);
  // Off Linux there is no /proc, so memfd bytes are null and this check is skipped; the external
  // check above still runs there.
  if (base.memfd !== null && held.memfd !== null) {
    expect(held.memfd - base.memfd).toBeLessThan(RETAINED_LIMIT);
  }
}, 30_000);
