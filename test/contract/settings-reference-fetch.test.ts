// The read after an invalid settings write (B114, B118g): the reference's exit line is searched for
// only after the log size recorded before that write, so an exit line from an earlier step never ends it.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { invalidSettingsReadEnd, upstreamLogSize } from "@/test/contract/settings-reference-fetch";

// The refused case waits out its deadline, which the test shortens; the default test timeout is 5 s.
setDefaultTimeout(30_000);

const EXIT = "'batch_size' cannot parse value as 'int'";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
  delete process.env.REFERENCE_LOG;
});

/** A reference log with `text`, and the URL of a loopback port that refuses connections. */
async function refusedUrl(): Promise<string> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
  const url = `http://127.0.0.1:${server.port}/api/settings`;
  await server.stop(true);
  return url;
}

function logWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "iglo-settings-log-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "reference.log");
  writeFileSync(path, text);
  process.env.REFERENCE_LOG = path;
  return path;
}

test("an exit line from before the write does not end the read: the read is unexpected", async () => {
  logWith(`boot failed: ${EXIT}\n`);
  const logFrom = upstreamLogSize();
  const end = await invalidSettingsReadEnd(await refusedUrl(), {}, logFrom, 300);
  expect(end).toBe("unexpected");
});

test("an exit line written after the write ends the read as exited", async () => {
  const path = logWith("earlier line\n");
  const logFrom = upstreamLogSize();
  appendFileSync(path, `reload: ${EXIT}\n`);
  const end = await invalidSettingsReadEnd(await refusedUrl(), {}, logFrom, 300);
  expect(end).toBe("exited");
});
