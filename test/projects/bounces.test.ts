// B142 (14-projects sections 8 and 15 "Bounces", D156): SES notices through the compiled executable.
// `POST /webhooks/service/ses` is the instance's route on the instance host (127.0.0.1 here), with
// the instance's bounce keys and topic ARNs; a notice lands in the one project whose own sends,
// campaign deliveries or test sends its Message-ID names, whatever its domain (B149b, D165).
// The process fetches the SNS signing certificate through the loopback tunnel (sns-tunnel.ts), and
// the notices are signed with the real time, as the route checks their age against the real clock.
// The instance runs in four phases over one data directory: one project, three, an ambiguous copy,
// and no primary project.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { createRealClock } from "@/clock";
import { openInstanceDatabase } from "@/projects/instance";
import { createRegistry } from "@/projects/registry";
import { bounceMessage, envelope, TOPIC } from "@/test/bounces/ses-fixture";
import { startSnsTunnel } from "@/test/bounces/sns-tunnel";
import type { SnsTunnel } from "@/test/bounces/sns-tunnel";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { asBody } from "@/test/read-body";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const OLD_A = "old.a.example.test";
const B = "b.example.test";
const C = "c.example.test";
const UNMATCHED = "[instance] An SES notice matched no project";
const real = { clock: { now: () => new Date() } };

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let tunnel: SnsTunnel;
let admin: Credentials;
let dataDir = "";
let server: Awaited<ReturnType<typeof startInstance>> | undefined;
let port = 0;
/** Each project's API credential, by host. It lives in the project's database, so it survives. */
const keys = new Map<string, string>();

interface Subscriber {
  id: number;
  uuid: string;
  email: string;
}
interface Bounce {
  type: string;
  source: string;
  email?: string;
  subscriber_id?: number;
  campaign: { id: number } | null;
}

async function start() {
  server = await startInstance(prepared.executable, dataDir, admin, tunnel.environment);
  port = server.port;
}
/** Stops the instance and returns its stderr. */
async function stop() {
  const stopped = await must(server).stop();
  server = undefined;
  return stopped.stderr;
}
const must = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("missing");
  }
  return value;
};
const key = (host: string) => must(keys.get(host));
async function apiUser(host: string, name: string) {
  keys.set(host, await createApiUser(port, host, await logIn(port, host, admin), `api-${name}`));
}
async function call<T>(host: string, method: string, path: string, body?: unknown) {
  const response = await api(port, host, key(host), method, path, body);
  expect({ path, status: response.status }).toEqual({ path, status: 200 });
  return asBody<{ data: T }>(JSON.parse(response.text)).data;
}
const subscriber = (host: string, email: string) =>
  call<Subscriber>(host, "POST", "/api/subscribers", {
    email,
    name: email,
    status: "enabled",
    lists: [],
  });
const statusOf = async (host: string, id: number) =>
  (await call<{ status: string }>(host, "GET", `/api/subscribers/${id}`)).status;
async function campaign(host: string, name: string) {
  const list = await call<{ id: number }>(host, "POST", "/api/lists", {
    name,
    type: "private",
    optin: "single",
  });
  return call<{ id: number; uuid: string }>(host, "POST", "/api/campaigns", {
    name,
    subject: "Bounce subject",
    lists: [list.id],
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Body",
  });
}
const bounces = async (host: string) =>
  (await call<{ results: Array<Bounce> }>(host, "GET", "/api/bounces?per_page=all")).results;

/**
 * A signed SES bounce for `recipients`, with our Message-ID header when one is given. `truncated`
 * sends SES's truncated headers: the list is empty, and the common headers name `messageId`.
 */
function notice(
  recipients: Array<string>,
  messageId?: string,
  bounceType = "Permanent",
  truncated = false,
) {
  return envelope(real, {
    Message: bounceMessage(
      real,
      recipients,
      { bounceType },
      messageId && !truncated ? [{ name: "Message-ID", value: messageId }] : [],
      truncated
        ? { headersTruncated: true, commonHeaders: messageId ? { messageId, subject: "S" } : {} }
        : {},
    ),
  });
}
/** A signed SES bounce whose header list is `headers` as given (the message as it was sent). */
const sentAs = (recipients: Array<string>, headers: Array<{ name: string; value: string }>) =>
  envelope(real, {
    Message: bounceMessage(real, recipients, { bounceType: "Permanent" }, headers),
  });
