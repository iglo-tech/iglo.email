// B139 (14-projects sections 4 and 15, D154): the settings split, through the compiled executable
// with three projects: the primary on the instance host (127.0.0.1), `a` and `b` on their own
// hostnames. A project host serves its project keys only; the instance keys are stored once in
// instance.db and served on the instance host's /api/instance/settings with the instance session.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { defaults } from "@/settings/defaults";
import { instanceKeys, projectKeys } from "@/settings/keys";
import { instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  api,
  createApiUser,
  logIn,
  prepareExecutable,
  registerProjects,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials } from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(30_000);

const PRIMARY = "127.0.0.1";
const A = "a.example.test";
const B = "b.example.test";

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let first: Awaited<ReturnType<typeof startSink>>;
let second: Awaited<ReturnType<typeof startSink>>;
let admin: Credentials;
let dataDir = "";
let port = 0;
let operator: InstanceSession;
const keys = new Map<string, string>();
const key = (host: string) => keys.get(host) ?? "";
const parse = <T>(text: string) => asBody<T>(JSON.parse(text));

/** The instance keys as the instance host serves them. */
async function instanceSettings(): Promise<Record<string, any>> {
  const response = await instanceCall(port, PRIMARY, operator, "GET", "/api/instance/settings");
  expect(response.status).toBe(200);
  return (await readJson<{ data: Record<string, any> }>(response)).data;
}

/** A project's settings, as its own host serves them to its API user. */
async function projectSettings(host: string): Promise<Record<string, any>> {
  const response = await api(port, host, key(host), "GET", "/api/settings");
  expect(response.status).toBe(200);
  return parse<{ data: Record<string, any> }>(response.text).data;
}

/** The first SMTP server pointed at `port` without TLS or login. */
const smtpAt = (current: Record<string, any>, sinkPort: number) => [
  {
    ...asBody<Record<string, unknown>>(current.smtp[0]),
    enabled: true,
    host: "127.0.0.1",
    port: sinkPort,
    auth_protocol: "none",
    username: "",
    password: "",
    tls_type: "none",
    email_headers: [],
  },
];

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  first = await startSink();
  second = await startSink();
  dataDir = join(prepared.directory, "data");
  registerProjects(dataDir, [
    { slug: "main", name: "Main", hostname: PRIMARY, primary: true },
    { slug: "a", name: "A", hostname: A },
    { slug: "b", name: "B", hostname: B },
  ]);
  server = await startInstance(prepared.executable, dataDir, admin);
  port = server.port;
  for (const [host, name] of [
    [PRIMARY, "main"],
    [A, "a"],
    [B, "b"],
  ] as const) {
    keys.set(host, await createApiUser(port, host, await logIn(port, host, admin), `api-${name}`));
  }
  const signedIn = await instanceLogin(port, PRIMARY, admin);
  operator = signedIn.session!;
});

afterAll(async () => {
  if (server) {
    await server.stop();
  }
  await first?.close();
  await second?.close();
  await prepared?.cleanup();
});

test("every default key is one side's, and the two APIs serve the two sides", async () => {
  const all = Object.keys(defaults);
  expect(all.filter((name) => instanceKeys.has(name) === projectKeys.has(name))).toEqual([]);
  const shared = Object.keys(await instanceSettings());
  for (const host of [PRIMARY, A, B]) {
    const own = Object.keys(await projectSettings(host));
    expect(own.filter((name) => instanceKeys.has(name))).toEqual([]);
    expect(own.toSorted()).toEqual([...projectKeys, "app.root_url"].toSorted());
  }
  // The S3 secret is left out while it is empty, as the one settings API left it out (upstream).
  expect(shared.toSorted()).toEqual(
    [...instanceKeys].filter((name) => name !== "upload.s3.aws_secret_access_key").toSorted(),
  );
});

test("a project database holds no instance key", () => {
  for (const slug of ["main", "a", "b"]) {
    const db = new Database(join(dataDir, "projects", slug, "iglo-email.db"), { readonly: true });
    try {
      const stored = asBody<Array<{ key: string }>>(db.query("SELECT key FROM settings").all());
      expect(stored.filter((row) => instanceKeys.has(row.key))).toEqual([]);
      expect(stored.some((row) => row.key === "app.site_name")).toBe(true);
    } finally {
      db.close();
    }
  }
});

