// The HTML 429 of an archive page carries Retry-After (D138), through HTTP on the public fixture.
// The renderer is the one collaborator replaced: its capacity is full, as it is under load.
import { afterEach, expect, test } from "bun:test";
import { RenderCapacityError } from "@/templates/renderer";
import { publicFixture } from "@/test/public/fixture";
import type { PublicFixture } from "@/test/public/fixture";

const fixtures: Array<PublicFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open() {
  const f = await publicFixture();
  fixtures.push(f);
  return f;
}

test("an archive page that finds the renderer at capacity answers 429 with Retry-After: 1", async () => {
  const f = await open();
  f.db.run(
    `INSERT INTO campaigns (uuid, name, subject, from_email, body, content_type, status, type, messenger, max_subscriber_id, last_subscriber_id, archive, archive_slug, archive_meta)
     VALUES (?, 'c', 'Hello', 'a@b.test', ?, 'html', 'finished', 'regular', 'email', 0, 0, 1, 'hello', ?)`,
    [
      "33333333-3333-4333-8333-333333333333",
      "Hello {{ subscriber.name }}",
      JSON.stringify({ name: "Sample" }),
    ],
  );
  const renderer = f.owners.renderer;
  const compile = renderer.compile;
  renderer.compile = (request) => ({
    ...compile(request),
    renderSync() {
      throw new RenderCapacityError();
    },
  });

  const limited = await f.peer("/archive/hello", "192.0.2.60");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).toBe("1");
});
