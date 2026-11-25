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
import type { Credentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";
const GONE = "gone.example.test";
const STAY = "stay.example.test";

/** An instance with projects `gone` and `stay`, its SMTP pointed at `sink`, sending at `rate`. */
async function openFixture(
  sink: Awaited<ReturnType<typeof startSink>>,
  rate: number,
  clock: TestClock,
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
        max_conns: 4,
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

const recipientsOf = (messages: ReadonlyArray<{ to: Array<string> }>, host: string) =>
  messages.filter((message) => message.to.some((to) => to.endsWith(`@${host}`))).length;

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
    // The delete answers once the test clock passes the 5 s deadline, long before the push's own
    // 60 s deadline (also on this clock) or the socket's 30 s timeout (real time).
    await untilState(
      () => {
        clock.advance(250);
        return answered;
      },
      { label: "the delete within the close deadline", progress: () => clock.now().toISOString() },
    );
    const answer = await deleted;
    expect(answer.status).toBe(200);
    expect(clock.now().getTime() - startedAt).toBeLessThan(10_000);
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