/** Posts a notice on `host` (the instance host unless named). */
async function deliver(body: unknown, host = PRIMARY) {
  const response = await request(port, host, "/webhooks/service/ses", {
    method: "POST",
    headers: { "content-type": "text/plain", "x-amz-sns-message-type": "Notification" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}
const sorted = (values: Array<string | undefined>) =>
  values.toSorted((x, y) => String(x).localeCompare(String(y)));
const countLines = (stderr: string, line: string) =>
  stderr.split("\n").filter((entry) => entry.startsWith(line)).length;

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  tunnel = await startSnsTunnel();
  dataDir = join(prepared.directory, "data");
  // Phase 1: a fresh install, the primary project alone.
  await start();
  await apiUser(PRIMARY, "main");
  const operator = must((await instanceLogin(port, PRIMARY, admin)).session);
  for (const [name, value] of [
    ["bounce.enabled", true],
    ["bounce.webhooks_enabled", true],
    ["bounce.ses_enabled", true],
    ["bounce.ses_topic_arns", [TOPIC]],
  ] as const) {
    const saved = await instanceCall(
      port,
      PRIMARY,
      operator,
      "PUT",
      `/api/instance/settings/${name}`,
      value,
    );
    expect({ name, status: saved.status }).toEqual({ name, status: 200 });
  }
});

afterAll(async () => {
  if (server) {
    await stop();
  }
  await tunnel?.close();
  await prepared?.cleanup();
});

test("one project: every notice goes to it as today, including the address fallback", async () => {
  const bare = await subscriber(PRIMARY, "one-bare@example.com");
  const foreign = await subscriber(PRIMARY, "one-foreign@example.com");
  // No Message-ID at all: the recipient address names the subscriber.
  expect((await deliver(notice([bare.email]))).status).toBe(200);
  // A Message-ID of a domain no project holds and UUIDs it never sent: still this project's.
  const unknown = `<${crypto.randomUUID()}@elsewhere.example.test>`;
  expect((await deliver(notice([foreign.email], unknown))).status).toBe(200);
  const rows = await bounces(PRIMARY);
  expect(sorted(rows.map((row) => row.email))).toEqual(sorted([bare.email, foreign.email]));
  expect(rows.every((row) => row.source === "ses" && row.type === "hard")).toBe(true);
  expect(await statusOf(PRIMARY, bare.id)).toBe("blocklisted");
  // A repeat of a delivered message is recorded once.
  const once = notice([(await subscriber(PRIMARY, "one-repeat@example.com")).email]);
  expect((await deliver(once)).status).toBe(200);
  expect((await deliver(once)).status).toBe(200);
  expect((await bounces(PRIMARY)).length).toBe(3);
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
});

const counts = async () =>
  Promise.all([PRIMARY, A, B].map(async (host) => (await bounces(host)).length));

/** Phase 2's fixtures: the same address in every project, and a campaign in each. */
const shared = "shared@example.com";
const people = new Map<string, Subscriber>();
const campaigns = new Map<string, { id: number; uuid: string }>();
let unmatchedSent = 0;
/** Bounces of A's test sends: each is one `[a] Test send bounced` line. */
let testBounces = 0;

test("several projects: a notice lands in the project whose delivery its Message-ID names", async () => {
  // Phase 2: projects `a` (with an extra hostname) and `b` beside the primary.
  registerProjects(dataDir, [
    { slug: "a", name: "A", hostname: A, extra: [OLD_A] },
    { slug: "b", name: "B", hostname: B },
  ]);
  await start();
  await apiUser(A, "a");
  await apiUser(B, "b");
  for (const host of [PRIMARY, A, B]) {
    people.set(host, await subscriber(host, shared));
    campaigns.set(host, await campaign(host, `ses-${host}`));
  }
  const before = await bounces(PRIMARY);
  for (const host of [A, B]) {
    const own = must(people.get(host));
    const id = `<${must(campaigns.get(host)).uuid}.${own.uuid}@${host}>`;
    expect((await deliver(notice([shared], id), PRIMARY)).status).toBe(200);
    const [row] = await bounces(host);
    expect(row?.subscriber_id).toBe(own.id);
    expect(row?.campaign?.id).toBe(must(campaigns.get(host)).id);
    expect(await statusOf(host, own.id)).toBe("blocklisted");
  }
  // Each project holds only its own notice; the primary none of them.
  expect((await bounces(A)).length).toBe(1);
  expect((await bounces(B)).length).toBe(1);
  expect(await bounces(PRIMARY)).toEqual(before);
  expect(await statusOf(PRIMARY, must(people.get(PRIMARY)).id)).toBe("enabled");
});

test("a project's host in a Message-ID naming none of its records routes nowhere: no address fallback", async () => {
  // B149b (B142 r1): a hostname moves, and a test send's Message-ID is the user's to choose, so
  // the domain is no proof the mail came from that project.
  const a = await subscriber(A, "extra@example.com");
  const b = await subscriber(B, "extra@example.com");
  const before = await counts();
  for (const host of [A, OLD_A, B]) {
    expect((await deliver(notice([a.email], `<${crypto.randomUUID()}@${host}>`))).status).toBe(200);
    unmatchedSent++;
  }
  expect(await counts()).toEqual(before);
  expect(await statusOf(A, a.id)).toBe("enabled");
  expect(await statusOf(B, b.id)).toBe("enabled");
});

test("a project's own delivery lands in it whatever host its Message-ID names, in any case", async () => {
  // A's delivery named with B's host (a hostname that moved from A to B, say), upper-cased.
  const own = await subscriber(A, "moved@example.com");
  const other = await subscriber(B, "moved@example.com");
  const id = `<${must(campaigns.get(A)).uuid}.${own.uuid}@${B}>`.toUpperCase();
  expect((await deliver(notice([own.email], id, "Transient"))).status).toBe(200);
  const rows = (await bounces(A)).filter((row) => row.subscriber_id === own.id);
  expect(rows.map((row) => [row.type, row.campaign?.id])).toEqual([
    ["soft", must(campaigns.get(A)).id],
  ]);
  expect((await bounces(B)).some((row) => row.subscriber_id === other.id)).toBe(false);
});

test("a test send's chosen Message-ID with another project's host stays in the sending project", async () => {
  // B142 r1's case: a user of A sends a campaign test with a Message-ID naming B's host. Its
  // bounce is A's test send (a log line), never B's subscriber of the same address.
  const own = await subscriber(A, "chosen@example.com");
  const other = await subscriber(B, "chosen@example.com");
  const list = await call<{ id: number }>(A, "POST", "/api/lists", {
    name: "chosen",
    type: "private",
    optin: "single",
  });
  const { id } = await call<{ id: number }>(A, "POST", "/api/campaigns", {
    name: "chosen",
    subject: "Chosen",
    lists: [list.id],
    content_type: "plain",
    type: "regular",
    messenger: "email",
    body: "Body",
  });
  // Not in the app's own `<uuid@host>` form, which a campaign test refuses (B149b r1).
  const chosen = `<chosen-${crypto.randomUUID()}@${B}>`;
  const tested = await api(port, A, key(A), "POST", `/api/campaigns/${id}/test`, {
    name: "chosen",
    subject: "Chosen",
    lists: [list.id],
    type: "regular",
    content_type: "plain",
    messenger: "email",
    body: "Body",
    headers: [{ "Message-ID": chosen }],
    subscribers: [own.email],
  });
  expect({ status: tested.status, text: tested.text }).toEqual({ status: 200, text: tested.text });
  const before = await counts();
  expect((await deliver(notice([own.email], chosen))).status).toBe(200);
  expect(await counts()).toEqual(before);
  expect(await statusOf(A, own.id)).toBe("enabled");
  expect(await statusOf(B, other.id)).toBe("enabled");
  testBounces++;
});

test("an unknown domain falls back to the projects' sends, campaigns and test sends", async () => {
  const own = await subscriber(B, "probe@example.com");
  const before = (await bounces(B)).length;
  const id = `<${must(campaigns.get(B)).uuid}.${own.uuid}@unknown.example.test>`;
  expect((await deliver(notice([own.email], id, "Transient"))).status).toBe(200);
  const rows = await bounces(B);
  expect(rows.length).toBe(before + 1);
  expect(rows.find((row) => row.subscriber_id === own.id)?.campaign?.id).toBe(
    must(campaigns.get(B)).id,
  );
  expect((await bounces(A)).filter((row) => row.type === "soft").length).toBe(1);
});

test("a campaign test refuses a Message-ID in the app's own send or delivery form", async () => {
  // B149b r1: the review's probe. A user of A names B's campaign delivery (B's campaign, the
  // user's own B subscription, both public) and overrides the subscriber header; once A's test
  // record aged out, B alone claimed the late bounce and blocklisted its own subscriber of the
  // test's address. The test is refused, so no such message is ever sent.
  const victimA = await subscriber(A, "probe-victim@example.com");
  const victimB = await subscriber(B, "probe-victim@example.com");
  const attackerB = await subscriber(B, "probe-attacker@example.com");
  const bCampaign = must(campaigns.get(B));
  const list = await call<{ id: number }>(A, "POST", "/api/lists", {
    name: "probe",
    type: "private",
    optin: "single",
  });
  const fields = {
    name: "probe",
    subject: "Probe",
    lists: [list.id],
    type: "regular",
    content_type: "plain",
    messenger: "email",
    body: "Body",
  };
  const { id } = await call<{ id: number }>(A, "POST", "/api/campaigns", fields);
  const forms = [
    `<${bCampaign.uuid}.${attackerB.uuid}@x.example.test>`,
    `<${bCampaign.uuid}.${attackerB.uuid}@${A}>`.toUpperCase(),
    `${crypto.randomUUID()}@${B}`,
    ` <${crypto.randomUUID()}@x.example.test> `,
  ];
  for (const forged of forms) {
    const tested = await api(port, A, key(A), "POST", `/api/campaigns/${id}/test`, {
      ...fields,
      headers: [{ "Message-ID": forged }, { "x-listmonk-subscriber": "x" }],
      subscribers: [victimA.email],
    });
    expect({ forged, status: tested.status }).toEqual({ forged, status: 400 });
  }
  // The late notice that message would have produced: B's delivery is the only record it names.
  const before = await counts();
  const late = sentAs(
    [victimA.email],
    [
      { name: "X-Listmonk-Campaign", value: must(campaigns.get(A)).uuid },
      { name: "x-listmonk-subscriber", value: "x" },
      { name: "Message-ID", value: must(forms[0]) },
    ],
  );
  expect((await deliver(late)).status).toBe(200);
  unmatchedSent++;
  expect(await counts()).toEqual(before);
  expect(await statusOf(B, victimB.id)).toBe("enabled");
  expect(await statusOf(A, victimA.id)).toBe("enabled");
});

test("a delivery whose X-Listmonk headers disagree with its Message-ID routes nowhere", async () => {
  // B149b r1: with several projects a delivery routes by the UUIDs its Message-ID names, and its
  // events act on that subscriber only; a header that names anything else is not believed.
  const victimA = await subscriber(A, "headers-victim@example.com");
  const victimB = await subscriber(B, "headers-victim@example.com");
  const named = await subscriber(B, "headers-named@example.com");
  const id = `<${must(campaigns.get(B)).uuid}.${named.uuid}@x.example.test>`;
  const variants: Array<Array<{ name: string; value: string }>> = [
    // Not a UUID: before, the subscriber was looked up by the recipient's address.
    [{ name: "x-listmonk-subscriber", value: "x" }],
    // Another subscriber of B, the one whose address bounced.
    [{ name: "X-Listmonk-Subscriber", value: victimB.uuid }],
    // Another campaign.
    [{ name: "X-Listmonk-Campaign", value: must(campaigns.get(A)).uuid }],
    [{ name: "X-Listmonk-Campaign", value: "not-a-campaign" }],
  ];
  const before = await counts();
  for (const headers of variants) {
    const answer = await deliver(
      sentAs([victimA.email], [...headers, { name: "Message-ID", value: id }]),
    );
    expect(answer.status).toBe(200);
    unmatchedSent++;
  }
  expect(await counts()).toEqual(before);
  expect(await statusOf(B, victimB.id)).toBe("enabled");
  expect(await statusOf(B, named.id)).toBe("enabled");
  expect(await statusOf(A, victimA.id)).toBe("enabled");
  // Headers that agree (in any case) still route, and act on the delivery's own subscriber.
  const agreeing = sentAs(
    [named.email],
    [
      { name: "X-Listmonk-Campaign", value: must(campaigns.get(B)).uuid.toUpperCase() },
      { name: "X-Listmonk-Subscriber", value: named.uuid },
      { name: "Message-ID", value: id },
    ],
  );
  expect((await deliver(agreeing)).status).toBe(200);
  expect(await statusOf(B, named.id)).toBe("blocklisted");
});

test("a transactional send's notice acts only on the send's own subscriber", async () => {
  // B149b r1: the same forgery against a send record. A send routes by its UUID; its subscriber
  // is the send's, never one looked up by address or named by a header.
  const recipient = await subscriber(B, "tx-recipient@example.com");
  const victimB = await subscriber(B, "tx-victim@example.com");
  const victimA = await subscriber(A, "tx-victim@example.com");
  const templates = await call<Array<{ id: number; type: string }>>(B, "GET", "/api/templates");
  await call(B, "POST", "/api/tx", {
    subscriber_email: recipient.email,
    template_id: templates.find((item) => item.type === "tx")?.id,
    async: true,
  });
  const sends = await call<{ results: Array<{ uuid: string; to_email: string }> }>(
    B,
    "GET",
    "/api/sends?per_page=100",
  );
  const send = must(sends.results.find((row) => row.to_email === recipient.email));
  const id = `<${send.uuid}@x.example.test>`;
  const before = await counts();
  for (const headers of [
    [{ name: "x-listmonk-subscriber", value: "x" }],
    [{ name: "X-Listmonk-Subscriber", value: victimB.uuid }],
  ]) {
    expect(
      (await deliver(sentAs([victimB.email], [...headers, { name: "Message-ID", value: id }])))
        .status,
    ).toBe(200);
  }
  // The bounced address is not the send's: at most a row with codes only, no subscriber touched.
  const [a, b] = [(await counts())[1], (await counts())[2]];
  expect(a).toBe(before[1]);
  expect(must(b) - must(before[2])).toBeLessThanOrEqual(1);
  expect((await bounces(B)).some((row) => row.subscriber_id === victimB.id)).toBe(false);
  expect(await statusOf(B, victimB.id)).toBe("enabled");
  expect(await statusOf(A, victimA.id)).toBe("enabled");
  // A header naming another subscriber than the send's stores nothing at all.
  const named = await counts();
  expect(
    (
      await deliver(
        sentAs(
          [recipient.email],
          [
            { name: "X-Listmonk-Subscriber", value: victimB.uuid },
            { name: "Message-ID", value: id },
          ],
        ),
      )
    ).status,
  ).toBe(200);
  expect(await counts()).toEqual(named);
  expect(await statusOf(B, recipient.id)).toBe("enabled");
  // The send's own notice still lands on its subscriber.
  expect(
    (await deliver(sentAs([recipient.email], [{ name: "Message-ID", value: id }]))).status,
  ).toBe(200);
  expect(await statusOf(B, recipient.id)).toBe("blocklisted");
});

test("a notice no project claims stores nothing anywhere and names itself once", async () => {
  const before = await counts();
  // Unknown domain and UUIDs; and no Message-ID at all. The address is a subscriber everywhere.
  for (const id of [`<${crypto.randomUUID()}@unknown.example.test>`, undefined]) {
    expect((await deliver(notice([shared], id))).status).toBe(200);
    unmatchedSent++;
  }
  expect(await counts()).toEqual(before);
  for (const host of [PRIMARY, A, B]) {
    expect(await statusOf(host, must(people.get(host)).id)).toBe(
      host === PRIMARY ? "enabled" : "blocklisted",
    );
  }
});

test("truncated headers: the common headers' Message-ID routes; without one, nothing is stored", async () => {
  // B149b (B142 r1): SES drops the header list of a large message, not its common headers.
  const own = await subscriber(B, "truncated@example.com");
  const id = `<${must(campaigns.get(B)).uuid}.${own.uuid}@${B}>`;
  expect((await deliver(notice([own.email], id, "Permanent", true))).status).toBe(200);
  expect(await statusOf(B, own.id)).toBe("blocklisted");
  // No Message-ID at all: the address is a subscriber of A only, and still no project is chosen
  // by address (D165): a transactional send from B can reach an address only A holds.
  const only = await subscriber(A, "only-a@example.com");
  const before = await counts();
  expect((await deliver(notice([only.email], undefined, "Permanent", true))).status).toBe(200);
  unmatchedSent++;
  expect(await counts()).toEqual(before);
  expect(await statusOf(A, only.id)).toBe("enabled");
});

/** A's subscriber that phase 3's copy `c` holds too, with the same UUID. */
let twin: Subscriber | undefined;

test("a project host does not serve the SES route", async () => {
  const fresh = await subscriber(A, "project-host@example.com");
  twin = fresh;
  const before = (await bounces(A)).length;
  for (const host of [A, OLD_A]) {
    const id = `<${must(campaigns.get(A)).uuid}.${fresh.uuid}@${A}>`;
    const answer = await deliver(notice([fresh.email], id), host);
    expect(answer.status).toBe(400);
    expect(asBody<{ message: string }>(JSON.parse(answer.body)).message).toBe("Unknown service.");
  }
  expect((await bounces(A)).length).toBe(before);
  expect(await statusOf(A, fresh.id)).toBe("enabled");
  const stderr = await stop();
  expect(countLines(stderr, UNMATCHED)).toBe(unmatchedSent);
  expect(countLines(stderr, "[a] Test send bounced")).toBe(testBounces);
});

test("two projects that both claim a Message-ID: nothing is stored, and the line is written", async () => {
  // Phase 3: `c` starts as a copy of `a`'s database, so both hold the same campaign and subscriber.
  await cp(join(dataDir, "projects", "a"), join(dataDir, "projects", "c"), { recursive: true });
  registerProjects(dataDir, [{ slug: "c", name: "C", hostname: C }]);
  await start();
  keys.set(C, key(A));
  const both = must(twin);
  const before = [(await bounces(A)).length, (await bounces(C)).length];
  const id = `<${must(campaigns.get(A)).uuid}.${both.uuid}@unknown.example.test>`;
  expect((await deliver(notice([both.email], id))).status).toBe(200);
  expect([(await bounces(A)).length, (await bounces(C)).length]).toEqual(before);
  expect(await statusOf(A, both.id)).toBe("enabled");
  expect(await statusOf(C, both.id)).toBe("enabled");
  // Its host does not break the tie (B149b): the copy's own host routes nothing either.
  const hosted = `<${must(campaigns.get(A)).uuid}.${both.uuid}@${C}>`;
  expect((await deliver(notice([both.email], hosted))).status).toBe(200);
  expect(await statusOf(C, both.id)).toBe("enabled");
  expect(await statusOf(A, both.id)).toBe("enabled");
  // A campaign delivery is a project's only when its subscriber is too: the shared campaign with
  // a subscriber only A holds is A's alone.
  const own = await subscriber(A, "ambiguous@example.com");
  const copy = await subscriber(C, "ambiguous@example.com");
  const delivery = `<${must(campaigns.get(A)).uuid}.${own.uuid}@unknown.example.test>`;
  expect((await deliver(notice([own.email], delivery))).status).toBe(200);
  expect(await statusOf(A, own.id)).toBe("blocklisted");
  expect(await statusOf(C, copy.id)).toBe("enabled");
  expect(countLines(await stop(), UNMATCHED)).toBe(2);
});

test("without a primary project the route still works on the instance host", async () => {
  // Phase 4: the primary and the copy are unregistered; `a` and `b` remain.
  const clock = createRealClock();
  const db = openInstanceDatabase(dataDir, clock);
  try {
    const registry = createRegistry(db, clock);
    registry.remove("main");
    registry.remove("c");
    registry.close();
  } finally {
    db.close();
  }
  await start();
  const fresh = await subscriber(B, "no-primary@example.com");
  const id = `<${must(campaigns.get(B)).uuid}.${fresh.uuid}@${B}>`;
  expect((await deliver(notice([fresh.email], id), PRIMARY)).status).toBe(200);
  expect(await statusOf(B, fresh.id)).toBe("blocklisted");
  // An unclaimed host is answered as the instance host.
  const other = await subscriber(B, "no-primary-other@example.com");
  const otherId = `<${must(campaigns.get(B)).uuid}.${other.uuid}@${B}>`;
  expect((await deliver(notice([other.email], otherId), "unclaimed.example.test")).status).toBe(
    200,
  );
  expect(await statusOf(B, other.id)).toBe("blocklisted");
  expect(countLines(await stop(), UNMATCHED)).toBe(0);
});
