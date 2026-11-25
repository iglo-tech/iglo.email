// B143a (14-projects section 10, D157): a delete waits for the project's in-flight requests before
// it closes the project's database. A request whose body is still arriving when the delete starts
// is answered from the open database, and its write is in the final snapshot. In process, through
// the instance's own server, since the request's body has to be held open at a chosen moment. A
// create of the same slug issued meanwhile waits for the delete to finish.
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { adminCredentials, logIn, request, sessionHeaders } from "@/test/projects/fixture";
import { untilState } from "@/test/wait";

setDefaultTimeout(30_000);

test("a delete drains a request in flight, then closes the database and keeps its write", async () => {
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-drain-"));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: "http://127.0.0.1",
      listen: { host: "127.0.0.1", port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    createRealClock(),
  );
  const server = serveRouted({ host: "127.0.0.1", port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  const failures: Array<unknown> = [];
  try {
    instance.attach(server);
    instance.start((failure) => failures.push(failure));
    const port = server.port!;
    const host = "slow.example.test";
    await instance.add({ slug: "slow", name: "Slow", hostname: host });
    const session = await logIn(port, host, admin);

    // A subscriber create whose body arrives in two parts; the second waits for the delete.
    const body = JSON.stringify({ email: "inflight@slow.example.test", name: "In flight" });
    const encoder = new TextEncoder();
    let finish: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, 10)));
        finish = () => {
          controller.enqueue(encoder.encode(body.slice(10)));
          controller.close();
        };
      },
    });
    const events: Array<string> = [];
    const inflight = request(port, host, "/api/subscribers", {
      method: "POST",
      headers: { ...sessionHeaders(session), "content-length": String(body.length) },
      body: stream,
    }).then(async (response) => {
      events.push(`response ${response.status}`);
      return response.text();
    });
    // The request is in the project's router: its session still works on the host.
    await untilState(
      async () =>
        (await request(port, host, "/api/profile", { headers: sessionHeaders(session) })).status ===
        200,
      { label: "the project serving", progress: () => events.join() },
    );

    const removal = instance.remove("slow").then((deleted) => {
      events.push("removed");
      return deleted;
    });
    // The project leaves the routing table at once: its host reaches the primary, which knows
    // nothing of the session, while the held request is still waiting for its body.
    await untilState(
      async () =>
        (await request(port, host, "/api/profile", { headers: sessionHeaders(session) })).status !==
        200,
      { label: "the project off the routing table", progress: () => events.join() },
    );
    // A create of the same slug waits for the delete (D157): changes run one at a time, so it
    // neither finds the old directory nor has it removed under it.
    const recreated = instance
      .add({ slug: "slow", name: "Slow again", hostname: host })
      .then((record) => {
        events.push("added");
        return record;
      });
    expect(events).toEqual([]);
    finish!();
    const answer = await inflight;
    const deleted = await removal;
    await recreated;
    expect(events).toEqual(["response 200", "removed", "added"]);
    expect(answer).toContain("inflight@slow.example.test");
    expect(deleted).not.toBeNull();
    const snapshot = new Database(join(dataDir, deleted!.database), { readonly: true });
    try {
      const row = snapshot
        .query<{ name: string }, [string]>("SELECT name FROM subscribers WHERE email = ?")
        .get("inflight@slow.example.test");
      expect(row?.name).toBe("In flight");
    } finally {
      snapshot.close();
    }
    // The new project is a fresh one on the same host: the deleted project's rows are not in it.
    const fresh = await logIn(port, host, admin);
    const list = await request(port, host, "/api/subscribers?per_page=all", {
      headers: sessionHeaders(fresh),
    });
    expect(list.status).toBe(200);
    expect(await list.text()).not.toContain("inflight@slow.example.test");
  } finally {
    await Promise.allSettled(instance.stop());
    await server.stop(true);
    await instance.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  expect(failures).toEqual([]);
});
