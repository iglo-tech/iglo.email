// B143a (14-projects sections 10, 13 and 15 "Lifecycle", D157): projects created, edited and
// deleted while the compiled executable runs, through /api/instance/projects with the instance
// session, and the Projects and Logs pages. The primary project is the fresh install's `main` on the
// instance host (127.0.0.1); every other project names its host in an explicit Host header.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handoff, instanceCall, instanceLogin } from "@/test/projects/admin-fixture";
import type { InstanceSession } from "@/test/projects/admin-fixture";
import {
  adminCredentials,
  createApiUser,
  logIn,
  prepareExecutable,
  request,
  sessionHeaders,
  startInstance,
} from "@/test/projects/fixture";
import type { Credentials, Session } from "@/test/projects/fixture";
import { asBody, readJson } from "@/test/read-body";
import { startSink } from "@/test/tx/sink";
import { untilState } from "@/test/wait";

setDefaultTimeout(60_000);

const PRIMARY = "127.0.0.1";

let prepared: Awaited<ReturnType<typeof prepareExecutable>>;
let server: Awaited<ReturnType<typeof startInstance>>;
let sink: Awaited<ReturnType<typeof startSink>>;
let admin: Credentials;
let dataDir = "";
let port = 0;
let operator: InstanceSession;

interface ProjectJson {
  slug: string;
  name: string;
  primary: boolean;
  hostname: string;
  extra: Array<string>;
  created_at: string;
  root_url?: string;
  queued_marketing?: number;
  running_campaigns?: number;
  sent_24h?: number | null;
  delete_error?: string | null;
}

const call = (method: string, path: string, body?: unknown) =>
  instanceCall(port, PRIMARY, operator, method, path, body);

async function createProject(body: Record<string, unknown>): Promise<ProjectJson> {
  const response = await call("POST", "/api/instance/projects", body);
  const text = await response.text();
  expect({ status: response.status, text }).toMatchObject({ status: 200 });
  return asBody<{ data: ProjectJson }>(JSON.parse(text)).data;
}

async function listProjects(): Promise<Array<ProjectJson>> {
  const response = await call("GET", "/api/instance/projects");
  expect(response.status).toBe(200);
  return (await readJson<{ data: Array<ProjectJson> }>(response)).data;
}

