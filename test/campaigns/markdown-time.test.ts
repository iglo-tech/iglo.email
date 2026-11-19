// B104: Markdown is bounded by the work budget, not by how long marked's link scanning takes.
// Requests go through the campaigns routes; a reader holding only campaigns:get must not be able to
// hold up the server, so a read started during a preview must answer at once too.
import { afterEach, expect, test } from "bun:test";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";

const fixtures: CampaignsFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
async function open() {
  const f = await campaignsFixture();
  fixtures.push(f);
  return f;
}

/**
 * A password user with the given user permissions and list grants (as the contract suite builds
 * list-scoped accounts), returning session headers.
 */
async function reader(
  f: CampaignsFixture,
  name: string,
  permissions: string[],
  lists: { id: number; permissions: string[] }[],
) {
  const role = await f.json("/api/roles/users", "POST", { name, permissions });
  expect(role.status).toBe(200);
  const listRole = await f.json("/api/roles/lists", "POST", { name: `${name}-lists`, lists });
  expect(listRole.status).toBe(200);
  const created = await f.json("/api/users", "POST", {
    username: name,
    email: `${name}@fixture.test`,
    name,
    type: "user",
    status: "enabled",
    password_login: true,
    password: "reader-password-1",
    password2: "reader-password-1",
    user_role_id: role.body.data.id,
    list_role_id: listRole.body.data.id,
  });
  expect(created.status).toBe(200);
  const session = await f.owners.auth.login(name, "reader-password-1");
  if (!session || !("id" in session)) throw new Error("reader login failed");
  return { cookie: `session=${session.id}`, "x-csrf-token": session.csrf };
}

const repeat = (unit: string, bytes: number) =>
  unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

/** Posts a Markdown preview as the form the editor sends. */
function previewRequest(
  f: CampaignsFixture,
  id: number,
  headers: Record<string, string>,
  body: string,
) {
  return f.request(`/api/campaigns/${id}/preview`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ content_type: "markdown", body }).toString(),
  });
}

test("a reader's 8 KiB of link openers is refused at once, and a concurrent read is not held behind it", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await reader(
    f,
    "md-reader",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const started = performance.now();
  const preview = previewRequest(f, campaign.id, headers, repeat("[](", 8192)).then((response) => ({
    status: response.status,
    ms: performance.now() - started,
  }));
  await Bun.sleep(5);
  const readStarted = performance.now();
  const read = f
    .json(`/api/campaigns/${campaign.id}`, "GET", undefined, headers)
    .then((response) => ({ status: response.status, ms: performance.now() - readStarted }));
  const [previewed, reading] = await Promise.all([preview, read]);
  expect(previewed.status).toBe(400);
  expect(previewed.ms).toBeLessThan(1000);
  expect(reading.status).toBe(200);
  expect(reading.ms).toBeLessThan(1000);
});

// One pathological family per link, image, reference, title and emphasis shape that marked scans.
const families: Record<string, string> = {
  "empty link": "[](",
  destination: "[x](y",
  "spaced destination": "[x]( ",
  "glued quote": '[x](y"',
  "glued paren": "[x](y(",
  "title opener": '[x](y "',
  image: "![](",
  reference: "[x][",
  autolink: "<a ",
  "emphasis pairs": "*a ",
  "code span": "`a ",
};

test.each(Object.entries(families))(
  "a 64 KiB Markdown preview of %s answers within a second",
  async (_, unit) => {
    const f = await open();
    const news = await f.list("news");
    const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
    const headers = await reader(
      f,
      "family-reader",
      ["campaigns:get"],
      [{ id: news, permissions: ["list:get"] }],
    );
    const started = performance.now();
    const response = await previewRequest(f, campaign.id, headers, repeat(unit, 64 * 1024));
    await response.text();
    expect(performance.now() - started).toBeLessThan(1000);
    expect([200, 400]).toContain(response.status);
  },
);

test("a 64 KiB content conversion of link openers is refused within a second", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await reader(
    f,
    "convert-manager",
    ["campaigns:get", "campaigns:manage"],
    [{ id: news, permissions: ["list:get", "list:manage"] }],
  );
  const started = performance.now();
  const response = await f.request(`/api/campaigns/${campaign.id}/content`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ body: repeat("[](", 64 * 1024), from: "markdown", to: "html" }),
  });
  await response.text();
  expect(performance.now() - started).toBeLessThan(1000);
  expect([200, 400]).toContain(response.status);
});

test("a normal link title still applies, and a title glued to its destination is part of it", async () => {
  const f = await open();
  const news = await f.list("news");
  const campaign = await f.campaign({ name: "md", subject: "s", lists: [news] });
  const headers = await reader(
    f,
    "title-reader",
    ["campaigns:get"],
    [{ id: news, permissions: ["list:get"] }],
  );
  const titled = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a "Titled")')
  ).text();
  expect(titled).toContain('<a href="https://example.com/a" title="Titled">x</a>');
  // A title may start on the next line, as in CommonMark.
  const onNextLine = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a\n"Titled")')
  ).text();
  expect(onNextLine).toContain('<a href="https://example.com/a" title="Titled">x</a>');
  // Whitespace is needed before a title; without it the quotes belong to the URL.
  const glued = await (
    await previewRequest(f, campaign.id, headers, '[x](https://example.com/a"Titled")')
  ).text();
  expect(glued).toContain('<a href="https://example.com/a%22Titled%22">x</a>');
  expect(glued).not.toContain("title=");
});
