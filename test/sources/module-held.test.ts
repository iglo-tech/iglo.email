// B162a r1 (15-external-sources sections 6 and 7, D188): while the instance's sources module is
// off, a project that still stores a source treats its source-linked subscribers as unreadable,
// never as unlinked. The source may have opted them out of marketing or deleted them, and only a
// send-time read can tell (section 7), so they get nothing: a campaign skips them
// `subscriber_unavailable` with one attention line, and a sequence step to them waits with nothing
// sent or ended until the module is on again, when it runs with its send-time read. Unlinked
// subscribers are sent as before. Through an instance in this process on a test clock, the real
// PocketBase binary and the SMTP sink.
//
// And the scheduler's claim hold (D188, `claim-due ?4`) on its own, without the decide-time release
// guard: more held external enrollments than one claim batch, all due before a pushed enrollment,
// do not keep the pushed one from running within the pass.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { createRealClock } from "@/clock";
import { createPocketBaseSource } from "@/sources/pocketbase";
import type { ExternalSource } from "@/sources/source";
import { TestClock } from "@/test/server/fixture";
import { api, createApiUser, logIn } from "@/test/projects/fixture";
import { openLifecycle, PRIMARY } from "@/test/projects/lifecycle-fixture";
import type { LifecycleFixture } from "@/test/projects/lifecycle-fixture";
import { asBody, readJson } from "@/test/read-body";
import { day, schedulerFixture } from "@/test/scheduler/fixture";
import { sourceConfig, startPocketBase } from "@/test/sources/pocketbase";
import type { PocketBase, PocketBaseRecord } from "@/test/sources/pocketbase";
import { openGuard } from "@/test/sources/stream-fixture";
import { startCutProxy } from "@/test/sources/stream-proxy";
import { startSink } from "@/test/tx/sink";

setDefaultTimeout(120_000);

let pb: PocketBase;
let sink: Awaited<ReturnType<typeof startSink>>;
beforeAll(async () => {
  pb = await startPocketBase();
  sink = await startSink();
});
afterAll(async () => {
  await sink?.close();
  await pb?.close();
});

interface Answer {
  status: number;
  body: any;
}
const emailOf = (user: PocketBaseRecord) => asBody<string>(user.email);
const mailTo = (address: string) => sink.messages.filter((m) => m.to.includes(address)).length;

/** Polls (real time) until `check` holds, running `step` (a clock advance) between tries. */
async function eventually(
  check: () => Promise<boolean> | boolean,
  what: string,
  step: () => void = () => {},
  ms = 30_000,
) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    step();
    await Bun.sleep(20);
  }
}

interface Held {
  f: LifecycleFixture;
  clock: TestClock;
  call: (method: string, path: string, body?: unknown) => Promise<Answer>;
  setInstance: (changes: Record<string, unknown>) => Promise<void>;
  list: number;
  /** Linked, opted out of marketing in the source. */
  opal: { user: PocketBaseRecord; id: number };
  /** Linked, not opted out. */
  kit: { user: PocketBaseRecord; id: number };
  /** Not linked: no `external_id`. */
  una: { email: string; id: number };
  /** Adds a confirmed member of News (source-linked with `externalId`). */
  member: (email: string, name: string, externalId?: string) => Promise<number>;
}

/**
 * An instance whose project stores a PocketBase source (saved while the module was on), with three
 * confirmed members of list News: two source-linked users (Opal opted out of marketing in the
 * source, Kit not) and one unlinked subscriber (Una). SMTP goes to the sink. The module is left on.
 */
