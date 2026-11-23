// B117d (D139): a list-scoped reader of the send log (sends:get) sees the sends to subscribers on its
// lists, as subscriber reads do, and no other send: not in a list, a subscriber's sends or a by-ID read,
// and not a resend of one. An unscoped reader sees every send. Observed through HTTP, with a password
// session, as the send-log page reads the journal.
import { afterEach, expect, test } from "bun:test";
import { txFixture } from "@/test/tx/fixture";
import type { TxFixture } from "@/test/tx/fixture";
import { asBody } from "@/test/read-body";

const fixtures: Array<TxFixture> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.close();
  }
});
async function open(options: Parameters<typeof txFixture>[0] = {}) {
  const f = await txFixture(options);
  fixtures.push(f);
  return f;
}

/** The ID of the one send a synchronous request journaled. */
function sendOf(response: { status: number; body: { data: { sends: Array<{ id: number }> } } }) {
  expect(response.status).toBe(200);
  return asBody<Array<{ id: number }>>(response.body.data.sends)[0]!.id;
}

async function makeList(f: TxFixture, name: string) {
  const created = await f.json("/api/lists", "POST", { name, type: "private", optin: "single" });
  expect(created.status).toBe(200);
  return asBody<number>(created.body.data.id);
}

/** A user with a user role and, when given, a list role, and its password session. */
async function reader(
  f: TxFixture,
  name: string,
  permissions: Array<string>,
  lists: Array<{ id: number; permissions: Array<string> }> = [],
) {
  const role = await f.json("/api/roles/users", "POST", { name: `${name}-role`, permissions });
  expect(role.status).toBe(200);
  let listRoleId: number | null = null;
  if (lists.length) {
    const listRole = await f.json("/api/roles/lists", "POST", { name: `${name}-lists`, lists });
    expect(listRole.status).toBe(200);
    listRoleId = asBody<number>(listRole.body.data.id);
  }
  const password = "fixture-password-long";
  const user = await f.json("/api/users", "POST", {
    username: name,
    name,
    email: `${name}@example.test`,
    type: "user",
    status: "enabled",
    password_login: true,
    password,
    user_role_id: role.body.data.id,
    list_role_id: listRoleId,
  });
  expect(user.status).toBe(200);
  const session = await f.auth.login(name, password);
  if (!session || !("id" in session)) {
    throw new Error("reader login failed");
  }
  return { cookie: `session=${session.id}; csrf=${session.csrf}`, "x-csrf-token": session.csrf };
}

type Page = { total: number; results: Array<{ id: number }> };
async function page(f: TxFixture, path: string, headers: Record<string, string>) {
  const response = await f.json(path, "GET", undefined, headers);
  expect(response.status).toBe(200);
  const data = asBody<Page>(response.body.data);
  return { total: data.total, ids: data.results.map((row) => row.id) };
}

