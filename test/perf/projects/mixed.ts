// B141 measurement (docs/perf/projects-B141.md): three projects sending at once at
// messaging.max_send_rate 14, against any compiled executable with the instance settings API (B139
// on), through HTTP and a loopback SMTP sink only.
//
// Usage: bun test/perf/projects/mixed.ts <executable> <label> [seconds=30] [b=marketing|campaign]
//
// Project `a` runs a campaign to 2,000 readers, project `b` queues 600 async marketing sends (or,
// with `campaign`, runs a campaign to 600 readers of its own, for the share between two campaigns), and
// the primary project makes one synchronous transactional call every 500 ms. Once all three are
// under way, the window is `seconds` long. Transactional start latency is from the call to the
// sink's receipt of that message, found by its subject (p50, p99), so it includes the SMTP hand-off
// to a loopback sink; each project's share is its part of the receipts in the window. One JSON line
// per run goes to stdout.
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRealClock } from "@/clock";
import { logIn, registerProjects, request, sessionHeaders } from "@/test/projects/fixture";
import type { Session } from "@/test/projects/fixture";
import { readJson } from "@/test/read-body";
import { portZeroRootUrl, readyOnPortZero, stopChild } from "@/test/serve-port";
import { instanceClient } from "@/test/settings/instance-client";
import { startSink } from "@/test/tx/sink";

const executable = resolve(process.argv[2] ?? "dist/iglo.email");
const label = process.argv[3] ?? "run";
const seconds = Number(process.argv[4] ?? 30);
const mode = process.argv[5] === "campaign" ? "campaign" : "marketing";
const scratch = resolve(
  process.env.MEASURE_DIR ?? join(process.env.HOME ?? "/tmp", "scratch-b141"),
);
const admin = { user: "measure-admin", password: "measure-admin-password" };
const PRIMARY = "127.0.0.1";
const A = "a.measure.test";
const B = "b.measure.test";

