// B149a (14-projects sections 10 and 12, D158, D164): the instance hold reaches a project created
// while the server runs, and the instance Settings page's SMTP test respects every hold. The hold is
// placed in the data directory before the start, as a restore leaves it; everything after goes
// through HTTP: `/health`'s hold header, the SMTP test's answer and the loopback sink.
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstanceDatabase } from "@/projects/instance";
import { placeRestoreHold } from "@/settings/hold";
import { PRIMARY, createProject, openLifecycle } from "@/test/projects/lifecycle-fixture";
import type { LifecycleFixture } from "@/test/projects/lifecycle-fixture";
import { request } from "@/test/projects/fixture";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(60_000);

const SINCE = "2026-11-20T00:00:00.000Z";

const holdOf = async (port: number, host: string) =>
  (await request(port, host, "/health")).headers.get("x-iglo-email-hold");

/** The instance Settings page's test mail, pointed at `sinkPort`. */
const smtpTest = async (f: LifecycleFixture, sinkPort: number) => {
  const response = await f.call("POST", "/api/instance/settings/smtp/test", {
    email: "recipient@example.test",
    host: "127.0.0.1",
    port: sinkPort,
    tls_type: "none",
    auth_protocol: "none",
  });
  return { status: response.status, text: await response.text() };
};

test("a project created while instance.db is held starts held, and the SMTP test is refused", async () => {
  const sink = await startSink();
  const f = await openLifecycle(createRealClock(), {
    before: (dataDir) => {
      const db = openInstanceDatabase(dataDir, createRealClock());
      try {
        placeRestoreHold(db, SINCE);
      } finally {
        db.close();
      }
    },
  });
  try {
    expect(await holdOf(f.port, PRIMARY)).toBe(SINCE);
    await createProject(f, { slug: "late", name: "Late", hostname: "late.example.test" });
    // The new project is held from its first request: the instance's hold, not its own.
    expect(await holdOf(f.port, "late.example.test")).toBe(SINCE);
    // The instance SMTP test sends through the primary project: refused, and nothing is sent.
    const answer = await smtpTest(f, sink.port);
    expect(answer.status).toBe(503);
    expect(answer.text).toContain("Sending is held");
    expect(sink.messages).toHaveLength(0);
  } finally {
    await f.close();
    await sink.close();
  }
  expect(f.failures).toEqual([]);
});

test("the instance SMTP test is refused while the primary project's own database is held, and sends once released", async () => {
  const sink = await startSink();
  // A first start makes the primary project; its database is then held, as a restore of it leaves it.
  const first = await openLifecycle(createRealClock());
  const dataDir = first.dataDir;
  try {
    // Not held: the test mail reaches the sink.
    const sent = await smtpTest(first, sink.port);
    expect(sent.status).toBe(200);
    expect(sink.messages).toHaveLength(1);
  } finally {
    await first.close(true);
  }
  const f = await openLifecycle(createRealClock(), {
    dataDir,
    before: (directory) => {
      const db = new Database(join(directory, "projects", "main", "iglo-email.db"));
      try {
        placeRestoreHold(db, SINCE);
      } finally {
        db.close();
      }
    },
  });
  try {
    expect(await holdOf(f.port, PRIMARY)).toBe(SINCE);
    const answer = await smtpTest(f, sink.port);
    expect(answer.status).toBe(503);
    expect(answer.text).toContain("Sending is held");
    expect(sink.messages).toHaveLength(1);
  } finally {
    await f.close();
    await sink.close();
  }
  expect(f.failures).toEqual([]);
});