test("a list-scoped reader sees only the sends to subscribers on its lists", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const mine = await makeList(f, "Mine");
  const theirs = await makeList(f, "Theirs");
  const inMine = await f.subscriber("in-mine@example.test", "In Mine", { lists: [mine] });
  const inTheirs = await f.subscriber("in-theirs@example.test", "In Theirs", { lists: [theirs] });
  const mineSend = sendOf(
    await f.tx({ subscriber_id: inMine, template_id: template, kind: "marketing", list_id: mine }),
  );
  const theirsSend = sendOf(
    await f.tx({
      subscriber_id: inTheirs,
      template_id: template,
      kind: "marketing",
      list_id: theirs,
    }),
  );
  const external = sendOf(
    await f.tx({ subscriber_emails: ["stranger@example.test"], template_id: template }),
  );
  const scoped = await reader(
    f,
    "scoped",
    ["sends:get"],
    [{ id: mine, permissions: ["list:get"] }],
  );
  const everything = await reader(f, "everything", ["sends:get"]);

  expect(await page(f, "/api/sends", everything)).toEqual({
    total: 3,
    ids: [external, theirsSend, mineSend],
  });
  expect(await page(f, "/api/sends", scoped)).toEqual({ total: 1, ids: [mineSend] });
  expect(await page(f, `/api/sends?subscriber_id=${inTheirs}`, scoped)).toEqual({
    total: 0,
    ids: [],
  });
  expect(await page(f, `/api/sends?subscriber_id=${inMine}`, scoped)).toEqual({
    total: 1,
    ids: [mineSend],
  });
  expect(await page(f, `/api/sends?list_id=${theirs}`, scoped)).toEqual({ total: 0, ids: [] });
  expect(await page(f, `/api/sends?list_id=${mine}`, scoped)).toEqual({
    total: 1,
    ids: [mineSend],
  });
  // The total and the page count only what the reader may see.
  expect(await page(f, "/api/sends?kind=marketing&per_page=1", scoped)).toEqual({
    total: 1,
    ids: [mineSend],
  });

  // A by-ID read of a send out of scope is a 403, as a subscriber's out-of-scope read is; a missing ID is 404.
  for (const id of [theirsSend, external]) {
    expect((await f.json(`/api/sends/${id}`, "GET", undefined, scoped)).status).toBe(403);
    expect((await f.json(`/api/sends/${id}`, "GET", undefined, everything)).status).toBe(200);
  }
  expect((await f.json(`/api/sends/${mineSend}`, "GET", undefined, scoped)).status).toBe(200);
  expect((await f.json("/api/sends/999999", "GET", undefined, scoped)).status).toBe(404);
});

test("the send-log page reads the same scoped journal from a password session", async () => {
  const f = await open();
  const template = await f.template("<p>x</p>");
  const mine = await makeList(f, "Mine");
  const inMine = await f.subscriber("page-mine@example.test", "Page Mine", { lists: [mine] });
  const outside = await f.subscriber("page-outside@example.test", "Page Outside");
  const mineSend = sendOf(await f.tx({ subscriber_id: inMine, template_id: template }));
  const outsideSend = sendOf(await f.tx({ subscriber_id: outside, template_id: template }));
  const scoped = await reader(
    f,
    "page-scoped",
    ["sends:get"],
    [{ id: mine, permissions: ["list:get"] }],
  );
  const everything = await reader(f, "page-everything", ["sends:get"]);

  expect(await page(f, "/api/sends", scoped)).toEqual({ total: 1, ids: [mineSend] });
  expect(await page(f, "/api/sends", everything)).toEqual({
    total: 2,
    ids: [outsideSend, mineSend],
  });
});

test("a list-scoped sender may resend only a send to a subscriber on its lists", async () => {
  const f = await open({ reject: () => true });
  const template = await f.template("<p>x</p>");
  const mine = await makeList(f, "Mine");
  const theirs = await makeList(f, "Theirs");
  const inMine = await f.subscriber("resend-mine@example.test", "Mine", { lists: [mine] });
  const inTheirs = await f.subscriber("resend-theirs@example.test", "Theirs", { lists: [theirs] });
  const mineSend = sendOf(await f.tx({ subscriber_id: inMine, template_id: template }));
  const theirsSend = sendOf(await f.tx({ subscriber_id: inTheirs, template_id: template }));
  const manager = await reader(
    f,
    "resender",
    ["sends:get", "sends:manage"],
    [{ id: mine, permissions: ["list:get"] }],
  );

  const refused = await f.json(`/api/sends/${theirsSend}/resend`, "POST", {}, manager);
  expect(refused.status).toBe(403);
  const child = await f.json(`/api/sends/${mineSend}/resend`, "POST", {}, manager);
  expect(child.status).toBe(200);
  expect(child.body.data).toMatchObject({
    retry_of: mineSend,
    to_email: "resend-mine@example.test",
  });
  // The refused resend wrote nothing: the other subscriber still has only the original send.
  const admin = await f.json(`/api/sends?subscriber_id=${inTheirs}`);
  expect(admin.body.data.total).toBe(1);
});
