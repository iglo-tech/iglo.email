// B141a (14-projects section 7, "Restart loss" and "As built (B141)"): an orderly shutdown hands back
// a transactional push that never reached SMTP. One project, one SMTP connection: the first message
// is held in SMTP flight by the sink, and the second waits behind it for that connection. The
// instance's stop runs on the test clock past the 5 s close deadlines (the project sender's and the
// emailer's). The held message is unknown and never resent; the waiting one stays queued and is sent
// once after a reopen. Before B141a the sender's deadline, which fires first, made it unknown too. Through POST /api/tx, the send log and the SMTP sink.
import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openInstance } from "@/projects/instance";
import { serveRouted } from "@/server/server";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import { adminCredentials, logIn, request, sessionHeaders } from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";
import { TestClock } from "@/test/server/fixture";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

const HOST = "127.0.0.1";
const HELD = "held@example.test";
const REMAINDER = "remainder@example.test";

async function open(dataDir: string, admin: Credentials, clock: TestClock) {
  const instance = await openInstance(
    {
      dataDir,
      rootUrl: `http://${HOST}`,
      listen: { host: HOST, port: 0 },
      seed: { admin: { user: admin.user, password: admin.password } },
    },
    clock,
  );
  const server = serveRouted({ host: HOST, port: 0 }, (incoming, peer) =>
    instance.dispatch(incoming, peer),
  );
  const failures: Array<unknown> = [];
  instance.attach(server);
  instance.start((failure) => failures.push(failure));
  const port = server.port!;
  const session = await logIn(port, HOST, admin);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await request(port, HOST, path, {
      method,
      headers: sessionHeaders(session),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    expect({ path, status: response.status, text }).toMatchObject({ status: 200 });
    return asBody<{ data: Record<string, any> }>(JSON.parse(text)).data;
  };
  let stopped = false;
  return {
    instance,
    port,
    failures,
    call,
    /** The orderly stop, as main() runs it: every stop in one turn, the HTTP stop last. */
    stop(): Promise<unknown> {
      stopped = true;
      return Promise.allSettled([...instance.stop(), server.stop()]);
    },
    async close() {
      if (!stopped) {
        await Promise.allSettled(instance.stop());
      }
      await server.stop(true);
      await instance.close();
    },
  };
}

test("an orderly stop keeps a transactional send that waits for its SMTP connection queued, and sends it once after a reopen", async () => {
  const admin = await adminCredentials();
  const sink = await startSink({ hold: (to) => to.includes(HELD) });
  const clock = new TestClock();
  const dataDir = await mkdtemp(join(tmpdir(), "iglo-email-b141a-shutdown-"));
  let app: Awaited<ReturnType<typeof open>> | undefined;
  try {
    app = await open(dataDir, admin, clock);
    const first = app;
    // One connection, unpaced: the second message can only wait in the pool behind the first.
    const operator = (await instanceLogin(first.port, HOST, admin)).session!;
    const current = await instanceCall(first.port, HOST, operator, "GET", "/api/instance/settings");
    const { data } = asBody<{ data: Record<string, any> }>(await current.json());
    const saved = await instanceCall(first.port, HOST, operator, "PUT", "/api/instance/settings", {
      ...data,
      "messaging.max_send_rate": 0,
      smtp: [
        {
          ...asBody<Record<string, unknown>>(data.smtp[0]),
          enabled: true,
          host: "127.0.0.1",
          port: sink.port,
          max_conns: 1,
          auth_protocol: "none",
          username: "",
          password: "",
          tls_type: "none",
          email_headers: [],
        },
      ],
    });
    expect(saved.status).toBe(200);
    for (const email of [HELD, REMAINDER]) {
      await first.call("POST", "/api/subscribers", { email, name: email, status: "enabled" });
    }
    const templates = asBody<Array<{ id: number; type: string }>>(
      await first.call("GET", "/api/templates"),
    );
    const template = templates.find((item) => item.type === "tx")!.id;
    const status = async (id: number) =>
      asBody<string>((await first.call("GET", `/api/sends/${id}`)).status);

    // One batch: the outbox claims both rows together and pushes them in order. The rows answer in
    // the order of the recipients.
    const ids = asBody<Array<{ id: number }>>(
      (
        await first.call("POST", "/api/tx", {
          subscriber_emails: [HELD, REMAINDER],
          template_id: template,
          async: true,
        })
      ).sends,
    ).map((send) => send.id);
    const held = ids[0]!;
    const remainder = ids[1]!;
    // The first is in SMTP flight, and the second, claimed and pushed, waits for the connection.
    await untilState(
      async () => {
        clock.advance(100);
        return sink.heldOpen() === 1 && (await status(remainder)) === "sending";
      },
      {
        label: "the first send in SMTP flight, the second waiting",
        progress: async () => `${sink.heldOpen()} ${await status(remainder)}`,
      },
    );
    expect(sink.messages).toEqual([]);

    let settled = false;
    void first.stop().then(() => {
      settled = true;
    });
    await untilState(
      () => {
        clock.advance(250);
        return settled;
      },
      { label: "the orderly stop", progress: () => clock.now().toISOString() },
    );
    app = undefined;
    await first.close();
    expect(first.failures).toEqual([]);
    // The emailer's close cut the held connection at its deadline.
    expect(sink.heldOpen()).toBe(0);

    // Reopened: the waiting send was handed back and goes out once; the cut one stays unknown.
    app = await open(dataDir, admin, clock);
    const second = app;
    const reopened = async (id: number) =>
      asBody<string>((await second.call("GET", `/api/sends/${id}`)).status);
    await untilState(
      async () => {
        clock.advance(1000);
        return (await reopened(remainder)) === "sent";
      },
      { label: "the queued remainder sent after the reopen", progress: () => reopened(remainder) },
    );
    expect(await reopened(held)).toBe("unknown");
    for (let i = 0; i < 10; i++) {
      clock.advance(1000);
      await Bun.sleep(5);
    }
    const to = (email: string) => sink.messages.filter((m) => m.to.includes(email)).length;
    expect(to(REMAINDER)).toBe(1);
    // A resend of the cut message would be held again, on a new open connection.
    expect(to(HELD)).toBe(0);
    expect(sink.heldOpen()).toBe(0);
    expect(second.failures).toEqual([]);
  } finally {
    await app?.close();
    await sink.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