async function heldProject(name: string, sourceUrl = `http://localhost:${pb.port}`): Promise<Held> {
  const clock = new TestClock();
  const f = await openLifecycle(clock);
  const instance = async (method: string, path: string, body?: unknown) => {
    const response = await f.call(method, path, body);
    return { status: response.status, body: await readJson<any>(response) };
  };
  const setInstance = async (changes: Record<string, unknown>) => {
    const shared = (await instance("GET", "/api/instance/settings")).body.data;
    const saved = await instance("PUT", "/api/instance/settings", { ...shared, ...changes });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  };
  const shared = (await instance("GET", "/api/instance/settings")).body.data;
  const smtp = asBody<Array<Record<string, unknown>>>(shared.smtp).map((item, index) =>
    index === 0
      ? {
          ...item,
          enabled: true,
          host: "127.0.0.1",
          port: sink.port,
          tls_type: "none",
          auth_protocol: "none",
          username: "",
          password: "",
          email_headers: [],
        }
      : item,
  );
  await setInstance({ "sources.enabled": true, "sources.private_hosts": ["localhost"], smtp });
  const key = await createApiUser(f.port, PRIMARY, await logIn(f.port, PRIMARY, f.admin), name);
  const call = async (method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await api(f.port, PRIMARY, key, method, path, body);
    return { status: response.status, body: response.text ? JSON.parse(response.text) : {} };
  };
  const project = (await call("GET", "/api/settings")).body.data;
  const saved = await call("PUT", "/api/settings", {
    ...project,
    "source.connector": "pocketbase",
    "source.url": sourceUrl,
    "source.identity": pb.service.identity,
    "source.password": pb.service.password,
    "source.recipients": {
      collection: "recipients",
      email: "email",
      name: "name",
      opt_out: "optOut",
    },
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  const list = asBody<number>(
    (await call("POST", "/api/lists", { name: "News", type: "public", optin: "single" })).body.data
      .id,
  );
  const member = async (email: string, subscriberName: string, externalId?: string) => {
    const created = await call("POST", "/api/subscribers", {
      email,
      name: subscriberName,
      lists: [list],
      preconfirm_subscriptions: true,
      ...(externalId ? { external_id: externalId } : {}),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    return asBody<number>(created.body.data.id);
  };
  const opalUser = await pb.user({ name: "Opal", marketingOptOut: true });
  const kitUser = await pb.user({ name: "Kit" });
  const unaEmail = `una-${crypto.randomUUID().slice(0, 8)}@example.com`;
  return {
    f,
    clock,
    call,
    setInstance,
    list,
    opal: { user: opalUser, id: await member(emailOf(opalUser), "Opal", opalUser.id) },
    kit: { user: kitUser, id: await member(emailOf(kitUser), "Kit", kitUser.id) },
    una: { email: unaEmail, id: await member(unaEmail, "Una") },
    member,
  };
}

test("off with a stored source: a campaign sends to the unlinked subscriber only, skipping both linked ones unavailable with one attention line", async () => {
  const h = await heldProject("api-held-campaign");
  try {
    await h.setInstance({ "sources.enabled": false });
    const created = await h.call("POST", "/api/campaigns", {
      name: "Held news",
      subject: "News",
      lists: [h.list],
      content_type: "html",
      body: "<p>News</p>",
      messenger: "email",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const id = asBody<number>(created.body.data.id);
    const started = await h.call("PUT", `/api/campaigns/${id}/status`, { status: "running" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await eventually(
      async () => (await h.call("GET", `/api/campaigns/${id}`)).body.data.status === "finished",
      "the campaign to finish",
      () => h.clock.advance(5000),
    );
    await eventually(() => mailTo(h.una.email) === 1, "Una's mail");
    expect(mailTo(emailOf(h.opal.user))).toBe(0);
    expect(mailTo(emailOf(h.kit.user))).toBe(0);
    const skipped = asBody<Array<{ subscriber_id: number; reason: string }>>(
      (await h.call("GET", `/api/campaigns/${id}/skipped`)).body.data.results,
    )
      .map((row) => [row.subscriber_id, row.reason])
      .sort((x, y) => Number(x[0]) - Number(y[0]));
    expect(skipped).toEqual(
      [
        [h.opal.id, "subscriber_unavailable"],
        [h.kit.id, "subscriber_unavailable"],
      ].sort((x, y) => Number(x[0]) - Number(y[0])),
    );
    // Both stay subscribed and linked: nothing was removed or unsubscribed for them.
    for (const { id: subscriber } of [h.opal, h.kit]) {
      const lists = asBody<Array<{ id: number; subscription_status: string }>>(
        (await h.call("GET", `/api/subscribers/${subscriber}`)).body.data.lists,
      );
      expect(lists.find((l) => l.id === h.list)?.subscription_status).toBe("confirmed");
    }
    const lines = asBody<Array<string>>((await h.call("GET", "/api/logs")).body.data);
    expect(
      lines.filter((line) =>
        line.includes("campaign recipients skipped: external sources are off"),
      ),
    ).toHaveLength(1);
    // On again, the finished campaign sends nothing more: a skipped recipient is never retried.
    await h.setInstance({ "sources.enabled": true });
    for (let i = 0; i < 20; i++) {
      h.clock.advance(5000);
      await Bun.sleep(20);
    }
    expect(mailTo(emailOf(h.opal.user))).toBe(0);
    expect(mailTo(emailOf(h.kit.user))).toBe(0);
    expect(mailTo(h.una.email)).toBe(1);
  } finally {
    await h.f.close();
  }
  expect(h.f.failures).toEqual([]);
});

// B162a r2 (D188): the module turned off while a campaign batch's source reads are in flight. The
// batch passed the held check before its reads, so only the reads themselves can tell held from
// absent: every read that starts after the toggle must hold its recipient, never send it unchecked.
// More linked recipients than `SOURCE_LOOKUPS` (8), so reads start after the toggle. The timing is
// driven by the harness and the test clock: PocketBase is paused, the clock steps the runner until
// a proxy reports the batch's first recipients read (which then hangs), the module is turned off,
// and PocketBase resumes.
test("off during a campaign batch's source reads: no opted-out linked recipient is sent, the later reads are skipped unavailable", async () => {
  const proxy = startCutProxy(pb.port);
  const h = await heldProject("api-held-race", `http://localhost:${new URL(proxy.url).port}`);
  let paused = false;
  try {
    const campaign = async (name: string, list: number) => {
      const created = await h.call("POST", "/api/campaigns", {
        name,
        subject: name,
        lists: [list],
        content_type: "html",
        body: "<p>News</p>",
        messenger: "email",
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      return asBody<number>(created.body.data.id);
    };
    const run = async (id: number) => {
      const started = await h.call("PUT", `/api/campaigns/${id}/status`, { status: "running" });
      expect(started.status, JSON.stringify(started.body)).toBe(200);
    };
    const finished = (id: number) =>
      eventually(
        async () => (await h.call("GET", `/api/campaigns/${id}`)).body.data.status === "finished",
        "the campaign to finish",
        () => h.clock.advance(1000),
      );
    // A warm-up campaign to Kit alone signs the project's source in, so the batch's first request
    // through the proxy is a recipients read, not the sign-in.
    const warm = asBody<number>(
      (await h.call("POST", "/api/lists", { name: "Warm", type: "public", optin: "single" })).body
        .data.id,
    );
    const added = await h.call("PUT", "/api/subscribers/lists", {
      ids: [h.kit.id],
      action: "add",
      target_list_ids: [warm],
      status: "confirmed",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const warmId = await campaign("Warm", warm);
    await run(warmId);
    await finished(warmId);
    await eventually(() => mailTo(emailOf(h.kit.user)) === 1, "Kit's warm-up mail");

    // 20 more linked members of News, all opted out of marketing in the source, as Opal is.
    const optedOut: Array<{ user: PocketBaseRecord; id: number }> = [h.opal];
    for (let i = 0; i < 20; i++) {
      const user = await pb.user({ name: `Opt${i}`, marketingOptOut: true });
      optedOut.push({ user, id: await h.member(emailOf(user), `Opt${i}`, user.id) });
    }
    const id = await campaign("Race", h.list);
    let read = false;
    proxy.cutWhen((line) => {
      read ||= line.includes("/api/collections/recipients/records");
      return false;
    });
    await pb.pause();
    paused = true;
    await run(id);
    // The runner claims on its tick; small steps keep the source's request timeout (on the test
    // clock) far away while the first read hangs.
    await eventually(
      () => read,
      "the batch's first recipients read",
      () => h.clock.advance(200),
    );
    await h.setInstance({ "sources.enabled": false });
    pb.resume();
    paused = false;
    await finished(id);
    await eventually(() => mailTo(h.una.email) === 1, "Una's mail");

    for (const { user } of optedOut) {
      expect(mailTo(emailOf(user)), emailOf(user)).toBe(0);
    }
    const reasons = new Map(
      asBody<Array<{ subscriber_id: number; reason: string }>>(
        (await h.call("GET", `/api/campaigns/${id}/skipped?per_page=100`)).body.data.results,
      ).map((row) => [row.subscriber_id, row.reason]),
    );
    // The reads in flight at the toggle saw the opt-out; the reads after it were held.
    const of = optedOut.map(({ id: subscriber }) => reasons.get(subscriber));
    expect(of.every((r) => r === "unsubscribed" || r === "subscriber_unavailable")).toBe(true);
    expect(of).toContain("unsubscribed");
    expect(of).toContain("subscriber_unavailable");
    const lines = asBody<Array<string>>((await h.call("GET", "/api/logs")).body.data);
    expect(
      lines.filter((line) =>
        line.includes("campaign recipients skipped: external sources are off"),
      ),
    ).toHaveLength(1);
  } finally {
    if (paused) {
      pb.resume();
    }
    proxy.cutWhen(undefined);
    await h.f.close();
    proxy.stop();
  }
  expect(h.f.failures).toEqual([]);
});

test("off with a stored source: a marketing step to a linked subscriber waits unsent; on again it runs with its send-time read", async () => {
  const h = await heldProject("api-held-step");
  try {
    const template = await h.call("POST", "/api/templates", {
      name: "Held step",
      type: "tx",
      subject: "Step",
      body: "<p>Step</p>",
    });
    expect(template.status).toBe(200);
    const sequence = await h.call("POST", "/api/sequences", {
      name: "Held marketing",
      status: "active",
      reentry: "never",
      list_id: h.list,
      trigger: { event: "signup" },
      steps: [{ wait: "P1D", kind: "marketing", template_id: template.body.data.id }],
    });
    expect(sequence.status, JSON.stringify(sequence.body)).toBe(200);
    const enroll = async (subscriber: number) => {
      const r = await h.call("POST", "/api/enrollments", {
        sequence_id: sequence.body.data.id,
        subscriber_id: subscriber,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return asBody<number>(r.body.data.id);
    };
    const opal = await enroll(h.opal.id);
    const kit = await enroll(h.kit.id);
    const una = await enroll(h.una.id);
    const enrollment = async (id: number) =>
      asBody<Record<string, any>>((await h.call("GET", `/api/enrollments/${id}`)).body.data);

    await h.setInstance({ "sources.enabled": false });
    h.clock.advance(day);
    await eventually(
      async () => (await enrollment(una)).status === "completed",
      "Una's step",
      () => h.clock.advance(60_000),
    );
    await eventually(
      () => mailTo(h.una.email) > 0,
      "Una's mail",
      () => h.clock.advance(1000),
    );
    expect(mailTo(h.una.email)).toBe(1);
    // Six more hours, a minute at a time: the linked enrollments wait at their step, unsent and
    // not ended.
    const before = await enrollment(opal);
    for (let i = 0; i < 360; i++) {
      h.clock.advance(60_000);
      if (i % 30 === 0) {
        await Bun.sleep(20);
      }
    }
    await Bun.sleep(300);
    for (const id of [opal, kit]) {
      expect(await enrollment(id)).toMatchObject({
        status: "active",
        exit_reason: null,
        step_id: before.step_id,
      });
    }
    expect(mailTo(emailOf(h.opal.user))).toBe(0);
    expect(mailTo(emailOf(h.kit.user))).toBe(0);

    // On again: the step runs with its send-time read. Kit gets it once; Opal's opt-out ends hers
    // `unsubscribed`, unsent.
    // The source's request timeout runs on the test clock: past the held steps' retry time, the
    // clock moves a minute a second, so a read in flight is never timed out by the test.
    await h.setInstance({ "sources.enabled": true });
    h.clock.advance(3_600_000);
    let ticks = 0;
    await eventually(
      async () =>
        (await enrollment(kit)).status !== "active" && (await enrollment(opal)).status !== "active",
      "the held steps to run",
      () => {
        if (++ticks % 50 === 0) {
          h.clock.advance(60_000);
        }
      },
    );
    expect(await enrollment(kit)).toMatchObject({ status: "completed", exit_reason: null });
    expect(await enrollment(opal)).toMatchObject({ status: "exited", exit_reason: "unsubscribed" });
    await eventually(() => mailTo(emailOf(h.kit.user)) === 1, "Kit's mail");
    for (let i = 0; i < 60; i++) {
      h.clock.advance(60_000);
      await Bun.sleep(5);
    }
    expect(mailTo(emailOf(h.kit.user))).toBe(1);
    expect(mailTo(emailOf(h.opal.user))).toBe(0);
    expect(mailTo(h.una.email)).toBe(1);
  } finally {
    await h.f.close();
  }
  expect(h.f.failures).toEqual([]);
});

test("a project that stores a source opened while the module is off says once that the source is held", async () => {
  const h = await heldProject("api-held-open");
  const safe = "Source held: external sources are off on this instance";
  const heldLines = async (f: LifecycleFixture) => {
    const key = await createApiUser(
      f.port,
      PRIMARY,
      await logIn(f.port, PRIMARY, f.admin),
      `api-open-${crypto.randomUUID().slice(0, 6)}`,
    );
    const response = await api(f.port, PRIMARY, key, "GET", "/api/logs");
    return asBody<Array<string>>(JSON.parse(response.text).data).filter((line) =>
      line.includes(safe),
    ).length;
  };
  // Opened with the module on: no line.
  expect(await heldLines(h.f)).toBe(0);
  await h.setInstance({ "sources.enabled": false });
  // Turned off while running: the stream stops without a line (D188).
  expect(await heldLines(h.f)).toBe(0);
  await h.f.close(true);
  const reopened = await openLifecycle(h.clock, { dataDir: h.f.dataDir });
  try {
    expect(await heldLines(reopened)).toBe(1);
    // Not repeated by the loops' passes.
    for (let i = 0; i < 30; i++) {
      h.clock.advance(60_000);
      await Bun.sleep(10);
    }
    expect(await heldLines(reopened)).toBe(1);
  } finally {
    await reopened.close();
  }
  expect(reopened.failures).toEqual([]);
});

test("off, more held external enrollments than one claim batch do not keep a due pushed enrollment from running within the pass", async () => {
  let on = true;
  const pocketbase = createPocketBaseSource({
    config: sourceConfig(pb.url, pb.service),
    clock: createRealClock(),
    guard: openGuard,
  });
  const source = (): ExternalSource | null => (on ? pocketbase : null);
  const f = await schedulerFixture({ source, sourcesEnabled: () => on });
  try {
    const template = await f.template();
    const external = await f.sequence({
      source: "external",
      steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
    });
    // 120 held enrollments, more than the scheduler's claim batch of 100, all due first.
    const held: Array<number> = [];
    for (let i = 0; i < 120; i++) {
      // Made-up user IDs: nothing reads the source while the module is off.
      const subscriber = await f.subscriber(`held-${i}@example.com`, {
        external_id: `held${String(i).padStart(11, "0")}`,
      });
      const r = await f.json("/api/enrollments", "POST", {
        sequence_id: external.id,
        subscriber_id: subscriber,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      held.push(asBody<number>(r.body.data.id));
    }
    await f.pass(60_000);
    const pushed = await f.sequence({
      steps: [{ wait: "P1D", kind: "transactional", template_id: template }],
    });
    const due = await f.subscriber("due@example.com");
    const enrolled = await f.json("/api/enrollments", "POST", {
      sequence_id: pushed.id,
      subscriber_id: due,
    });
    expect(enrolled.status).toBe(200);
    const enrollment = asBody<number>(enrolled.body.data.id);
    on = false;
    // Every enrollment is due; the pass claims only the pushed one, which sends at once.
    await f.pass(day);
    await f.until(async () => (await f.enrollment(enrollment)).status === "completed", "the step");
    await f.until(() => f.sink.messages.length > 0, "the mail");
    expect(f.sink.messages.map((m) => m.to)).toEqual([["due@example.com"]]);
    for (const id of [held[0]!, held[119]!]) {
      expect(await f.enrollment(id)).toMatchObject({ status: "active", error_since: null });
    }
  } finally {
    await f.close();
  }
});