test("an instance key in a project PUT is a 400 that names it, and nothing is written", async () => {
  const before = await projectSettings(A);
  const shared = await instanceSettings();
  for (const [name, value] of [
    ["smtp", smtpAt(shared, first.port)],
    ["messaging.max_send_rate", 3],
    ["app.check_updates", false],
    ["ses.api_region", "eu-west-1"],
    ["security.session_duration", "1h"],
  ] as const) {
    const full = await api(port, A, key(A), "PUT", "/api/settings", {
      ...before,
      "app.site_name": "should not be written",
      [name]: value,
    });
    expect({ name, status: full.status }).toEqual({ name, status: 400 });
    expect(parse<{ message: string }>(full.text).message).toContain(name);
    const one = await api(port, A, key(A), "PUT", `/api/settings/${name}`, value);
    expect({ name, status: one.status }).toEqual({ name, status: 400 });
    expect(parse<{ message: string }>(one.text).message).toContain(name);
  }
  // A key that is no setting at all is refused the same way.
  const unknown = await api(port, A, key(A), "PUT", "/api/settings", { ...before, nope: 1 });
  expect(unknown.status).toBe(400);
  expect(parse<{ message: string }>(unknown.text).message).toContain("nope");
  expect(await projectSettings(A)).toEqual(before);
  expect(await instanceSettings()).toEqual(shared);
  // The project's own keys still save, the read-only root URL coming back ignored.
  const saved = await api(port, A, key(A), "PUT", "/api/settings", {
    ...before,
    "app.site_name": "Project A",
  });
  expect(saved.status).toBe(200);
  expect((await projectSettings(A))["app.site_name"]).toBe("Project A");
  expect((await projectSettings(B))["app.site_name"]).not.toBe("Project A");
});

test("a removed campaign pacing key is a 400 that names it on either side, and nothing is written", async () => {
  // B141 (D155): the dispatcher paces every send, so listmonk's per-campaign pacing keys are gone.
  const before = await projectSettings(A);
  const shared = await instanceSettings();
  for (const [name, value] of [
    ["app.concurrency", 1],
    ["app.message_rate", 2],
    ["app.batch_size", 100],
    ["app.message_sliding_window", true],
    ["app.message_sliding_window_duration", "1h"],
    ["app.message_sliding_window_rate", 10],
  ] as const) {
    expect(name in before).toBe(false);
    expect(name in shared).toBe(false);
    const full = await api(port, A, key(A), "PUT", "/api/settings", { ...before, [name]: value });
    expect({ name, status: full.status }).toEqual({ name, status: 400 });
    expect(parse<{ message: string }>(full.text).message).toContain(name);
    const one = await api(port, A, key(A), "PUT", `/api/settings/${name}`, value);
    expect({ name, status: one.status }).toEqual({ name, status: 400 });
    expect(parse<{ message: string }>(one.text).message).toContain(name);
    const instance = await instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/settings", {
      ...shared,
      [name]: value,
    });
    expect({ name, status: instance.status }).toEqual({ name, status: 400 });
    expect(parse<{ message: string }>(await instance.text()).message).toContain(name);
  }
  expect(await projectSettings(A)).toEqual(before);
  expect(await instanceSettings()).toEqual(shared);
});

test("the instance settings API takes the instance session and CSRF, never an API credential", async () => {
  for (const host of [PRIMARY, A]) {
    const credential = await api(port, PRIMARY, key(host), "GET", "/api/instance/settings");
    expect(credential.status).toBe(401);
  }
  expect((await request(port, PRIMARY, "/api/instance/settings")).status).toBe(401);
  // A credential is refused even beside a valid instance session and its CSRF token.
  for (const [method, body] of [
    ["GET", undefined],
    ["PUT", "4"],
  ] as const) {
    const both = await request(
      port,
      PRIMARY,
      `/api/instance/settings${body ? "/messaging.max_send_rate" : ""}`,
      {
        method,
        headers: {
          authorization: key(PRIMARY),
          cookie: operator.cookie,
          "x-csrf-token": operator.csrf,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body }),
      },
    );
    expect({ method, status: both.status }).toEqual({ method, status: 401 });
  }
  // A project session is not an instance session.
  const project = await logIn(port, PRIMARY, admin);
  const withProject = await request(port, PRIMARY, "/api/instance/settings", {
    headers: sessionHeaders(project),
  });
  expect(withProject.status).toBe(401);
  // A change needs the CSRF token.
  const noCsrf = await request(port, PRIMARY, "/api/instance/settings/messaging.max_send_rate", {
    method: "PUT",
    headers: { cookie: operator.cookie, "content-type": "application/json" },
    body: "4",
  });
  expect(noCsrf.status).toBe(403);
  expect((await instanceSettings())["messaging.max_send_rate"]).toBe(
    defaults["messaging.max_send_rate"],
  );
  // A project's host does not serve the instance routes: they are that project's paths.
  const onProject = await instanceCall(port, A, operator, "GET", "/api/instance/settings");
  expect(onProject.status).toBe(404);
  // A project key on the instance API is refused, naming it.
  const projectKey = await instanceCall(
    port,
    PRIMARY,
    operator,
    "PUT",
    "/api/instance/settings/app.site_name",
    "x",
  );
  expect(projectKey.status).toBe(400);
  expect(await projectKey.text()).toContain("app.site_name");
});