const sink = await startSink({ clock: createRealClock() });
const dataDir = mkdtempSync(join(scratch, "mixed-"));
registerProjects(dataDir, [
  { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
  { slug: "a", name: "A", hostname: A },
  { slug: "b", name: "B", hostname: B },
]);
const child = Bun.spawn(
  [executable, "--port", "0", "--root-url", portZeroRootUrl, "--data-dir", dataDir],
  {
    env: {
      PATH: "",
      IGLO_EMAIL_ADMIN_USER: admin.user,
      IGLO_EMAIL_ADMIN_PASSWORD: admin.password,
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);

async function data<T>(response: Response, what: string): Promise<T> {
  if (response.status !== 200) {
    throw new Error(`${what}: ${response.status} ${await response.text()}`);
  }
  return (await readJson<{ data: T }>(response)).data;
}

try {
  const { port } = await readyOnPortZero(child);
  const call = (host: string, session: Session, path: string, method = "GET", body?: unknown) =>
    request(port, host, path, {
      method,
      headers: sessionHeaders(session),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const instance = await instanceClient(`http://127.0.0.1:${port}`, admin);
  await instance.useSink(sink.port, { max_conns: 10 });
  await instance.put("messaging.max_send_rate", 14);

  /** A list of `count` confirmed readers named `<tag>-<n>@measure.test` in the project on `host`. */
  async function audience(host: string, session: Session, tag: string, count: number) {
    const list = await data<{ id: number }>(
      await call(host, session, "/api/lists", "POST", {
        name: tag,
        type: "public",
        optin: "single",
      }),
      "list",
    );
    const emails = Array.from({ length: count }, (_, i) => `${tag}-${i}@measure.test`);
    for (let start = 0; start < count; start += 50) {
      await Promise.all(
        emails.slice(start, start + 50).map(async (email) =>
          data(
            await call(host, session, "/api/subscribers", "POST", {
              email,
              name: "Reader",
              lists: [list.id],
              preconfirm_subscriptions: true,
            }),
            "subscriber",
          ),
        ),
      );
    }
    return { list: list.id, emails };
  }
  const txTemplate = async (host: string, session: Session) => {
    const templates = await data<Array<{ id: number; type: string }>>(
      await call(host, session, "/api/templates"),
      "templates",
    );
    return templates.find((template) => template.type === "tx")?.id;
  };

  const sessions = {
    main: await logIn(port, PRIMARY, admin),
    a: await logIn(port, A, admin),
    b: await logIn(port, B, admin),
  };
  const campaignAudience = await audience(A, sessions.a, "a", 2000);
  const marketingAudience = await audience(B, sessions.b, "b", 600);
  const person = await audience(PRIMARY, sessions.main, "t", 1);
  const mainTemplate = await txTemplate(PRIMARY, sessions.main);
  const bTemplate = await txTemplate(B, sessions.b);

  /** A running plain campaign to `list` in the project on `host`. */
  async function campaign(host: string, session: Session, list: number) {
    const created = await data<{ id: number }>(
      await call(host, session, "/api/campaigns", "POST", {
        name: "Mixed",
        subject: "Mixed",
        lists: [list],
        from_email: "Measure <measure@measure.test>",
        content_type: "plain",
        type: "regular",
        messenger: "email",
        body: "Hello",
      }),
      "campaign",
    );
    await data(
      await call(host, session, `/api/campaigns/${created.id}/status`, "PUT", {
        status: "running",
      }),
      "campaign start",
    );
  }
  // Project a: a campaign to its 2,000 readers.
  await campaign(A, sessions.a, campaignAudience.list);
  if (mode === "campaign") {
    // Project b: a campaign of its own.
    await campaign(B, sessions.b, marketingAudience.list);
  } else {
    // Project b: 600 async marketing sends, 100 recipients a call.
    for (let start = 0; start < 600; start += 100) {
      await data(
        await call(B, sessions.b, "/api/tx", "POST", {
          subscriber_emails: marketingAudience.emails.slice(start, start + 100),
          template_id: bTemplate,
          kind: "marketing",
          list_id: marketingAudience.list,
          async: true,
        }),
        "marketing",
      );
    }
  }

  async function transactional(subject: string, n: number) {
    const response = await call(PRIMARY, sessions.main, "/api/tx", "POST", {
      subscriber_emails: person.emails,
      template_id: mainTemplate,
      subject,
      data: { n },
    });
    await data(response, "transactional");
  }
  // The primary: a synchronous transactional call every 500 ms through the window.
  const windowStart = Date.now();
  const windowEnd = windowStart + seconds * 1000;
  const asked = new Map<string, number>();
  /** One call every 500 ms until the window ends, each answered before this resolves. */
  async function calls() {
    const pending: Array<Promise<void>> = [];
    for (let n = 0; Date.now() < windowEnd; n++) {
      const subject = `t-call-${n}`;
      asked.set(subject, Date.now());
      pending.push(transactional(subject, n));
      await Bun.sleep(500);
    }
    await Promise.all(pending);
  }
  await calls();
  const inWindow = sink.messages.filter(
    (message) => (message.at ?? 0) >= windowStart && (message.at ?? 0) < windowEnd,
  );
  const share = (tag: string) =>
    inWindow.filter((message) => (message.to[0] ?? "").startsWith(`${tag}-`)).length;
  const latencies: Array<number> = [];
  for (const message of sink.messages) {
    const subject = /^Subject: (t-call-\d+)\r?$/m.exec(message.data)?.[1];
    const at = subject === undefined ? undefined : asked.get(subject);
    if (at !== undefined) {
      latencies.push((message.at ?? at) - at);
    }
  }
  latencies.sort((x, y) => x - y);
  const quantile = (q: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;
  process.stdout.write(
    `${JSON.stringify({
      label,
      mode,
      seconds,
      transactional: latencies.length,
      p50: quantile(0.5),
      p99: quantile(0.99),
      receipts: inWindow.length,
      perSecond: +(inWindow.length / seconds).toFixed(1),
      share: { main: share("t"), a: share("a"), b: share("b") },
    })}\n`,
  );
} finally {
  await stopChild(child, "SIGTERM", 10_000);
  await sink.close();
  rmSync(dataDir, { recursive: true, force: true });
}
