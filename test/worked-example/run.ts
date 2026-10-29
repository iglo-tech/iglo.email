// The docs/design/05-sequences.md worked example, end to end against dist/iglo.email through
// its public HTTP API, with every wait shortened to seconds. Each email is checked by what the
// loopback SMTP sink received (recipient, subject, body marker). Run with `bun run worked-example`.
// Scenarios and data: test/worked-example/README.md.
import {
  apiClient,
  check,
  startMailbox,
  startProduction,
  type Api,
  type Mailbox,
} from "@/test/worked-example/harness";

/** Every shortened `P3D`/`P5D`/`P45D` wait. */
const WAIT = "PT10S";
const WAIT_SECONDS = 10;
/** `marketing.min_interval`, short enough for the run. */
const CAP = "PT30S";
const CAP_MS = 30_000;
/** One scheduler interval (15 s) plus margin: the longest a due step legitimately waits. */
const TICK_MS = 20_000;
/** The step added after the deleted one waits longer than TICK_MS, so waiting again shows. */
const TIPS_WAIT = "PT40S";
const TIPS_WAIT_MS = 40_000;

const subjects = {
  credits: "Credits ready",
  hand: "Need a hand?",
  second: "Second pack: try the subscription",
  welcome: "Welcome",
  setup: "Did the setup work?",
  month: "Your month",
  failed: "Payment failed",
  failed2: "Payment failed: second notice",
  failedFinal: "Payment failed: final notice",
  question: "One question",
  winback: "Win-back",
  tips: "Tips",
} as const;
type Key = keyof typeof subjects;
const marketing = new Set<Key>(["hand", "second", "setup", "month", "winback"]);

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const log = (line: string) => console.log(`[${elapsed()}] ${line}`);

const run = crypto.randomUUID().slice(0, 8);
const email = (name: string) => `${name}-${run}@worked.example.test`;

const production = await startProduction();
const mailbox = await startMailbox();
/** Every message the run expects, exactly once. */
const expected: [string, string][] = [];
let failure: unknown;
try {
  const api = await apiClient(production.origin);
  await scenario(api, mailbox, expected);
} catch (error) {
  failure = error;
} finally {
  try {
    await production.stop();
  } catch (error) {
    failure ??= error;
  }
  await production.close();
  await mailbox.close();
}
if (failure) {
  if (production.errors()) console.error(`production stderr:\n${production.errors()}`);
  throw failure;
}
log(`worked example passed: ${expected.length} emails, each received exactly once`);