/** Subscribes `email` to a new double opt-in list on `host`, which mails the opt-in at once. */
const optin = async (host: string, email: string) => {
  const list = parse<{ data: { id: number } }>(
    (
      await api(port, host, key(host), "POST", "/api/lists", {
        name: `optin-${email}`,
        type: "public",
        optin: "double",
      })
    ).text,
  );
  const created = await api(port, host, key(host), "POST", "/api/subscribers", {
    email,
    name: email,
    status: "enabled",
    lists: [list.data.id],
  });
  expect(created.status).toBe(200);
};
const arrived = (sink: typeof first, email: string) =>
  untilState(() => sink.messages.some((message) => message.to.includes(email)), {
    label: `the opt-in mail to ${email}`,
    progress: () => String(sink.messages.length),
    stallMs: 15_000,
  });
const pointSmtpAt = async (sinkPort: number) => {
  const saved = await instanceCall(
    port,
    PRIMARY,
    operator,
    "PUT",
    "/api/instance/settings/smtp",
    smtpAt(await instanceSettings(), sinkPort),
  );
  expect(saved.status).toBe(200);
};

test("the admin's SMTP change is the one every project sends through", async () => {
  await pointSmtpAt(first.port);
  await optin(A, "one@a.example.test");
  await optin(B, "one@b.example.test");
  await arrived(first, "one@a.example.test");
  await arrived(first, "one@b.example.test");
  // One change on the instance moves both projects, with no restart.
  await pointSmtpAt(second.port);
  await optin(A, "two@a.example.test");
  await optin(B, "two@b.example.test");
  await arrived(second, "two@a.example.test");
  await arrived(second, "two@b.example.test");
  expect(first.messages.some((message) => message.to.includes("two@a.example.test"))).toBe(false);
  expect(first.messages.some((message) => message.to.includes("two@b.example.test"))).toBe(false);
});

/** One instance key, written with the instance session. */
const putInstance = (name: string, value: unknown) =>
  instanceCall(port, PRIMARY, operator, "PUT", `/api/instance/settings/${name}`, value);
/** The SES secret as `instance.db` holds it, unmasked. */
const storedSecret = (): unknown => {
  const instanceDb = new Database(join(dataDir, "instance.db"), { readonly: true });
  try {
    const row = asBody<{ value: string } | null>(
      instanceDb.query("SELECT value FROM settings WHERE key = 'ses.api_secret_access_key'").get(),
    );
    return JSON.parse(row?.value ?? "null");
  } finally {
    instanceDb.close();
  }
};

