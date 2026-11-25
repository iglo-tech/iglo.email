// B143a fix round 1 (14-projects section 10, D155, D157): a project delete stops that project's
// sending first, and bounds its sends in SMTP flight by the sender's 5 s close deadline. Both
// through the instance's own server and the DELETE API, with the SMTP sink as the outside view and
// the final snapshot as the record. In process on a test clock, so the send rate and the deadline
// move only when the test advances it; another project keeps sending through the same pools.
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import { adminCredentials, logIn, request, sessionHeaders } from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { heldRequest as heldPost } from "@/test/projects/lifecycle-fixture";
import { asBody } from "@/test/read-body";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";
const GONE = "gone.example.test";
const STAY = "stay.example.test";

/**
 * An instance with projects `gone` and `stay`, its SMTP pointed at `sink` with `maxConns`
 * connections, sending at `rate`.
 */
async function openFixture(
  sink: Awaited<ReturnType<typeof startSink>>,
  rate: number,
  clock: TestClock,
  maxConns = 4,
) {
  const admin = await adminCredentials();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b143a-delete-sending-"));
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${PRIMARY}`,
      listen: { host: PRIMARY, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    clock,
  );
  const server = serveRouted({ host: PRIMARY, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  const failures: Array<unknown> = [];
  instance.attach(server);
  instance.start((failure) => failures.push(failure));
  const port = server.port!;
  await instance.add({ slug: "gone", name: "Gone", hostname: GONE });
  await instance.add({ slug: "stay", name: "Stay", hostname: STAY });
  const operator = (await instanceLogin(port, PRIMARY, admin)).session!;
  const current = await instanceCall(port, PRIMARY, operator, "GET", "/api/instance/settings");
  const { data } = asBody<{ data: Record<string, any> }>(await current.json());
  const saved = await instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/settings", {
    ...data,
    "messaging.max_send_rate": rate,
    smtp: [
      {
        ...asBody<Record<string, unknown>>(data.smtp[0]),
        enabled: true,
        host: "127.0.0.1",
        port: sink.port,
        max_conns: maxConns,
        auth_protocol: "none",
        username: "",
        password: "",
        tls_type: "none",
        email_headers: [],
      },
    ],
  });
  expect(saved.status).toBe(200);
  return {
    admin,
    dataDir,
    port,
    operator,
    failures,
    async close() {
      await Promise.allSettled(instance.stop());
      await server.stop(true);
      await instance.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** A running campaign in the project on `host` to `count` subscribers `<prefix><n>@<host>`. */
async function runCampaign(
  port: number,
  host: string,
  admin: Credentials,
  prefix: string,
  count: number,
) {
  const session = await logIn(port, host, admin);
  const call = async (method: string, path: string, body: unknown) => {
    const response = await request(port, host, path, {
      method,
      headers: sessionHeaders(session),
      body: JSON.stringify(body),
    });
    const text = await response.text();
    expect({ path, status: response.status, text }).toMatchObject({ status: 200 });
    return asBody<{ data: Record<string, any> }>(JSON.parse(text)).data;
  };
  const list = await call("POST", "/api/lists", {
    name: `${prefix}-list`,
    type: "private",
    optin: "single",
  });
  for (let n = 0; n < count; n++) {
    await call("POST", "/api/subscribers", {
      email: `${prefix}${n}@${host}`,
      name: `${prefix}${n}`,
      status: "enabled",
      lists: [list.id],
      preconfirm_subscriptions: true,
    });
  }
  const campaign = await call("POST", "/api/campaigns", {
    name: `${prefix}-campaign`,
    subject: "Hello",
    lists: [list.id],
    content_type: "html",
    body: "<p>Hi</p>",
  });
  await call("PUT", `/api/campaigns/${campaign.id}/status`, { status: "running" });
  return { session, campaignId: asBody<number>(campaign.id) };
}

/** Starts the DELETE of `gone`; resolves with its status and body. */
function deleteGone(port: number, operator: InstanceSession) {
  const answer = instanceCall(port, PRIMARY, operator, "DELETE", "/api/instance/projects/gone", {
    confirm: "gone",
  }).then(async (response) => ({ status: response.status, text: await response.text() }));
  // Observed at once: a test that fails first stops the server under it.
  answer.catch(() => {});
  return answer;
}

/** A request to `gone` whose body is held open, so the delete's drain waits for it. */
function heldRequest(port: number, session: Session) {
  const body = JSON.stringify({ email: "held@gone.example.test", name: "Held" });
  const encoder = new TextEncoder();
  let finish!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body.slice(0, 10)));
      let done = false;
      finish = () => {
        if (done) {
          return;
        }
        done = true;
        controller.enqueue(encoder.encode(body.slice(10)));
        controller.close();
      };
    },
  });
  const answered = request(port, GONE, "/api/subscribers", {
    method: "POST",
    headers: { ...sessionHeaders(session), "content-length": String(body.length) },
    body: stream,
  }).then((response) => response.text());
  // Observed at once: a test that fails first stops the server under it.
  answered.catch(() => {});
  return { answered, finish: () => finish() };
}

const recipientsOf = (messages: ReadonlyArray<{ to: Array<string> }>, host: string) =>
  messages.filter((message) => message.to.some((to) => to.endsWith(`@${host}`))).length;

test("a delete stops the project's slot requests first: while its requests drain, every start goes to the other project", async () => {
  const sink = await startSink();
  const clock = new TestClock();
  // One start a second on the test clock: nothing starts unless the test advances it.
  const fixture = await openFixture(sink, 1, clock);
  const { port, admin, operator } = fixture;
  let held: ReturnType<typeof heldRequest> | undefined;
  try {
    const gone = await runCampaign(port, GONE, admin, "g", 20);
    await runCampaign(port, STAY, admin, "s", 20);
    // Both campaigns send, taking turns at the start (D155).
    const advance = () => {
      clock.advance(100);
    };
    await untilState(
      () => {
        advance();
        return recipientsOf(sink.messages, GONE) >= 2 && recipientsOf(sink.messages, STAY) >= 2;
      },
      { label: "both campaigns sending", progress: () => String(sink.messages.length) },
    );
    const goneBefore = recipientsOf(sink.messages, GONE);
    const total = sink.messages.length;

    // A request to gone holds the drain open; the delete starts and takes gone off the routing table.
    held = heldRequest(port, gone.session);
    await untilState(
      async () =>
        (await request(port, GONE, "/api/profile", { headers: sessionHeaders(gone.session) }))
          .status === 200,
      { label: "gone serving", progress: () => "" },
    );
    const deleted = deleteGone(port, operator);
    await untilState(
      async () =>
        (await request(port, GONE, "/api/profile", { headers: sessionHeaders(gone.session) }))
          .status !== 200,
      { label: "gone off the routing table", progress: () => "" },
    );

    // Four more starts while gone's request is still draining (about 4 s of the clock, inside the
    // drain's 5 s bound): all of them are stay's.
    await untilState(
      () => {
        advance();
        return sink.messages.length >= total + 4;
      },
      { label: "four starts during the drain", progress: () => String(sink.messages.length) },
    );
    expect(recipientsOf(sink.messages, GONE)).toBe(goneBefore);

    held.finish();
    await held.answered;
    const answer = await deleted;
    expect(answer.status).toBe(200);
    const { database } = asBody<{ data: { database: string } }>(JSON.parse(answer.text)).data;
    // Its claims were handed back: sent rows are exactly what reached the sink, none is still
    // claimed, and the rest of its audience is unsent.
    const snapshot = new Database(join(fixture.dataDir, database), { readonly: true });
    try {
      const rows = snapshot
        .query<{ status: string; n: number }, [number]>(
          "SELECT status, count(*) AS n FROM campaign_deliveries WHERE campaign_id = ? GROUP BY status",
        )
        .all(gone.campaignId);
      expect(Object.fromEntries(rows.map((row) => [row.status, row.n]))).toEqual({
        sent: goneBefore,
      });
    } finally {
      snapshot.close();
    }
    // Stay goes on sending after the delete.
    const after = sink.messages.length;
    await untilState(
      () => {
        advance();
        return (
          recipientsOf(sink.messages, STAY) > recipientsOf(sink.messages.slice(0, after), STAY)
        );
      },
      { label: "stay sending after the delete", progress: () => String(sink.messages.length) },
    );
    expect(recipientsOf(sink.messages, GONE)).toBe(goneBefore);
  } finally {
    held?.finish();
    await fixture.close();
    await sink.close();
  }
  expect(fixture.failures).toEqual([]);
});

test("a delete waits at most 5 s for the project's send in SMTP flight, cuts no shared connection and never resends it", async () => {
  const stuck = "stuck0@gone.example.test";
  const sink = await startSink({ hold: (to) => to.includes(stuck) });
  const clock = new TestClock();
  const fixture = await openFixture(sink, 0, clock);
  const { port, admin, operator } = fixture;
  try {
    const gone = await runCampaign(port, GONE, admin, "stuck", 1);
    // The runner pushes gone's one message; the sink holds its reply with the connection open.
    await untilState(
      () => {
        clock.advance(100);
        return sink.heldOpen() === 1;
      },
      { label: "gone's send in SMTP flight", progress: () => String(sink.heldOpen()) },
    );
    const startedAt = clock.now().getTime();
    let answered = false;
    const deleted = deleteGone(port, operator).then((answer) => {
      answered = true;
      return answer;
    });
    // The clock stays put until the delete has begun (gone is off the routing table), so the
    // deadline is measured from the delete's own start.
    await untilState(
      async () =>
        (await request(port, GONE, "/api/profile", { headers: sessionHeaders(gone.session) }))
          .status !== 200,
      { label: "gone off the routing table", progress: () => "" },
    );
    // The delete answers when the test clock reaches the 5 s deadline, long before the push's own
    // 60 s deadline (also on this clock) or the socket's 30 s timeout (real time): still waiting
    // at 4.9 s, answered at 5 s (B149a: a deadline drifting to 8 s fails here).
    while (clock.now().getTime() - startedAt < 4900) {
      clock.advance(100);
      await Bun.sleep(2);
    }
    await Bun.sleep(50);
    expect(answered).toBe(false);
    clock.advance(100);
    await untilState(() => answered, {
      label: "the delete at the close deadline",
      progress: () => clock.now().toISOString(),
    });
    const answer = await deleted;
    expect(answer.status).toBe(200);
    expect(clock.now().getTime() - startedAt).toBe(5000);
    // The shared connection carrying it was not cut, and the other project sends meanwhile.
    expect(sink.heldOpen()).toBe(1);
    await runCampaign(port, STAY, admin, "after", 1);
    await untilState(
      () => {
        clock.advance(100);
        return recipientsOf(sink.messages, STAY) === 1;
      },
      { label: "stay sending while gone's push is held", progress: () => "" },
    );
    // The snapshot records the cut send as unknown, the outcome a cut push gets: never retried.
    const { database } = asBody<{ data: { database: string } }>(JSON.parse(answer.text)).data;
    const snapshot = new Database(join(fixture.dataDir, database), { readonly: true });
    try {
      const rows = snapshot
        .query<{ status: string }, [number]>(
          "SELECT status FROM campaign_deliveries WHERE campaign_id = ?",
        )
        .all(gone.campaignId);
      expect(rows.map((row) => row.status)).toEqual(["unknown"]);
    } finally {
      snapshot.close();
    }
    // The server answers it at last: it arrives once, and nothing fails or sends it again.
    sink.release();
    await untilState(
      () => {
        clock.advance(1000);
        return sink.messages.some((message) => message.to.includes(stuck));
      },
      { label: "the held send accepted", progress: () => String(sink.messages.length) },
    );
    for (let i = 0; i < 20; i++) {
      clock.advance(1000);
      await Bun.sleep(5);
    }
    expect(sink.messages.filter((message) => message.to.includes(stuck))).toHaveLength(1);
  } finally {
    await fixture.close();
    await sink.close();
  }
  expect(fixture.failures).toEqual([]);
});

/** A project-session JSON call on `host` that must answer 200; its `data`. */
async function projectData<T>(
  port: number,
  host: string,
  session: Session,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await request(port, host, path, {
    method,
    headers: sessionHeaders(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect({ path, status: response.status, text }).toMatchObject({ status: 200 });
  return asBody<{ data: T }>(JSON.parse(text)).data;
}

/** The project's send log statuses in a final snapshot, by kind. */
function snapshotSends(dataDir: string, database: string) {
  const snapshot = new Database(join(dataDir, database), { readonly: true });
  try {
    return snapshot
      .query<{ kind: string; status: string; to_email: string }, []>(
        "SELECT kind, status, to_email FROM sends ORDER BY id",
      )
      .all();
  } finally {
    snapshot.close();
  }
}

test("a marketing POST /api/tx still in flight when its project is deleted answers with its rows queued, and nothing is sent", async () => {
  const sink = await startSink();
  const clock = new TestClock();
  const fixture = await openFixture(sink, 0, clock);
  const { port, admin, operator } = fixture;
  let held: ReturnType<typeof heldPost> | undefined;
  try {
    const session = await logIn(port, GONE, admin);
    const list = await projectData<{ id: number }>(port, GONE, session, "POST", "/api/lists", {
      name: "news",
      type: "public",
      optin: "single",
    });
    const reader = "reader@gone.example.test";
    await projectData(port, GONE, session, "POST", "/api/subscribers", {
      email: reader,
      name: "Reader",
      status: "enabled",
      lists: [list.id],
      preconfirm_subscriptions: true,
    });
    const templates = await projectData<Array<{ id: number; type: string }>>(
      port,
      GONE,
      session,
      "GET",
      "/api/templates",
    );
    const template = templates.find((item) => item.type === "tx")!.id;
    // The request's body is still arriving when the delete starts: it is in the project's router.
    held = heldPost(port, GONE, session, "/api/tx", {
      subscriber_email: reader,
      template_id: template,
      kind: "marketing",
      list_id: list.id,
    });
    await untilState(
      async () =>
        (await request(port, GONE, "/api/profile", { headers: sessionHeaders(session) })).status ===
        200,
      { label: "gone serving", progress: () => "" },
    );
    const deleted = deleteGone(port, operator);
    await untilState(
      async () =>
        (await request(port, GONE, "/api/profile", { headers: sessionHeaders(session) })).status !==
        200,
      { label: "gone off the routing table", progress: () => "" },
    );
    // Its sending is already stopped: the send is journalled and handed back, not started.
    held.finish();
    const sent = await held.answered;
    expect(sent.status).toBe(200);
    const rows = asBody<{ data: { sends: Array<{ status: string }> } }>(JSON.parse(sent.text)).data
      .sends;
    expect(rows.map((row) => row.status)).toEqual(["queued"]);
    const answer = await deleted;
    expect(answer.status).toBe(200);
    const { database } = asBody<{ data: { database: string } }>(JSON.parse(answer.text)).data;
    expect(snapshotSends(fixture.dataDir, database)).toEqual([
      { kind: "marketing", status: "queued", to_email: reader },
    ]);
    for (let i = 0; i < 20; i++) {
      clock.advance(1000);
      await Bun.sleep(5);
    }
    expect(sink.messages).toHaveLength(0);
  } finally {
    held?.finish();
    await fixture.close();
    await sink.close();
  }
  expect(fixture.failures).toEqual([]);
});

test("a deleted project's send queued behind a shared connection never starts once the connection frees", async () => {
  // One pooled connection for every project; stay's campaign message holds it in SMTP flight.
  const stuck = "stuck0@stay.example.test";
  const sink = await startSink({ hold: (to) => to.includes(stuck) });
  const clock = new TestClock();
  const fixture = await openFixture(sink, 0, clock, 1);
  const { port, admin, operator } = fixture;
  try {
    await runCampaign(port, STAY, admin, "stuck", 1);
    await untilState(
      () => {
        clock.advance(100);
        return sink.heldOpen() === 1;
      },
      { label: "stay's send in SMTP flight", progress: () => String(sink.heldOpen()) },
    );
    // Gone's transactional send starts and waits in the pool for the one connection.
    const session = await logIn(port, GONE, admin);
    const waiting = "waiting@gone.example.test";
    await projectData(port, GONE, session, "POST", "/api/subscribers", {
      email: waiting,
      name: "Waiting",
      status: "enabled",
    });
    const templates = await projectData<Array<{ id: number; type: string }>>(
      port,
      GONE,
      session,
      "GET",
      "/api/templates",
    );
    const template = templates.find((item) => item.type === "tx")!.id;
    await projectData(port, GONE, session, "POST", "/api/tx", {
      subscriber_email: waiting,
      template_id: template,
      async: true,
    });
    await untilState(
      async () => {
        clock.advance(100);
        const page = await projectData<{ results: Array<{ status: string }> }>(
          port,
          GONE,
          session,
          "GET",
          "/api/sends?per_page=10",
        );
        return page.results.some((row) => row.status === "sending");
      },
      { label: "gone's send waiting for the connection", progress: () => "" },
    );
    // The delete ends it not-started at the close deadline: its row is handed back.
    let answered = false;
    const deleted = deleteGone(port, operator).then((answer) => {
      answered = true;
      return answer;
    });
    await untilState(
      () => {
        clock.advance(250);
        return answered;
      },
      { label: "the delete", progress: () => clock.now().toISOString() },
    );
    const answer = await deleted;
    expect(answer.status).toBe(200);
    const { database } = asBody<{ data: { database: string } }>(JSON.parse(answer.text)).data;
    expect(snapshotSends(fixture.dataDir, database)).toEqual([
      { kind: "transactional", status: "queued", to_email: waiting },
    ]);
    // The connection frees: stay's message is accepted, and gone's released push never starts on it.
    sink.release();
    await untilState(
      () => {
        clock.advance(1000);
        return sink.messages.some((message) => message.to.includes(stuck));
      },
      { label: "stay's send accepted", progress: () => String(sink.messages.length) },
    );
    for (let i = 0; i < 20; i++) {
      clock.advance(1000);
      await Bun.sleep(5);
    }
    expect(sink.messages.filter((message) => message.to.includes(waiting))).toHaveLength(0);
  } finally {
    await fixture.close();
    await sink.close();
  }
  expect(fixture.failures).toEqual([]);
});
