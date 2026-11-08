// B56: settings secret residuals. Public boundaries only: GET and PUT /api/settings through the admin
// session. The page sends each masked secret back empty, which the API reads as "keep"; `unmasked`
// takes the page's shape the same way (settings.js onSubmit).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { admin, api, get, login, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeEach(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterEach(() => f.close());

async function read(): Promise<Record<string, any>> {
  const res = await get(f, "/api/settings", cookie);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Record<string, any> }).data;
}

function unmasked(value: unknown): any {
  if (typeof value === "string") return /^•+$/.test(value) ? "" : value;
  if (Array.isArray(value)) return value.map(unmasked);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmasked(item)]));
  return value;
}

const save = (body: unknown) => api(f, cookie, "/api/settings", "PUT", body);
const masked = (text: string) => "•".repeat(text.length);

// Stores a real password on the seeded SMTP server, which has auth cram (an authenticated mode).
async function storeSmtpSecret(secret: string): Promise<void> {
  const body = unmasked(await read());
  body.smtp[0].password = secret;
  expect((await save(body)).status).toBe(200);
  expect((await read()).smtp[0].password).toBe(masked(secret));
}

test("1. a masked save of an authenticated server keeps its stored password", async () => {
  const secret = "b56-smtp-login-secret";
  await storeSmtpSecret(secret);

  const again = unmasked(await read());
  expect(again.smtp[0].password).toBe("");
  expect((await save(again)).status).toBe(200);
  expect((await read()).smtp[0].password).toBe(masked(secret));
});

test("2. switching a saved server to auth none drops its stored password", async () => {
  await storeSmtpSecret("b56-smtp-login-secret");

  // The page disables the password field under auth none and sends it back empty.
  const body = unmasked(await read());
  body.smtp[0].auth_protocol = "none";
  expect((await save(body)).status).toBe(200);

  const stored = (await read()).smtp[0];
  expect(stored.auth_protocol).toBe("none");
  expect(stored.password).toBeUndefined();
});

test("3. switching a server back to login with a blank password stores none", async () => {
  await storeSmtpSecret("b56-smtp-login-secret");
  const none = unmasked(await read());
  none.smtp[0].auth_protocol = "none";
  expect((await save(none)).status).toBe(200);

  const back = unmasked(await read());
  back.smtp[0].auth_protocol = "login";
  back.smtp[0].password = "";
  expect((await save(back)).status).toBe(200);

  const stored = (await read()).smtp[0];
  expect(stored.auth_protocol).toBe("login");
  expect(stored.password).toBeUndefined();
});

test("4. a bounce mailbox switched to auth none drops its password, and switching back stores none", async () => {
  const secret = "b56-bounce-login-secret";
  const first = unmasked(await read());
  first["bounce.mailboxes"][0].password = secret;
  expect((await save(first)).status).toBe(200);
  expect((await read())["bounce.mailboxes"][0].password).toBe(masked(secret));

  const none = unmasked(await read());
  none["bounce.mailboxes"][0].auth_protocol = "none";
  expect((await save(none)).status).toBe(200);
  const off = (await read())["bounce.mailboxes"][0];
  expect(off.auth_protocol).toBe("none");
  expect(off.password).toBeUndefined();

  const back = unmasked(await read());
  back["bounce.mailboxes"][0].auth_protocol = "userpass";
  back["bounce.mailboxes"][0].password = "";
  expect((await save(back)).status).toBe(200);
  const on = (await read())["bounce.mailboxes"][0];
  expect(on.auth_protocol).toBe("userpass");
  expect(on.password).toBeUndefined();
});

test("5. a save with two SMTP servers sharing one uuid is refused, and changes nothing", async () => {
  const before = await read();
  const body = unmasked(before);
  body.smtp.push({
    ...body.smtp[0],
    name: "b56-twin",
    host: "b56-twin.example.test",
    password: "b56-twin-secret",
    enabled: false,
    from_addresses: [],
  });
  const response = await save(body);
  expect(response.status).toBe(400);
  expect(((await response.json()) as { message: string }).message).toMatch(/uuid/i);
  expect(await read()).toEqual(before);
});

test("6. a save with two bounce mailboxes or two messengers sharing a uuid is refused, and changes nothing", async () => {
  const before = await read();

  const mailboxes = unmasked(before);
  mailboxes["bounce.mailboxes"].push({
    ...mailboxes["bounce.mailboxes"][0],
    host: "b56-twin-bounce.example.test",
    password: "b56-twin-bounce-secret",
  });
  const mailboxResponse = await save(mailboxes);
  expect(mailboxResponse.status).toBe(400);
  expect(await read()).toEqual(before);

  const messengerItem = {
    uuid: "b56-shared-messenger-uuid",
    enabled: false,
    max_conns: 10,
    timeout: "5s",
    max_msg_retries: 2,
    root_url: "https://chat.example.test",
    username: "b56-bot",
    password: "b56-bot-secret",
  };
  const messengers = unmasked(before);
  messengers.messengers = [
    { ...messengerItem, name: "b56-chat-one" },
    { ...messengerItem, name: "b56-chat-two" },
  ];
  const messengerResponse = await save(messengers);
  expect(messengerResponse.status).toBe(400);
  expect(await read()).toEqual(before);
});

test("7. the per-key SMTP update refuses duplicate uuids too", async () => {
  const before = await read();
  const items = unmasked(before.smtp);
  items.push({ ...items[0], name: "b56-key-twin", host: "b56-key-twin.example.test" });
  const response = await api(f, cookie, "/api/settings/smtp", "PUT", items);
  expect(response.status).toBe(400);
  expect(await read()).toEqual(before);
});

test("8. new items with no uuid are not duplicates of each other", async () => {
  const body = unmasked(await read());
  const template = { ...body.smtp[0], uuid: "", enabled: false, from_addresses: [], password: "" };
  body.smtp.push(
    { ...template, name: "b56-new-one", host: "b56-new-one.example.test" },
    { ...template, name: "b56-new-two", host: "b56-new-two.example.test" },
  );
  expect((await save(body)).status).toBe(200);

  const added = (await read()).smtp.filter((item: { host: string }) =>
    item.host.startsWith("b56-new-"),
  );
  expect(added).toHaveLength(2);
  expect(added[0].uuid).not.toBe(added[1].uuid);
});

test("9. an SMTP server saved with an empty auth protocol drops its stored password, as auth none does", async () => {
  // Mail sends with no login for an empty protocol (email.ts makeTransport), so the password is
  // dead weight, exactly as under auth none.
  await storeSmtpSecret("b56-smtp-empty-protocol-secret");

  const body = unmasked(await read());
  body.smtp[0].auth_protocol = "";
  expect((await save(body)).status).toBe(200);

  const stored = (await read()).smtp[0];
  expect(stored.auth_protocol).toBe("");
  expect(stored.password).toBeUndefined();
});