test("the SES API keys are checked, stored and masked, and the secret round-trips", async () => {
  const full = async (change: Record<string, unknown>) =>
    instanceCall(port, PRIMARY, operator, "PUT", "/api/instance/settings", {
      ...(await instanceSettings()),
      ...change,
    });
  const before = await instanceSettings();
  expect([
    before["ses.api_region"],
    before["ses.api_access_key_id"],
    before["ses.api_secret_access_key"],
  ]).toEqual(["", "", ""]);
  for (const [change, message] of [
    [{ "ses.api_region": "Europe West" }, "ses.api_region"],
    [{ "ses.api_access_key_id": "not-a-key" }, "ses.api_access_key_id"],
    [
      {
        "ses.api_region": "eu-west-1",
        "ses.api_access_key_id": "AKIAABCDEFGHIJKLMNOP",
        "ses.api_secret_access_key": "short",
      },
      "ses.api_secret_access_key",
    ],
    [{ "ses.api_region": "eu-west-1" }, "together"],
    [
      { "ses.api_region": "eu-west-1", "ses.api_access_key_id": "AKIAABCDEFGHIJKLMNOP" },
      "together",
    ],
  ] as const) {
    const refused = await full(change);
    expect({ change, status: refused.status }).toEqual({ change, status: 400 });
    expect(await refused.text()).toContain(message);
  }
  expect(await instanceSettings()).toEqual(before);
  const secret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  const saved = await full({
    "ses.api_region": "eu-west-1",
    "ses.api_access_key_id": "AKIAABCDEFGHIJKLMNOP",
    "ses.api_secret_access_key": secret,
  });
  expect(saved.status).toBe(200);
  const stored = await instanceSettings();
  expect(stored["ses.api_region"]).toBe("eu-west-1");
  expect(stored["ses.api_access_key_id"]).toBe("AKIAABCDEFGHIJKLMNOP");
  expect(stored["ses.api_secret_access_key"]).toBe("•".repeat(secret.length));
  expect(JSON.stringify(stored)).not.toContain(secret);
  // GET then PUT unchanged (the masked secret sent back as served) keeps the stored secret.
  const roundTrip = await instanceCall(
    port,
    PRIMARY,
    operator,
    "PUT",
    "/api/instance/settings",
    await instanceSettings(),
  );
  expect({ status: roundTrip.status, body: await roundTrip.text() }).toMatchObject({ status: 200 });
  expect(storedSecret()).toBe(secret);
  // Only a value made entirely of the mask means "keep": a secret that mixes it with other
  // characters is a new value, refused by the format check, and the stored secret stays (B149d).
  for (const mixed of ["••••newSecretValue1234567890", " •••• ", `${secret}•`]) {
    const refused = await full({ "ses.api_secret_access_key": mixed });
    expect({ mixed, status: refused.status }).toEqual({ mixed, status: 400 });
    expect(await refused.text()).toContain("ses.api_secret_access_key");
    expect(storedSecret()).toBe(secret);
  }
  // A save with the secret blank keeps it; the page sends a masked one back blank.
  expect((await full({ "ses.api_secret_access_key": "" })).status).toBe(200);
  expect((await putInstance("ses.api_region", "us-east-2")).status).toBe(200);
  expect((await instanceSettings())["ses.api_secret_access_key"]).toBe("•".repeat(secret.length));
  // Clearing the key ID alone clears the account: the secret and the stored region with it
  // (B149d, D167). A save that clears the key while it sets another region is still refused.
  const changedRegion = await full({
    "ses.api_region": "eu-central-1",
    "ses.api_access_key_id": "",
  });
  expect(changedRegion.status).toBe(400);
  expect(await changedRegion.text()).toContain("together");
  expect((await instanceSettings())["ses.api_region"]).toBe("us-east-2");
  expect((await putInstance("ses.api_access_key_id", "")).status).toBe(200);
  const cleared = await instanceSettings();
  expect([
    cleared["ses.api_region"],
    cleared["ses.api_access_key_id"],
    cleared["ses.api_secret_access_key"],
  ]).toEqual(["", "", ""]);
  expect(storedSecret()).toBe("");
  // So does a full save that blanks all three.
  expect(
    (
      await full({
        "ses.api_region": "eu-west-1",
        "ses.api_access_key_id": "AKIAABCDEFGHIJKLMNOP",
        "ses.api_secret_access_key": secret,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await full({
        "ses.api_region": "",
        "ses.api_access_key_id": "",
        "ses.api_secret_access_key": "",
      })
    ).status,
  ).toBe(200);
  expect((await instanceSettings())["ses.api_secret_access_key"]).toBe("");
  // No project sees them.
  expect(Object.keys(await projectSettings(A)).some((name) => name.startsWith("ses."))).toBe(false);
});

test("the instance Settings page needs the instance session; a project's page links to it", async () => {
  const anonymous = await request(port, PRIMARY, "/admin/instance/settings");
  expect(anonymous.status).toBe(307);
  expect(anonymous.headers.get("location")).toStartWith("/admin/instance/login?");
  const page = await request(port, PRIMARY, "/admin/instance/settings", {
    headers: { cookie: operator.cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-testid="settings-instance"');
  expect(html).toContain('name="messaging.max_send_rate"');
  expect(html).not.toContain('name="app.from_email"');
  const session = await logIn(port, A, admin);
  const project = await (
    await request(port, A, "/admin/settings", { headers: { cookie: session.cookie } })
  ).text();
  expect(project).toContain('data-testid="settings-project"');
  expect(project).toContain('href="http://127.0.0.1/admin/instance/settings"');
  expect(project).not.toContain("messaging.max_send_rate");
  expect(project).not.toContain("form.smtp");
});