async function scenario(api: Api, mail: Mailbox, expected: [string, string][]) {
  const { ok } = api;

  // --- Setup: SMTP to the sink, a short cap, templates, a marketing list and the sequences.
  const settings = await ok("/api/settings");
  await ok("/api/settings/smtp", "PUT", [
    {
      ...settings.smtp[0],
      enabled: true,
      host: "127.0.0.1",
      port: mail.port,
      auth_protocol: "none",
      username: "",
      password: "",
      tls_type: "none",
      email_headers: [],
    },
  ]);
  await ok("/api/settings/marketing.min_interval", "PUT", CAP);
  const list = (
    await ok("/api/lists", "POST", { name: "Product news", type: "public", optin: "single" })
  ).id as number;

  const template = async (key: Key) => {
    const unsubscribe = marketing.has(key)
      ? ` <a href="{{ unsubscribe_url }}">Unsubscribe</a>`
      : "";
    return (
      await ok("/api/templates", "POST", {
        name: subjects[key],
        type: "tx",
        subject: subjects[key],
        body: `<p>marker:${key} Hi {{ subscriber.attribs.first_name }} [{{ sequence.name }}] downloads={{ trigger.data.downloads }}${unsubscribe}</p>`,
      })
    ).id as number;
  };
  const t = Object.fromEntries(
    await Promise.all((Object.keys(subjects) as Key[]).map(async (k) => [k, await template(k)])),
  ) as Record<Key, number>;

  const sequence = async (definition: Record<string, unknown>) =>
    ok("/api/sequences", "POST", { status: "active", reentry: "never", ...definition });
  const tx = (key: Key, wait = "PT0S") => ({ wait, kind: "transactional", template_id: t[key] });
  const mk = (key: Key, wait: string, extra: Record<string, unknown> = {}) => ({
    wait,
    kind: "marketing",
    template_id: t[key],
    ...extra,
  });
  const prepaid = await sequence({
    name: "Prepaid onboarding",
    trigger: { event: "order_paid", where: { "data.product": "prepaid" } },
    exit_on: ["subscription_created"],
    list_id: list,
    steps: [
      tx("credits"),
      mk("hand", WAIT, {
        condition: { not: { event: "download_finished", since: "trigger" } },
        on_false: "exit",
      }),
    ],
  });
  await sequence({
    name: "Second pack",
    trigger: { event: "order_paid", where: { "data.order_number": 2 } },
    list_id: list,
    steps: [mk("second", "PT0S")],
  });
  const welcome = await sequence({
    name: "Subscription welcome",
    trigger: { event: "subscription_created" },
    list_id: list,
    reentry: "after_exit",
    steps: [
      tx("welcome"),
      mk("setup", WAIT, { condition: { not: { event: "connected", since: "trigger" } } }),
    ],
  });
  const monthly = await sequence({
    name: "Monthly summary",
    trigger: { event: "subscription_monthly_summary" },
    list_id: list,
    reentry: "always",
    steps: [mk("month", "PT0S", { condition: { event: "download_finished", since: "P30D" } })],
  });
  const payment = await sequence({
    name: "Payment failed",
    trigger: { event: "subscription_past_due" },
    exit_on: ["payment_succeeded"],
    reentry: "after_exit",
    steps: [tx("failed"), tx("failed2", WAIT)],
  });
  const cancellation = await sequence({
    name: "Cancellation",
    trigger: { event: "subscription_canceled" },
    exit_on: ["subscription_created"],
    list_id: list,
    steps: [
      tx("question"),
      mk("winback", WAIT, {
        condition: { not: { event: "feedback_given", where: { "data.reason": "price" } } },
      }),
    ],
  });
  log("setup: SMTP sink, cap, 12 templates, 6 active sequences");

  // --- Helpers over the public API.
  const subscribers = new Map<string, number>();
  const person = async (name: string, plan: string) => {
    const created = await ok("/api/subscribers", "POST", {
      email: email(name),
      name,
      lists: [list],
      attribs: { first_name: name, plan },
    });
    subscribers.set(name, created.id);
  };
  let keys = 0;
  const event = async (
    name: string,
    event: string,
    data: Record<string, unknown> = {},
    occurredAt?: Date,
  ) =>
    ok("/api/subscriber-events", "POST", {
      subscriber: { email: email(name), attribs: { first_name: name } },
      name: event,
      data,
      ...(occurredAt ? { occurred_at: occurredAt.toISOString() } : {}),
      idempotency_key: `worked:${run}:${++keys}`,
    }) as Promise<{
      subscriber_id: number;
      enrollments: {
        started: { id: number; sequence_id: number }[];
        ended: { id: number; sequence_id: number; exit_reason: string }[];
      };
    }>;
  const startedIn = (response: Awaited<ReturnType<typeof event>>, sequence: { id: number }) =>
    response.enrollments.started.find((e) => e.sequence_id === sequence.id)?.id;
  const enrollment = (id: number) => ok(`/api/enrollments/${id}`);
  const enrollmentsOf = async (name: string) =>
    (await ok(`/api/enrollments?subscriber_id=${subscribers.get(name)}&per_page=50`)).results as {
      id: number;
      sequence_id: number;
      status: string;
      exit_reason: string | null;
      due_at: string | null;
    }[];
  const membership = async (name: string) =>
    (await ok(`/api/subscribers/${subscribers.get(name)}`)).lists.find(
      (l: { id: number }) => l.id === list,
    )?.subscription_status as string;
  const receive = async (name: string, key: Key, timeoutMs?: number) => {
    const found = await mail.one(email(name), subjects[key], timeoutMs);
    check(found.body.includes(`marker:${key} Hi ${name}`), `${key} body marker for ${name}`);
    expected.push([email(name), subjects[key]]);
    return found;
  };
  /** Wait until the enrollment is no longer active, and return it. */
  const waitForEnd = async (id: number, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await enrollment(id);
      if (current.status !== "active") return current;
      check(Date.now() < deadline, `enrollment ${id} still active`);
      await Bun.sleep(250);
    }
  };
  const waitForStatus = async (id: number, status: string, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await enrollment(id);
      if (current.status === status) return current;
      check(Date.now() < deadline, `enrollment ${id} still ${current.status}, wanted ${status}`);
      await Bun.sleep(250);
    }
  };

  const names = [
    "p1",
    "p2",
    "p3",
    "s1",
    "s2",
    "m1",
    "m2",
    "f1",
    "f2",
    "c1",
    "c2",
    "c3",
    "c4",
    "k1",
    "u1",
    "u2",
    "r1",
    "w1",
  ];
  for (const name of names) await person(name, name.startsWith("p") ? "prepaid" : "subscription");

  // ===== Phase 1: every flow starts; immediate emails arrive.
  // 1. Prepaid. p1 never downloads; p2 downloads; p3 buys again.
  const p1 = await event("p1", "order_paid", { product: "prepaid", order_number: 1 });
  const p2 = await event("p2", "order_paid", { product: "prepaid", order_number: 1 });
  const p3 = await event("p3", "order_paid", { product: "prepaid", order_number: 1 });
  await event("p2", "download_finished", { source: "app" });
  await event("p3", "download_finished", { source: "app" });
  const p3second = await event("p3", "order_paid", { product: "prepaid", order_number: 2 });
  check(
    p3second.enrollments.started.length === 1 && !startedIn(p3second, prepaid),
    "second prepaid order starts only Second pack (Prepaid onboarding is reentry never)",
  );
  const p3third = await event("p3", "order_paid", { product: "prepaid", order_number: 3 });
  const p3again = await event("p3", "order_paid", { product: "prepaid", order_number: 2 });
  check(
    p3third.enrollments.started.length === 0 && p3again.enrollments.started.length === 0,
    "third order and a repeated order_number 2 start nothing (reentry never)",
  );
  for (const name of ["p1", "p2", "p3"]) await receive(name, "credits");
  const p3secondMail = await receive("p3", "second");
  check(p3secondMail.header("List-Unsubscribe"), "marketing step carries List-Unsubscribe");

  // 2. Subscription. s2 connects; m1 downloaded 10 days ago, m2 40 days ago.
  const s1 = await event("s1", "subscription_created", { price: 79, currency: "USD" });
  const s2 = await event("s2", "subscription_created", { price: 79, currency: "USD" });
  await event("s2", "connected");
  const day = 86_400_000;
  await event("m1", "download_finished", {}, new Date(Date.now() - 10 * day));
  await event("m2", "download_finished", {}, new Date(Date.now() - 40 * day));
  await event("m1", "subscription_monthly_summary", { downloads: 42 });
  const m2 = await event("m2", "subscription_monthly_summary", { downloads: 0 });
  await receive("s1", "welcome");
  await receive("s2", "welcome");
  const month = await receive("m1", "month");
  check(month.body.includes("downloads=42"), "Your month carries the app's totals from event data");

  // 3. Payment failed: f1 pays before step 2; f2 does not.
  const f1 = await event("f1", "subscription_past_due");
  await event("f2", "subscription_past_due");
  await receive("f1", "failed");
  await receive("f2", "failed");
  const paid = await event("f1", "payment_succeeded");
  check(
    paid.enrollments.ended.length === 1 &&
      paid.enrollments.ended[0]!.id === startedIn(f1, payment) &&
      paid.enrollments.ended[0]!.exit_reason === "event:payment_succeeded",
    "payment_succeeded exits the Payment failed enrollment",
  );

  // 4. Cancel and win-back: c1 says "price", c4 another reason, c3 resubscribes, c2 silent.
  for (const name of ["c1", "c2", "c3", "c4"]) await event(name, "subscription_canceled");
  await event("c1", "feedback_given", { reason: "price" });
  await event("c4", "feedback_given", { reason: "too_complex" });
  const resubscribed = await event("c3", "subscription_created");
  check(
    resubscribed.enrollments.ended.some((e) => e.exit_reason === "event:subscription_created") &&
      startedIn(resubscribed, welcome),
    "subscription_created exits the Cancellation sequence and starts Welcome",
  );
  for (const name of ["c1", "c2", "c3", "c4"]) await receive(name, "question");
  await receive("c3", "welcome");

  // 4b. Send-time consent: n1 is created by the event with no list membership. The
  // transactional step goes out; the marketing win-back finds no permission on the list.
  const n1 = await event("n1", "subscription_canceled");
  subscribers.set("n1", n1.subscriber_id);
  check((await membership("n1")) === undefined, "n1 has no membership in the marketing list");
  const n1cancel = startedIn(n1, cancellation)!;
  check(n1cancel, "a subscriber without list permission is still enrolled");
  await receive("n1", "question");

  // 5a. Frequency cap: k1 gets Second pack, then Your month is deferred.
  await event("k1", "order_paid", { product: "gift", order_number: 2 });
  const kSecond = await receive("k1", "second");
  await event("k1", "download_finished");
  const kMonth = startedIn(
    await event("k1", "subscription_monthly_summary", { downloads: 7 }),
    monthly,
  )!;
  check(kMonth, "monthly summary enrolls k1");
  {
    // The step is due now; the scheduler runs it at once and the cap moves due_at.
    const deadline = Date.now() + TICK_MS;
    let current = await enrollment(kMonth);
    while (current.status === "active" && Date.parse(current.due_at) < Date.now() + 30_000) {
      check(Date.now() < deadline, "cap did not defer Your month");
      await Bun.sleep(100);
      current = await enrollment(kMonth);
    }
    check(
      current.status === "active" && Date.parse(current.due_at) >= kSecond.at + CAP_MS - 1000,
      "cap defer: Your month waits until the cap window after Second pack",
    );
    log(`cap defer: Your month for k1 deferred to ${current.due_at}`);
  }

  // 5b. Unsubscribe: u1 by the received link (page, then its form), u2 by RFC 8058 one-click.
  for (const name of ["u1", "u2"]) {
    await event(name, "order_paid", { product: "gift", order_number: 2 });
    await event(name, "subscription_canceled");
    await event(name, "subscription_past_due");
  }
  const u1mail = await receive("u1", "second");
  const u2mail = await receive("u2", "second");
  for (const name of ["u1", "u2"]) {
    await receive(name, "question");
    await receive(name, "failed");
  }
  const link = /<a href="([^"]+\/unsubscribe\/[^"]+)">Unsubscribe<\/a>/.exec(u1mail.body)?.[1];
  check(link, "u1's Second pack has an unsubscribe link");
  const page = await fetch(link!, { signal: AbortSignal.timeout(10_000) });
  check(page.status === 200 && (await page.text()).includes("<form"), "unsubscribe page");
  check((await membership("u1")) === "unconfirmed", "viewing the page changes nothing");
  const form = await fetch(link!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "",
    signal: AbortSignal.timeout(10_000),
  });
  check(form.status === 200, "unsubscribe form post");
  const oneClick = u2mail.header("List-Unsubscribe")?.slice(1, -1);
  check(
    oneClick && u2mail.header("List-Unsubscribe-Post") === "List-Unsubscribe=One-Click",
    "u2's Second pack has the RFC 8058 header pair",
  );
  const posted = await fetch(oneClick!, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    signal: AbortSignal.timeout(10_000),
  });
  check(posted.status === 200, "one-click post");
  for (const name of ["u1", "u2"]) {
    check((await membership(name)) === "unsubscribed", `${name} unsubscribed from the list`);
    const rows = await enrollmentsOf(name);
    const cancel = rows.find((e) => e.sequence_id === cancellation.id);
    const failed = rows.find((e) => e.sequence_id === payment.id);
    check(
      cancel?.status === "exited" && cancel.exit_reason === "unsubscribed",
      `${name}: Cancellation (list-tied) enrollment exited as unsubscribed`,
    );
    check(failed?.status === "active", `${name}: Payment failed (no list) enrollment continues`);
  }
  log("unsubscribe: link form and one-click both exited the list-tied enrollments");

  // 6. Restart. The barrier is a pause through the API, not the 15-second tick: Payment failed
  // is paused before r1's step 2 is due, so that step is due and unsent when the process stops,
  // and w1's Welcome step 2 is still waiting.
  const r1 = startedIn(await event("r1", "subscription_past_due"), payment)!;
  await receive("r1", "failed");
  await ok(`/api/sequences/${payment.id}/status`, "PUT", { status: "paused" });
  let resumedAt: number;
  {
    const waiting = await enrollment(r1);
    const due = Date.parse(waiting.due_at);
    check(due > Date.now(), "Payment failed paused before r1's step 2 is due");
    while (Date.now() <= due + 1000) await Bun.sleep(100);
    const w1 = startedIn(await event("w1", "subscription_created"), welcome)!;
    await receive("w1", "welcome");
    const r1now = await enrollment(r1);
    check(
      r1now.status === "active" &&
        r1now.step_id === waiting.step_id &&
        r1now.due_at === waiting.due_at,
      "r1's step 2 is due and not run while the sequence is paused",
    );
    const w1now = await enrollment(w1);
    check(
      w1now.status === "active" && Date.parse(w1now.due_at) > Date.now(),
      "w1's step 2 is still waiting when the process stops",
    );
    const active = (await ok("/api/enrollments?status=active&per_page=100")).total;
    await production.stop();
    check(
      mail.find(email("r1"), subjects.failed2).length === 0,
      "r1's due step 2 was not sent before the stop",
    );
    log(`stopped with ${active} active enrollments, r1 step 2 due, w1 step 2 waiting`);
    // Down long enough for every 10-second wait to pass.
    await Bun.sleep((WAIT_SECONDS + 2) * 1000);
    await production.start();
    check(
      (await enrollment(r1)).status === "active" &&
        mail.find(email("r1"), subjects.failed2).length === 0,
      "r1's step 2 still unsent after the restart while paused",
    );
    resumedAt = Date.now();
    await ok(`/api/sequences/${payment.id}/status`, "PUT", { status: "active" });
    log("restarted and resumed Payment failed");
  }

  // Waited steps: each arrives once, whether it ran before the stop or after the restart.
  await receive("p1", "hand", 2 * TICK_MS);
  await receive("s1", "setup", 2 * TICK_MS);
  await receive("c3", "setup", 2 * TICK_MS);
  await receive("f2", "failed2", 2 * TICK_MS);
  await receive("c2", "winback", 2 * TICK_MS);
  await receive("c4", "winback", 2 * TICK_MS);
  const r1mail = await receive("r1", "failed2", 2 * TICK_MS);
  check(r1mail.at >= resumedAt, "r1's due step 2 arrived after the restart and resume");
  await receive("w1", "setup", 2 * TICK_MS);
  for (const name of ["u1", "u2"]) await receive(name, "failed2", 2 * TICK_MS);
  const kMonthMail = await receive("k1", "month", 60_000 + 2 * TICK_MS);
  check(
    kMonthMail.at >= kSecond.at + CAP_MS - 1000,
    "deferred Your month arrived after the cap window",
  );

  // Exits by condition (checked through the API), and enrollments that end without mail.
  for (const [name, response, seq] of [
    ["p2", p2, prepaid],
    ["s2", s2, welcome],
  ] as const) {
    const row = await waitForStatus(startedIn(response, seq)!, "exited");
    check(row.exit_reason === "condition", `${name}: on_false exit by condition`);
  }
  check((await waitForStatus(startedIn(p3, prepaid)!, "exited")).exit_reason === "condition", "p3");
  {
    const c1 = (await enrollmentsOf("c1")).find((e) => e.sequence_id === cancellation.id);
    check(c1 && c1.status !== "active", "c1: Cancellation finished without the win-back");
  }
  {
    const row = await waitForEnd(n1cancel);
    check(
      row.status === "exited" && row.exit_reason === "unsubscribed",
      `n1: Cancellation exited as unsubscribed at the marketing step (got ${row.status}/${row.exit_reason})`,
    );
  }
  {
    const row = await waitForStatus(startedIn(m2, monthly)!, "exited");
    check(row.exit_reason === "condition", "m2: no download in 30 days, Your month not sent");
  }
  check(
    (await waitForStatus(startedIn(p1, prepaid)!, "completed")) &&
      (await waitForStatus(startedIn(s1, welcome)!, "completed")),
    "p1 and s1 completed",
  );
  log("phase 1 complete");

  // ===== Phase 2: edit a template and a wait mid-flight, then delete a step.
  // e1 has passed step 1 and waits on step 2; f2 already received step 2.
  for (const name of ["e1", "e4", "d1", "d2"]) await person(name, "subscription");
  const e1 = startedIn(await event("e1", "subscription_past_due"), payment)!;
  await receive("e1", "failed");
  const e1before = await enrollment(e1);
  const d1 = startedIn(await event("d1", "subscription_created"), welcome)!;
  await receive("d1", "welcome");
  const d1before = await enrollment(d1);

  const current = await ok(`/api/sequences/${payment.id}`);
  const edited = await ok(`/api/sequences/${payment.id}`, "PUT", {
    ...current,
    steps: [current.steps[0], { ...current.steps[1], template_id: t.failedFinal, wait: "PT40S" }],
  });
  check(edited.steps[1].id === current.steps[1].id, "the edited step keeps its ID");
  const welcomeNow = await ok(`/api/sequences/${welcome.id}`);
  const withoutSetup = await ok(`/api/sequences/${welcome.id}`, "PUT", {
    ...welcomeNow,
    steps: [welcomeNow.steps[0], tx("tips", TIPS_WAIT)],
  });
  check(withoutSetup.steps.length === 2, "Did the setup work? deleted, Tips added");
  const e1after = await enrollment(e1);
  check(e1after.due_at === e1before.due_at, "an already scheduled due_at is kept after the edit");
  log("edited Payment failed step 2 (template, PT10S → PT40S) and deleted Did the setup work?");

  const e4 = startedIn(await event("e4", "subscription_past_due"), payment)!;
  await receive("e4", "failed");
  const e4waiting = await enrollment(e4);
  const d2 = startedIn(await event("d2", "subscription_created"), welcome)!;
  await receive("d2", "welcome");
  const d2waiting = await enrollment(d2);

  // e1 gets the new template at its old due time; e4 waits the new 40 seconds.
  const e1mail = await receive("e1", "failedFinal", 2 * TICK_MS);
  check(
    e1mail.at < Date.parse(e1before.due_at) + TICK_MS,
    "e1's step 2 ran at its kept due time, not after the new wait",
  );
  check(
    Date.parse(e4waiting.due_at) - Date.parse(e4waiting.updated_at) >= 39_000,
    "e4's step 2 is scheduled with the new 40-second wait",
  );
  // d1 waited on the deleted step: it gets Tips at the deleted step's due time, without waiting
  // Tips' 40 seconds again. d2 reaches Tips normally and waits its full 40 seconds.
  const d1tips = await receive("d1", "tips", 2 * TICK_MS);
  check(
    d1tips.at < Date.parse(d1before.due_at) + TICK_MS,
    "d1 skipped the deleted step without waiting again",
  );
  check(
    Date.parse(d2waiting.due_at) - Date.parse(d2waiting.updated_at) >= TIPS_WAIT_MS - 1000,
    "d2's Tips is scheduled with its full 40-second wait",
  );
  const d2tips = await receive("d2", "tips", TIPS_WAIT_MS + 2 * TICK_MS);
  check(d2tips.at >= Date.parse(d2waiting.due_at), "d2's Tips not before its full wait");
  const e4mail = await receive("e4", "failedFinal", 40_000 + 2 * TICK_MS);
  check(e4mail.at >= Date.parse(e4waiting.due_at), "e4's step 2 not before its new due time");
  for (const id of [e1, e4, d1, d2]) await waitForStatus(id, "completed");
  log("phase 2 complete: edits applied only to steps not yet reached");

  // ===== Final: nothing else arrived, nothing twice, no errors logged.
  await Bun.sleep(TICK_MS);
  const counts = new Map<string, number>();
  for (const m of mail.mails)
    counts.set(`${m.to}|${m.subject}`, (counts.get(`${m.to}|${m.subject}`) ?? 0) + 1);
  const unexpected = [...counts.keys()].filter(
    (k) => !expected.some(([to, subject]) => `${to}|${subject}` === k),
  );
  check(unexpected.length === 0, `unexpected mail: ${unexpected.join(", ")}`);
  check(
    [...counts.values()].every((n) => n === 1) && mail.mails.length === expected.length,
    "every expected email arrived exactly once",
  );
  for (const [to, subject] of [
    [email("p2"), subjects.hand],
    [email("p3"), subjects.hand],
    [email("s2"), subjects.setup],
    [email("m2"), subjects.month],
    [email("f1"), subjects.failed2],
    [email("c1"), subjects.winback],
    [email("n1"), subjects.winback],
    [email("c3"), subjects.winback],
    [email("u1"), subjects.winback],
    [email("u2"), subjects.winback],
    [email("e1"), subjects.failed2],
    [email("d1"), subjects.setup],
    [email("d2"), subjects.setup],
  ] as const)
    check(mail.find(to, subject).length === 0, `no "${subject}" for ${to}`);
  check(production.errors() === "", `production logged: ${production.errors()}`);
}
