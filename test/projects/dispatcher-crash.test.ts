// B141 (14-projects sections 7, 14 invariant 3, and 15, D155): at-most-once survives the dispatcher.
// The compiled executable with 20 projects, each with 30 due marketing rows, sends at rate 1/s. The
// process is stopped mid-wait, by SIGKILL or SIGTERM, and started again. Marketing rows are claimed
// only against granted slots within the 2 s horizon, so a crash leaves `unknown` at most those two
// slots plus the message in SMTP flight, and an orderly stop leaves none that never started. After
// the restart the rate is lifted, and every other row is sent, once.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  adminCredentials,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { instanceClient } from "@/test/settings/instance-client";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(240_000);
/** Each run sets up 600 rows in 20 projects, stops and restarts the process: well over 30 s. */
const RUN_MS = 240_000;

const PROJECTS = 20;
const ROWS = 30;
const RATE = 1;
/** Granted, claimed and not started at most: the horizon's slots at RATE. */
const HORIZON_SLOTS = 2 * RATE;
const hosts = Array.from({ length: PROJECTS }, (_, i) =>
  i === 0 ? "127.0.0.1" : `p${String(i).padStart(2, "0")}.example.test`,
);

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let admin: Credentials;
let sink: Awaited<ReturnType<typeof startSink>>;

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  sink = await startSink();
});
afterAll(async () => {
  await sink?.close();
  await prepared?.cleanup();
});

async function json<T>(response: Response, what: string): Promise<T> {
  if (response.status !== 200) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
  return (await readJson<{ data: T }>(response)).data;
}

/** A project call under an admin session on its host. */
function call(port: number, host: string, session: Session, path: string, body?: unknown) {
  return request(port, host, path, {
    method: body === undefined ? "GET" : "POST",
    headers: sessionHeaders(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** In each project, a list of ROWS confirmed readers and one async marketing call to them all. */
async function queueMarketing(port: number, tag: string) {
  await Promise.all(
    hosts.map(async (host, p) => {
      const session = await logIn(port, host, admin);
      const list = await json<{ id: number }>(
        await call(port, host, session, "/api/lists", {
          name: `crash ${tag}`,
          type: "public",
          optin: "single",
        }),
        `list on ${host}`,
      );
      const emails = Array.from({ length: ROWS }, (_, i) => `${tag}-${p}-${i}@example.test`);
      for (let start = 0; start < ROWS; start += 10) {
        await Promise.all(
          emails.slice(start, start + 10).map(async (email) =>
            json(
              await call(port, host, session, "/api/subscribers", {
                email,
                name: "Reader",
                lists: [list.id],
                preconfirm_subscriptions: true,
              }),
              `subscriber on ${host}`,
            ),
          ),
        );
      }
      const templates = await json<Array<{ id: number; type: string }>>(
        await call(port, host, session, "/api/templates"),
        `templates on ${host}`,
      );
      const template = templates.find((item) => item.type === "tx");
      await json(
        await call(port, host, session, "/api/tx", {
          subscriber_emails: emails,
          template_id: template?.id,
          kind: "marketing",
          list_id: list.id,
          async: true,
        }),
        `tx on ${host}`,
      );
    }),
  );
}

/** Every marketing row of every project: its recipient and status. */
async function rows(port: number) {
  const all: Array<{ to_email: string; status: string }> = [];
  for (const host of hosts) {
    const session = await logIn(port, host, admin);
    const page = await json<{ results: Array<{ to_email: string; status: string }> }>(
      await call(port, host, session, "/api/sends?per_page=100"),
      `sends on ${host}`,
    );
    all.push(...page.results);
  }
  return all;
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms: number) {
  const end = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await Bun.sleep(50);
  }
}

async function stopMidWait(signal: "SIGKILL" | "SIGTERM", tag: string) {
  const dataDir = join(prepared.directory, `data-${tag}`);
  registerProjects(
    dataDir,
    hosts.map((hostname, i) => ({
      slug: i === 0 ? "main" : `p${String(i).padStart(2, "0")}`,
      name: hostname,
      hostname,
      primary: i === 0,
    })),
  );
  const first = await startInstance(prepared.executable, dataDir, admin);
  const instance = await instanceClient(`http://127.0.0.1:${first.port}`, admin);
  await instance.useSink(sink.port, { max_conns: 2 });
  await instance.put("messaging.max_send_rate", RATE);
  const before = sink.messages.length;
  await queueMarketing(first.port, tag);
  // Stopped mid-wait: a few messages are out, and most of the 600 rows still wait for a slot.
  await until(() => sink.messages.length >= before + 3, "the first sends", 30_000);
  if (signal === "SIGKILL") {
    first.child.kill("SIGKILL");
    await first.child.exited;
  } else {
    await first.stop();
  }
  const receivedBefore = new Set(sink.messages.slice(before).map((m) => m.to[0]));

  // Started again: recovery settles every row that was claimed when the process stopped.
  const second = await startInstance(prepared.executable, dataDir, admin);
  try {
    const recovered = await rows(second.port);
    const unknown = recovered.filter((row) => row.status === "unknown");
    // Unknown and never received: claimed, and not started, when the process stopped.
    const neverStarted = unknown.filter((row) => !receivedBefore.has(row.to_email));
    const lifted = await instanceClient(`http://127.0.0.1:${second.port}`, admin);
    await lifted.put("messaging.max_send_rate", 0);
    const expected = PROJECTS * ROWS - unknown.length;
    await until(
      async () =>
        (await rows(second.port)).filter((row) => row.status === "sent").length >= expected,
      "every other row to be sent",
      120_000,
    );
    const final = await rows(second.port);
    const sent = final.filter((row) => row.status === "sent").map((row) => row.to_email);
    const received = sink.messages.slice(before).map((m) => m.to[0]);
    return { unknown, neverStarted, sent, final, received };
  } finally {
    await second.stop();
  }
}

test(
  "SIGKILL mid-wait leaves unknown at most the horizon's slots plus SMTP flight; the rest is sent once",
  async () => {
    const result = await stopMidWait("SIGKILL", "kill");
    expect(result.neverStarted.length).toBeLessThanOrEqual(HORIZON_SLOTS);
    // The in-flight count: at most the pool's two connections of this run.
    expect(result.unknown.length).toBeLessThanOrEqual(HORIZON_SLOTS + 2);
    expect(result.final.length).toBe(PROJECTS * ROWS);
    expect(result.sent.length + result.unknown.length).toBe(PROJECTS * ROWS);
    for (const email of result.sent) {
      expect({ email, times: result.received.filter((to) => to === email).length }).toEqual({
        email,
        times: 1,
      });
    }
  },
  RUN_MS,
);

test(
  "SIGTERM mid-wait leaves no unknown row that never started; the rest is sent once",
  async () => {
    const result = await stopMidWait("SIGTERM", "term");
    expect(result.neverStarted).toEqual([]);
    expect(result.sent.length + result.unknown.length).toBe(PROJECTS * ROWS);
    for (const email of result.sent) {
      expect({ email, times: result.received.filter((to) => to === email).length }).toEqual({
        email,
        times: 1,
      });
    }
    expect(asBody<number>(result.final.length)).toBe(PROJECTS * ROWS);
  },
  RUN_MS,
);
