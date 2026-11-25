// B149a (14-projects section 10, D157, D164): the project delete's edges. Two deletes in one
// millisecond keep two snapshots; a delete that stops part way stays visible and is finished by the
// next one; the request drain is bounded on the instance clock; a streamed response cut by a delete
// ends without harming the instance; and a create during shutdown is refused or finished cleanly.
// In process, through the instance's own server and API, since each case needs a chosen moment.
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import {
  createProject,
  deleteProject,
  deletedDatabase,
  heldRequest,
  openLifecycle,
  projectCall,
  projectSession,
  serving,
} from "@/test/projects/lifecycle-fixture";
import { request, sessionHeaders } from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { TestClock } from "@/test/server/fixture";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

/** The one subscriber email in a final snapshot. */
function snapshotEmails(dataDir: string, database: string): Array<string> {
  const db = new Database(join(dataDir, database), { readonly: true });
  try {
    return db
      .query<{ email: string }, []>("SELECT email FROM subscribers ORDER BY email")
      .all()
      .map((row) => row.email);
  } finally {
    db.close();
  }
}

test("two deletes of one slug in the same millisecond keep two snapshots, neither overwritten", async () => {
  // The test clock never moves here: both deletes have the same timestamp.
  const f = await openLifecycle(new TestClock());
  const host = "twin.example.test";
  try {
    const archives: Array<string> = [];
    for (const name of ["first", "second"]) {
      await createProject(f, { slug: "twin", name, hostname: host });
      const session = await projectSession(f, host);
      const created = await projectCall(f, host, session, "POST", "/api/subscribers", {
        email: `${name}@twin.example.test`,
        name,
      });
      expect(created.status).toBe(200);
      const answer = await deleteProject(f, "twin");
      expect(answer.status).toBe(200);
      archives.push(deletedDatabase(answer.text));
    }
    expect(archives[0]).not.toBe(archives[1]);
    expect(snapshotEmails(f.dataDir, archives[0]!)).toEqual(["first@twin.example.test"]);
    expect(snapshotEmails(f.dataDir, archives[1]!)).toEqual(["second@twin.example.test"]);
    // (Reading a snapshot above leaves its -wal and -shm beside it.)
    expect(
      readdirSync(join(f.dataDir, "backups", "deleted"))
        .filter((name) => name.endsWith(".db") || name.endsWith(".tar"))
        .toSorted(),
    ).toEqual(archives.map((path) => path.slice("backups/deleted/".length)).toSorted());
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});

test("a delete that stops part way keeps the project listed with its error and off the routing table; the next delete finishes it", async () => {
  const f = await openLifecycle(createRealClock());
  const host = "stuck.example.test";
  try {
    await createProject(f, { slug: "stuck", name: "Stuck", hostname: host });
    const session = await projectSession(f, host);
    // Another process holds instance.db's write lock: the registry rows cannot go (busy, 5 s).
    const holder = new Database(join(f.dataDir, "instance.db"));
    holder.run("PRAGMA busy_timeout = 5000");
    holder.run("BEGIN IMMEDIATE");
    let failed: { status: number; text: string };
    try {
      failed = await deleteProject(f, "stuck");
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }
    expect(failed.status).toBe(500);
    expect(failed.text).toContain("Deleting project stuck stopped at its registry rows");

    // Consistent and visible: listed with its error, not served, not a leftover, not creatable.
    const listed = (
      await readJson<{ data: Array<{ slug: string; delete_error: string | null }> }>(
        await f.call("GET", "/api/instance/projects"),
      )
    ).data.find((project) => project.slug === "stuck");
    expect(listed?.delete_error).toContain("its registry rows");
    const page = await (await f.call("GET", "/admin/instance/projects")).text();
    expect(page).toContain('data-testid="project-delete-failed"');
    expect(page).not.toContain('data-testid="project-leftovers"');
    expect(await serving(f.port, host, session)).toBe(false);
    const again = await f.call("POST", "/api/instance/projects", {
      slug: "stuck",
      name: "Again",
      hostname: "again.example.test",
    });
    expect(again.status).toBe(409);
    expect(await f.logs()).toContain("Deleting project stuck stopped at its registry rows");

    // The next delete finishes it from that step: rows, then the final snapshot.
    const finished = await deleteProject(f, "stuck");
    expect(finished.status).toBe(200);
    expect(existsSync(join(f.dataDir, deletedDatabase(finished.text)))).toBe(true);
    expect(existsSync(join(f.dataDir, "projects", "stuck"))).toBe(false);
    const after = (
      await readJson<{ data: Array<{ slug: string }> }>(
        await f.call("GET", "/api/instance/projects"),
      )
    ).data.map((project) => project.slug);
    expect(after).toEqual(["main"]);
    expect((await deleteProject(f, "stuck")).status).toBe(404);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});

/**
 * A final-snapshot step the server cannot finish until the operator repairs a permission (the
 * reviewer's probe: a folder made by another user). `block` runs on the project's directory before
 * the first delete, `repair` before the second.
 */
const snapshotSteps: Array<{
  step: string;
  block: (directory: string) => void;
  repair: (directory: string) => void;
}> = [
  {
    // A read-only project directory: the snapshot and tarball are written, nothing is removed.
    step: "removing a read-only directory",
    block: (directory) => chmodSync(directory, 0o555),
    repair: (directory) => chmodSync(directory, 0o755),
  },
  {
    // An upload the server cannot read: the tarball cannot be written.
    step: "writing the tarball",
    block: (directory) => chmodSync(join(directory, "uploads", "kept.txt"), 0o000),
    repair: (directory) => chmodSync(join(directory, "uploads", "kept.txt"), 0o644),
  },
  {
    // A folder the server cannot empty: the snapshot and tarball exist, the directory is half gone.
    step: "emptying an upload folder",
    block: (directory) => chmodSync(join(directory, "uploads", "locked"), 0o555),
    repair: (directory) => chmodSync(join(directory, "uploads", "locked"), 0o755),
  },
];

for (const { step, block, repair } of snapshotSteps) {
  test(`a delete stopped at ${step} is finished by the next delete from that step, one snapshot and one tarball`, async () => {
    const f = await openLifecycle(createRealClock());
    const host = "archive.example.test";
    const directory = join(f.dataDir, "projects", "archive");
    const deleted = join(f.dataDir, "backups", "deleted");
    const archived = () =>
      existsSync(deleted)
        ? readdirSync(deleted)
            .filter((name) => name.endsWith(".db") || name.endsWith(".tar"))
            .toSorted()
        : [];
    try {
      await createProject(f, { slug: "archive", name: "Archive", hostname: host });
      const session = await projectSession(f, host);
      const created = await projectCall(f, host, session, "POST", "/api/subscribers", {
        email: "kept@archive.example.test",
        name: "Kept",
      });
      expect(created.status).toBe(200);
      mkdirSync(join(directory, "uploads", "locked"), { recursive: true });
      writeFileSync(join(directory, "uploads", "kept.txt"), "kept upload");
      writeFileSync(join(directory, "uploads", "locked", "inner.txt"), "inner upload");
      block(directory);
      let failed: { status: number; text: string };
      try {
        failed = await deleteProject(f, "archive");
      } finally {
        repair(directory);
      }
      expect(failed.status).toBe(500);
      expect(failed.text).toContain("Deleting project archive stopped at its archive");
      expect(existsSync(directory)).toBe(true);
      const listed = (
        await readJson<{ data: Array<{ slug: string; delete_error: string | null }> }>(
          await f.call("GET", "/api/instance/projects"),
        )
      ).data.find((project) => project.slug === "archive");
      expect(listed?.delete_error).toContain("its archive");
      const before = archived();

      const finished = await deleteProject(f, "archive");
      expect(finished.status).toBe(200);
      const result = asBody<{ data: { database: string; files: string | null } }>(
        JSON.parse(finished.text),
      ).data;
      expect(existsSync(directory)).toBe(false);
      // The retry used the name the first attempt claimed: one snapshot, one tarball, no `-2`.
      expect(archived()).toEqual(
        [result.database, result.files!].map((path) => path.slice("backups/deleted/".length)),
      );
      expect(before.every((name) => archived().includes(name))).toBe(true);
      expect(snapshotEmails(f.dataDir, result.database)).toEqual(["kept@archive.example.test"]);
      const tar = await Bun.file(join(f.dataDir, result.files!)).text();
      expect(tar).toContain("kept upload");
      expect(tar).toContain("inner upload");
      expect(tar.split("uploads/kept.txt").length - 1).toBe(1);
      const after = (
        await readJson<{ data: Array<{ slug: string }> }>(
          await f.call("GET", "/api/instance/projects"),
        )
      ).data.map((project) => project.slug);
      expect(after).toEqual(["main"]);
    } finally {
      for (const path of [directory, join(directory, "uploads", "locked")]) {
        if (existsSync(path)) {
          chmodSync(path, 0o755);
        }
      }
      await f.close();
    }
    expect(f.failures).toEqual([]);
  });
}

test("a delete waits at most 5 s of the instance clock for a request in flight, then cuts it and says so", async () => {
  const clock = new TestClock();
  const f = await openLifecycle(clock);
  const host = "slow.example.test";
  try {
    await createProject(f, { slug: "slow", name: "Slow", hostname: host });
    const session = await projectSession(f, host);
    // An upload that never finishes: its body stops after its first bytes.
    const held = heldRequest(f.port, host, session, "/api/subscribers", {
      email: "held@slow.example.test",
      name: "Held",
    });
    await untilState(() => serving(f.port, host, session), {
      label: "slow serving",
      progress: () => "",
    });
    const startedAt = clock.now().getTime();
    let answered = false;
    const deleted = deleteProject(f, "slow").then((answer) => {
      answered = true;
      return answer;
    });
    await untilState(async () => !(await serving(f.port, host, session)), {
      label: "slow off the routing table",
      progress: () => "",
    });
    // Still draining just before the deadline.
    while (clock.now().getTime() - startedAt < 4900) {
      clock.advance(100);
      await Bun.sleep(2);
    }
    await Bun.sleep(50);
    expect(answered).toBe(false);
    // At the deadline the delete goes on without it.
    clock.advance(100);
    await untilState(() => answered, { label: "the delete at 5 s", progress: () => "" });
    const answer = await deleted;
    expect(answer.status).toBe(200);
    expect(clock.now().getTime() - startedAt).toBe(5000);
    expect(await f.logs()).toContain(
      "Deleting project slow: 1 request still running after 5 s was cut",
    );
    // The cut request writes nothing: its database closed under it, and the snapshot is without it.
    held.finish();
    const cut = await held.answered.catch(() => ({ status: 0, text: "" }));
    expect(cut.status).not.toBe(200);
    expect(snapshotEmails(f.dataDir, deletedDatabase(answer.text))).toEqual([]);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});

test("a streamed per_page=all response cut by a delete ends early; the delete and the instance are unharmed", async () => {
  const host = "big.example.test";
  // A project with many subscribers: the response is larger than the socket buffers, so the stream
  // is still being read from the database when the delete closes it.
  const seeded = await openLifecycle(createRealClock());
  const dataDir = seeded.dataDir;
  try {
    await createProject(seeded, { slug: "big", name: "Big", hostname: host });
  } finally {
    await seeded.close(true);
  }
  const db = new Database(join(dataDir, "projects", "big", "iglo-email.db"));
  try {
    db.run(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < 60000)
      INSERT INTO subscribers (uuid, email, name, status, attribs)
      SELECT 'big-' || i, 'subscriber' || i || '@big.example.test',
        'Subscriber number ' || i || ' with a name long enough to fill a socket', 'enabled',
        '{"city":"Somewhere far away","plan":"a plan with a long description"}' FROM n`);
  } finally {
    db.close();
  }
  const f = await openLifecycle(createRealClock(), { dataDir });
  try {
    const session = await projectSession(f, host);
    const response = await request(f.port, host, "/api/subscribers?per_page=all", {
      headers: sessionHeaders(session),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = decoder.decode((await reader.read()).value, { stream: true });
    // The handler has answered: the delete does not wait for the body (D157).
    const answer = await deleteProject(f, "big");
    expect(answer.status).toBe(200);
    let ended = "complete";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch {
      ended = "error";
    }
    // Cut: either an error on the connection or a body that is not the whole JSON document.
    let whole = false;
    try {
      const parsed = asBody<{ data: { results: Array<unknown> } }>(JSON.parse(text));
      whole = parsed.data.results.length === 60_000;
    } catch {
      whole = false;
    }
    expect({ ended, whole }).toMatchObject({ whole: false });
    // The snapshot has every row, and the instance keeps serving.
    const snapshot = new Database(join(f.dataDir, deletedDatabase(answer.text)), {
      readonly: true,
    });
    try {
      expect(
        snapshot.query<{ n: number }, []>("SELECT count(*) AS n FROM subscribers").get()?.n,
      ).toBe(60_000);
    } finally {
      snapshot.close();
    }
    expect((await request(f.port, "127.0.0.1", "/health")).status).toBe(200);
    expect((await f.call("GET", "/api/instance/projects")).status).toBe(200);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});

test("a create during shutdown: one already wiring is registered for the next start, a new one is refused", async () => {
  const first = await openLifecycle(createRealClock());
  const dataDir = first.dataDir;
  try {
    // The create is in progress (its directory exists) when the shutdown begins.
    const creating = first
      .call("POST", "/api/instance/projects", {
        slug: "late",
        name: "Late",
        hostname: "late.example.test",
      })
      .then(async (response) => ({ status: response.status, text: await response.text() }));
    await untilState(() => existsSync(join(dataDir, "projects", "late")), {
      label: "the create wiring",
      progress: () => "",
    });
    const stops = first.instance.stop();
    expect((await creating).status).toBe(200);
    // Once the shutdown began, a create is refused and makes nothing.
    const refused = await first.call("POST", "/api/instance/projects", {
      slug: "later",
      name: "Later",
      hostname: "later.example.test",
    });
    expect(refused.status).toBe(503);
    expect(existsSync(join(dataDir, "projects", "later"))).toBe(false);
    await Promise.allSettled(stops);
  } finally {
    await first.close(true);
  }
  expect(first.failures).toEqual([]);
  // The next start serves the project the shutdown let finish.
  const f = await openLifecycle(createRealClock(), { dataDir });
  try {
    const slugs = asBody<{ data: Array<{ slug: string }> }>(
      await (await f.call("GET", "/api/instance/projects")).json(),
    ).data.map((project) => project.slug);
    expect(slugs).toEqual(["late", "main"]);
    const session = await projectSession(f, "late.example.test");
    expect(await serving(f.port, "late.example.test", session)).toBe(true);
  } finally {
    await f.close();
  }
  expect(f.failures).toEqual([]);
});