/** A project-session JSON call on `host`. */
async function projectCall(
  host: string,
  session: Session,
  method: string,
  path: string,
  body?: unknown,
) {
  const response = await request(port, host, path, {
    method,
    headers: sessionHeaders(session),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: () => asBody<Record<string, any>>(JSON.parse(text)),
  };
}

/** A list, a subscriber on it and a campaign to it, in the project on `host`. */
async function campaignFixture(host: string, session: Session, email: string) {
  const list = await projectCall(host, session, "POST", "/api/lists", {
    name: `list-${email}`,
    type: "private",
    optin: "single",
  });
  expect(list.status).toBe(200);
  const listId = asBody<number>(list.json().data.id);
  const subscriber = await projectCall(host, session, "POST", "/api/subscribers", {
    email,
    name: email,
    status: "enabled",
    lists: [listId],
    preconfirm_subscriptions: true,
  });
  expect(subscriber.status).toBe(200);
  const campaign = await projectCall(host, session, "POST", "/api/campaigns", {
    name: `campaign-${email}`,
    subject: "Hello",
    lists: [listId],
    content_type: "html",
    body: '<p>Hi <a href="{{ unsubscribe_url }}">unsubscribe</a></p>',
  });
  expect(campaign.status).toBe(200);
  return {
    listId,
    subscriber: asBody<{ id: number; uuid: string }>(subscriber.json().data),
    campaign: asBody<{ id: number; uuid: string }>(campaign.json().data),
  };
}

/** The first SMTP server pointed at the sink, without TLS or login. */
async function pointSmtpAtSink() {
  const current = await call("GET", "/api/instance/settings");
  const settings = (await readJson<{ data: Record<string, any> }>(current)).data;
  const saved = await call("PUT", "/api/instance/settings/smtp", [
    {
      ...asBody<Record<string, unknown>>(settings.smtp[0]),
      enabled: true,
      host: "127.0.0.1",
      port: sink.port,
      auth_protocol: "none",
      username: "",
      password: "",
      tls_type: "none",
      email_headers: [],
    },
  ]);
  expect(saved.status).toBe(200);
}

beforeAll(async () => {
  admin = await adminCredentials();
  prepared = await prepareExecutable();
  sink = await startSink();
  dataDir = join(prepared.directory, "data");
  server = await startInstance(prepared.executable, dataDir, admin);
  port = server.port;
  operator = (await instanceLogin(port, PRIMARY, admin)).session!;
  await pointSmtpAtSink();
});

afterAll(async () => {
  if (server) {
    await server.stop();
  }
  await sink?.close();
  await prepared?.cleanup();
});

test("a project created while running is served at once and sends a test from its own host", async () => {
  const created = await createProject({
    slug: "news",
    name: "  News  ",
    hostname: "News.Example.Test",
    extra: ["old.example.test"],
  });
  expect(created).toMatchObject({
    slug: "news",
    name: "News",
    primary: false,
    hostname: "news.example.test",
    extra: ["old.example.test"],
  });
  expect(existsSync(join(dataDir, "projects", "news", "iglo-email.db"))).toBe(true);
  expect((await listProjects()).find((project) => project.slug === "news")).toEqual({
    ...created,
    created_at: expect.any(String),
    root_url: "http://news.example.test",
    queued_marketing: 0,
    running_campaigns: 0,
    sent_24h: 0,
    delete_error: null,
  });

  // The admin's copy exists in it: the handoff opens it, and the admin's password logs in there.
  const { project: session } = await handoff(port, PRIMARY, operator, "news");
  expect(session).toBeDefined();
  await logIn(port, "news.example.test", admin);
  const settings = await projectCall("news.example.test", session!, "GET", "/api/settings");
  expect(settings.json().data["app.root_url"]).toBe("http://news.example.test");
  // Seeded as a fresh install: its default templates.
  const templates = await projectCall("news.example.test", session!, "GET", "/api/templates");
  expect(asBody<Array<unknown>>(templates.json().data).length).toBeGreaterThan(0);

  const { listId, campaign } = await campaignFixture(
    "news.example.test",
    session!,
    "reader@news.example.test",
  );
  const tested = await projectCall(
    "news.example.test",
    session!,
    "POST",
    `/api/campaigns/${campaign.id}/test`,
    {
      name: "Weekly",
      subject: "Test from news",
      lists: [listId],
      messenger: "email",
      content_type: "html",
      body: '<p><a href="{{ unsubscribe_url }}">u</a></p>',
      subscribers: ["reader@news.example.test"],
    },
  );
  expect(tested.status).toBe(200);
  await untilState(
    () => sink.messages.some((message) => message.to.includes("reader@news.example.test")),
    { label: "the test send from news", progress: () => String(sink.messages.length) },
  );
  const mail = sink.messages.find((message) => message.to.includes("reader@news.example.test"))!;
  expect(mail.data).toContain("http://news.example.test/subscription/");
  expect(mail.data).not.toContain("http://127.0.0.1/subscription/");

  // The primary does not know the new project's session: they are two databases.
  const onPrimary = await projectCall(PRIMARY, session!, "GET", "/api/settings");
  expect([401, 403]).toContain(onPrimary.status);
});

test("the Projects page lists every project and the switcher opens each through the handoff", async () => {
  const page = await request(port, PRIMARY, "/admin/instance/projects", {
    headers: { cookie: operator.cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-slug="main"');
  expect(html).toContain('data-slug="news"');
  expect(html).toContain("news.example.test");
  expect(html).toContain('href="/admin/instance/open/news?next=%2Fadmin"');
  // Without the instance session the page goes to the login.
  const anonymous = await request(port, PRIMARY, "/admin/instance/projects");
  expect(anonymous.status).toBe(307);
  // `/admin/instance` is the Projects page.
  const root = await request(port, PRIMARY, "/admin/instance", {
    headers: { cookie: operator.cookie },
  });
  expect(root.headers.get("location")).toBe("/admin/instance/projects");

  // A project page names its project and lists every project, each through the handoff.
  const { project } = await handoff(port, PRIMARY, operator, "news");
  const dashboard = await request(port, "news.example.test", "/admin", {
    headers: { cookie: project!.cookie },
  });
  expect(dashboard.status).toBe(200);
  const shell = await dashboard.text();
  expect(shell).toContain('data-testid="project-switcher"');
  expect(shell).toMatch(/data-testid="project-name">News</);
  expect(shell).toContain('href="http://127.0.0.1/admin/instance/open/main?next=%2Fadmin"');
  expect(shell).toContain('href="http://127.0.0.1/admin/instance/open/news?next=%2Fadmin"');
  // Another user of the project sees no switcher: only the admin is in every project.
  const key = await createApiUser(port, PRIMARY, await logIn(port, PRIMARY, admin), "switcher-key");
  const users = await request(port, PRIMARY, "/api/users", { headers: { authorization: key } });
  expect(users.status).toBe(200);
  const other = await request(port, PRIMARY, "/api/users", {
    method: "POST",
    headers: { authorization: key, "content-type": "application/json" },
    body: JSON.stringify({
      username: "editor",
      email: "editor@example.test",
      name: "Editor",
      type: "user",
      status: "enabled",
      password_login: true,
      password: "editor-password-1",
      user_role_id: 1,
    }),
  });
  expect(other.status).toBe(200);
  const editor = await logIn(port, PRIMARY, { user: "editor", password: "editor-password-1" });
  const editorPage = await request(port, PRIMARY, "/admin", { headers: { cookie: editor.cookie } });
  expect(await editorPage.text()).not.toContain('data-testid="project-switcher"');
});

test("an extra hostname serves old unsubscribe links until it is removed", async () => {
  const session = (await handoff(port, PRIMARY, operator, "news")).project!;
  const { listId, subscriber, campaign } = await campaignFixture(
    "news.example.test",
    session,
    "old-link@news.example.test",
  );
  // A real send: the runner delivers the campaign through the sink, so its link pairs (D126).
  const started = await projectCall(
    "news.example.test",
    session,
    "PUT",
    `/api/campaigns/${campaign.id}/status`,
    { status: "running" },
  );
  expect(started.status).toBe(200);
  const recipient = "old-link@news.example.test";
  await untilState(() => sink.messages.some((message) => message.to.includes(recipient)), {
    label: "the campaign mail from news",
    progress: () => String(sink.messages.length),
  });
  const mail = sink.messages.find((message) => message.to.includes(recipient))!;
  const path = `/subscription/${campaign.uuid}/${subscriber.uuid}`;
  expect(mail.data.replaceAll(/\r\n[ \t]+/g, " ")).toContain(
    `List-Unsubscribe: <http://news.example.test${path}>`,
  );
  // The same link on the extra hostname: mail sent while that host was the project's.
  await untilState(async () => (await request(port, "old.example.test", path)).status === 200, {
    label: "the delivery recorded",
    progress: () => "",
    stallMs: 15_000,
  });
  const page = await request(port, "old.example.test", path);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Do you want to unsubscribe from this mailing list?");
  await untilState(
    async () => (await listProjects()).find((project) => project.slug === "news")?.sent_24h === 1,
    { label: "the Projects list counts the send", progress: () => "", stallMs: 15_000 },
  );
  // The RFC 8058 one-click POST, as a mail client sends it to the old List-Unsubscribe URL.
  const oneClick = await request(port, "old.example.test", path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(oneClick.status).toBe(200);
  const after = await projectCall(
    "news.example.test",
    session,
    "GET",
    `/api/subscribers/${subscriber.id}`,
  );
  expect(
    asBody<Array<{ id: number; subscription_status: string }>>(after.json().data.lists).find(
      (list) => list.id === listId,
    )?.subscription_status,
  ).toBe("unsubscribed");

  // Rename and replace the extra hostnames; the slug and main hostname stay.
  const edited = await call("PUT", "/api/instance/projects/news", {
    name: "News Weekly",
    extra: ["newer.example.test"],
  });
  expect(edited.status).toBe(200);
  expect((await readJson<{ data: ProjectJson }>(edited)).data).toMatchObject({
    slug: "news",
    name: "News Weekly",
    hostname: "news.example.test",
    extra: ["newer.example.test"],
  });
  // The removed host is unclaimed now: it reaches the primary, which has no such campaign.
  const gone = await request(port, "old.example.test", path);
  expect(gone.status).not.toBe(200);
  const newer = await request(port, "newer.example.test", path);
  expect(newer.status).toBe(200);

  // Refused edits write nothing: a host another project holds, a duplicate, a port, the instance
  // host, an empty name, an unknown project.
  for (const [body, status] of [
    [{ extra: ["127.0.0.1"] }, 409],
    [{ extra: ["a.example.test", "A.example.test"] }, 400],
    [{ extra: ["a.example.test:8080"] }, 400],
    [{ extra: ["news.example.test"] }, 400],
    [{ name: " " }, 400],
    [{ extra: "newer.example.test" }, 400],
  ] as const) {
    const refused = await call("PUT", "/api/instance/projects/news", body);
    expect({ body, status: refused.status }).toEqual({ body, status });
  }
  expect((await call("PUT", "/api/instance/projects/nothing", { name: "X" })).status).toBe(404);
  expect((await listProjects()).find((project) => project.slug === "news")).toMatchObject({
    name: "News Weekly",
    extra: ["newer.example.test"],
  });
});

test("create refuses invalid and conflicting projects and leaves no directory behind", async () => {
  for (const [body, status] of [
    [{ slug: "Bad", name: "B", hostname: "bad.example.test" }, 400],
    [{ slug: "x", name: "", hostname: "x.example.test" }, 400],
    [{ slug: "x", name: "X", hostname: "x.example.test:81" }, 400],
    [{ slug: "x", name: "X", hostname: "127.0.0.1" }, 409],
    [{ slug: "x", name: "X", hostname: "127.0.0.1", primary: true }, 409],
    [{ slug: "x", name: "X", hostname: "news.example.test" }, 409],
    [{ slug: "x", name: "X", hostname: "x.example.test", extra: ["newer.example.test"] }, 409],
    [{ slug: "news", name: "X", hostname: "x.example.test" }, 409],
    [{ slug: "x", name: "X", hostname: "x.example.test", primary: "yes" }, 400],
  ] as const) {
    const refused = await call("POST", "/api/instance/projects", body);
    expect({ body, status: refused.status }).toEqual({ body, status });
  }
  expect(readdirSync(join(dataDir, "projects")).toSorted()).toEqual(["main", "news"]);
});

test("a create that fails before its registry row leaves neither a row nor a directory", async () => {
  // projects/ cannot take a new directory: the wiring fails before anything is registered.
  chmodSync(join(dataDir, "projects"), 0o555);
  let failed: Response;
  try {
    failed = await call("POST", "/api/instance/projects", {
      slug: "broken",
      name: "Broken",
      hostname: "broken.example.test",
    });
  } finally {
    chmodSync(join(dataDir, "projects"), 0o755);
  }
  expect(failed.status).toBe(500);
  expect(existsSync(join(dataDir, "projects", "broken"))).toBe(false);
  expect((await listProjects()).map((p) => p.slug)).not.toContain("broken");
  // No row was left behind: the slug and hostname are free, and the create now succeeds.
  await createProject({ slug: "broken", name: "Broken", hostname: "broken.example.test" });
  expect(
    (await call("DELETE", "/api/instance/projects/broken", { confirm: "broken" })).status,
  ).toBe(200);
});

test("two creates of one slug at once: one wins, the other is refused and removes nothing", async () => {
  const [first, second] = await Promise.all([
    call("POST", "/api/instance/projects", {
      slug: "race",
      name: "Race one",
      hostname: "race1.example.test",
    }),
    call("POST", "/api/instance/projects", {
      slug: "race",
      name: "Race two",
      hostname: "race2.example.test",
    }),
  ]);
  expect([first.status, second.status].toSorted((a, b) => a - b)).toEqual([200, 409]);
  const winner = first.status === 200 ? "race1.example.test" : "race2.example.test";
  expect(existsSync(join(dataDir, "projects", "race", "iglo-email.db"))).toBe(true);
  // The winner is served from its intact directory.
  const session = await logIn(port, winner, admin);
  const settings = await projectCall(winner, session, "GET", "/api/settings");
  expect(settings.status).toBe(200);
  expect(settings.json().data["app.root_url"]).toBe(`http://${winner}`);
  const lists = await projectCall(winner, session, "POST", "/api/lists", {
    name: "after the race",
    type: "private",
    optin: "single",
  });
  expect(lists.status).toBe(200);
});

test("instance project routes refuse API credentials, need the CSRF token and are absent on project hosts", async () => {
  const key = await createApiUser(
    port,
    PRIMARY,
    await logIn(port, PRIMARY, admin),
    "lifecycle-key",
  );
  for (const [method, path] of [
    ["GET", "/api/instance/projects"],
    ["POST", "/api/instance/projects"],
    ["PUT", "/api/instance/projects/news"],
    ["DELETE", "/api/instance/projects/news"],
    ["GET", "/admin/instance/projects"],
    ["GET", "/admin/instance/logs"],
  ] as const) {
    const response = await request(port, PRIMARY, path, {
      method,
      headers: { authorization: key, cookie: operator.cookie, "x-csrf-token": operator.csrf },
    });
    expect({ method, path, status: response.status }).toEqual({ method, path, status: 401 });
  }
  // Without the CSRF token a change is refused, and nothing is written.
  for (const [method, path, body] of [
    ["POST", "/api/instance/projects", { slug: "nocsrf", name: "N", hostname: "n.example.test" }],
    ["PUT", "/api/instance/projects/news", { name: "Changed" }],
    ["DELETE", "/api/instance/projects/news", { confirm: "news" }],
  ] as const) {
    const response = await request(port, PRIMARY, path, {
      method,
      headers: { cookie: operator.cookie, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect({ method, status: response.status }).toEqual({ method, status: 403 });
  }
  // A project session is no instance session.
  const project = await logIn(port, PRIMARY, admin);
  const withProject = await request(port, PRIMARY, "/api/instance/projects", {
    headers: sessionHeaders(project),
  });
  expect(withProject.status).toBe(401);
  // On a project's own host these paths are that project's.
  const onProject = await instanceCall(
    port,
    "news.example.test",
    operator,
    "GET",
    "/api/instance/projects",
  );
  expect(onProject.status).toBe(404);
  const projects = await listProjects();
  expect(projects.map((p) => p.slug)).toEqual(["main", "news", "race"]);
  expect(projects.find((p) => p.slug === "news")?.name).toBe("News Weekly");
});

test("delete needs the typed slug, drains, keeps a final snapshot and frees the hostname", async () => {
  await createProject({ slug: "gone", name: "Gone", hostname: "gone.example.test" });
  const session = (await handoff(port, PRIMARY, operator, "gone")).project!;
  const { subscriber } = await campaignFixture(
    "gone.example.test",
    session,
    "kept@gone.example.test",
  );
  const form = new FormData();
  form.append("file", new File(["kept upload"], "kept.txt", { type: "text/plain" }));
  const uploaded = await request(port, "gone.example.test", "/api/media", {
    method: "POST",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    body: form,
  });
  expect(uploaded.status).toBe(200);

  // Without the typed slug, or with another one, nothing is deleted.
  for (const body of [undefined, {}, { confirm: "news" }]) {
    const refused = await call("DELETE", "/api/instance/projects/gone", body);
    expect(refused.status).toBe(400);
  }
  expect((await call("DELETE", "/api/instance/projects/none", { confirm: "none" })).status).toBe(
    404,
  );
  const deleted = await call("DELETE", "/api/instance/projects/gone", { confirm: "gone" });
  expect(deleted.status).toBe(200);
  const result = (await readJson<{ data: { database: string; files: string | null } }>(deleted))
    .data;
  expect(result.database).toMatch(/^backups\/deleted\/gone-.+\.db$/);
  expect(result.files).toMatch(/^backups\/deleted\/gone-.+\.tar$/);
  expect(existsSync(join(dataDir, "projects", "gone"))).toBe(false);

  // The snapshot holds the project's committed rows.
  const snapshot = new Database(join(dataDir, result.database), { readonly: true });
  try {
    const row = snapshot
      .query<{ email: string }, [number]>("SELECT email FROM subscribers WHERE id = ?")
      .get(subscriber.id);
    expect(row?.email).toBe("kept@gone.example.test");
  } finally {
    snapshot.close();
  }
  // The tarball holds the upload.
  const tar = await Bun.file(join(dataDir, result.files!)).text();
  expect(tar).toContain("kept upload");
  expect(statSync(join(dataDir, result.files!)).size % 512).toBe(0);

  // The host answers like an unclaimed one: the primary, which knows nothing of gone's session.
  const after = await projectCall("gone.example.test", session, "GET", "/api/settings");
  expect([401, 403]).toContain(after.status);
  const primary = await logIn(port, "gone.example.test", admin);
  const primarySettings = await projectCall("gone.example.test", primary, "GET", "/api/settings");
  expect(primarySettings.json().data["app.root_url"]).toBe("http://127.0.0.1");
  expect((await listProjects()).map((p) => p.slug)).toEqual(["main", "news", "race"]);
  // The hostname and slug are free again.
  await createProject({ slug: "gone", name: "Gone again", hostname: "gone.example.test" });
  expect((await call("DELETE", "/api/instance/projects/gone", { confirm: "gone" })).status).toBe(
    200,
  );
  // A project with no upload leaves no tarball.
  expect(
    readdirSync(join(dataDir, "backups", "deleted")).filter((n) => n.endsWith(".tar")),
  ).toEqual([result.files!.slice("backups/deleted/".length)]);
});

test("the Logs page shows the instance's lines and every project's, labelled", async () => {
  const page = await request(port, PRIMARY, "/admin/instance/logs", {
    headers: { cookie: operator.cookie },
  });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('data-testid="logs-help"');
  // The source labels are whatever wrote lines; the page itself renders with none or many.
  for (const match of html.matchAll(/data-source="([^"]+)"/g)) {
    expect(["instance", "main", "news", "race"]).toContain(match[1]!);
  }
});

test("a leftover directory is reported and never served; deleting the primary leaves none", async () => {
  const own = join(prepared.directory, "leftover");
  const first = await startInstance(prepared.executable, own, admin);
  expect((await first.stop()).code).toBe(0);
  mkdirSync(join(own, "projects", "stray"));
  writeFileSync(join(own, "projects", "stray", "note.txt"), "not a project");
  const again = await startInstance(prepared.executable, own, admin);
  try {
    const session = (await instanceLogin(again.port, PRIMARY, admin)).session!;
    const page = await request(again.port, PRIMARY, "/admin/instance/projects", {
      headers: { cookie: session.cookie },
    });
    const html = await page.text();
    expect(html).toContain('data-testid="project-leftovers"');
    expect(html).toContain("projects/stray");
    const logs = await request(again.port, PRIMARY, "/admin/instance/logs", {
      headers: { cookie: session.cookie },
    });
    const logsHtml = await logs.text();
    expect(logsHtml).toContain('data-source="instance"');
    expect(logsHtml).toContain("projects/stray has no registry row: it is not served");
    // A create of that slug is refused and leaves the directory as it was.
    const refused = await instanceCall(
      again.port,
      PRIMARY,
      session,
      "POST",
      "/api/instance/projects",
      { slug: "stray", name: "Stray", hostname: "stray.example.test" },
    );
    expect(refused.status).toBe(409);
    expect(readdirSync(join(own, "projects", "stray"))).toEqual(["note.txt"]);

    // Deleting the primary (D157): the instance answers as one with no primary.
    const deleted = await instanceCall(
      again.port,
      PRIMARY,
      session,
      "DELETE",
      "/api/instance/projects/main",
      { confirm: "main" },
    );
    expect(deleted.status).toBe(200);
    const missing = await request(again.port, PRIMARY, "/api/lists");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("404 page not found\n");
    const health = await request(again.port, PRIMARY, "/health");
    expect(health.status).toBe(200);
  } finally {
    const stopped = await again.stop();
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).toContain(
      "[instance] projects/stray has no registry row: it is not served",
    );
  }
  // A restart does not register a new primary over the deleted one.
  const third = await startInstance(prepared.executable, own, admin);
  try {
    expect((await request(third.port, PRIMARY, "/api/lists")).status).toBe(404);
    expect(readdirSync(join(own, "projects"))).toEqual(["stray"]);
    // A new primary can be created on the instance host.
    const session = (await instanceLogin(third.port, PRIMARY, admin)).session!;
    const created = await instanceCall(
      third.port,
      PRIMARY,
      session,
      "POST",
      "/api/instance/projects",
      { slug: "fresh", name: "Fresh", hostname: "127.0.0.1", primary: true },
    );
    expect(created.status).toBe(200);
    await logIn(third.port, PRIMARY, admin);
  } finally {
    expect((await third.stop()).code).toBe(0);
  }
});
