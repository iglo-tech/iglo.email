// B51: a new SMTP server, bounce mailbox or messenger never inherits another item's password or
// DKIM key. Public boundaries only: GET and PUT /api/settings through the admin session.
// Each test starts a fresh fixture: the first save of a seeded item assigns it a uuid, so a later
// test would no longer see the uuid-less state it exercises.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { admin, api, get, login, type Fixture } from "@/test/admin/support";
import { startUserFixture } from "@/test/users/fixture";
import { openDatabase } from "@/db/connection";
import { writeStoredValue } from "@/settings/stored";

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

// The settings page sends each masked secret back empty, which the API reads as "keep"
// (settings.js onSubmit). Every save below takes the page's shape the same way.
function unmasked(value: unknown): any {
  if (typeof value === "string") return /^•+$/.test(value) ? "" : value;
  if (Array.isArray(value)) return value.map(unmasked);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmasked(item)]));
  return value;
}

const save = (body: unknown) => api(f, cookie, "/api/settings", "PUT", body);

test("1. a new SMTP server with a blank password stores none, not the seeded server's", async () => {
  const body = unmasked(await read());
  body.smtp.push({
    ...body.smtp[0],
    uuid: "",
    name: "b51-smtp",
    host: "b51-smtp.example.test",
    username: "b51-smtp-user",
    password: "",
    enabled: false,
    from_addresses: [],
  });
  expect((await save(body)).status).toBe(200);

  const added = (await read()).smtp.find(
    (item: { host: string }) => item.host === "b51-smtp.example.test",
  );
  expect(added).toBeDefined();
  expect(added.password).toBeUndefined();
});

test("2. a new bounce mailbox with a blank password stores none, not the seeded mailbox's", async () => {
  const body = unmasked(await read());
  body["bounce.mailboxes"].push({
    ...body["bounce.mailboxes"][0],
    uuid: "",
    host: "b51-bounce.example.test",
    username: "b51-bounce-user",
    password: "",
    return_path: "bounces@b51.example.test",
  });
  expect((await save(body)).status).toBe(200);

  const added = (await read())["bounce.mailboxes"].find(
    (item: { host: string }) => item.host === "b51-bounce.example.test",
  );
  expect(added).toBeDefined();
  expect(added.password).toBeUndefined();
});

test("3. a new messenger with a blank password stores none, and the stored one keeps its secret", async () => {
  const secret = "b51-messenger-secret";
  const first = unmasked(await read());
  first.messengers = [
    {
      uuid: "",
      enabled: false,
      name: "b51-chat",
      root_url: "https://chat.example.test",
      username: "b51-bot",
      password: secret,
      max_conns: 10,
      timeout: "5s",
      max_msg_retries: 2,
    },
  ];
  expect((await save(first)).status).toBe(200);
  const stored = (await read()).messengers.find(
    (item: { name: string }) => item.name === "b51-chat",
  );
  expect(stored.password).toBe("•".repeat(secret.length));

  const second = unmasked(await read());
  second.messengers.push({
    ...second.messengers[0],
    uuid: "",
    name: "b51-chat-two",
    username: "b51-bot-two",
    password: "",
  });
  expect((await save(second)).status).toBe(200);

  const messengers = (await read()).messengers as {
    name: string;
    password?: string;
  }[];
  const added = messengers.find((item) => item.name === "b51-chat-two");
  expect(added).toBeDefined();
  expect(added!.password).toBeUndefined();
  expect(messengers.find((item) => item.name === "b51-chat")!.password).toBe(
    "•".repeat(secret.length),
  );
});

// A stored SMTP row with no uuid cannot come from the API, which assigns one on every save. It is
// the state a hand-written row would leave, so this writes it straight into the fixture's database
// and then uses the API only.
async function storeUuidlessDkimServer(): Promise<void> {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const template = unmasked((await read()).smtp[0]);
  const db = openDatabase(f.persisted.dataDir);
  try {
    writeStoredValue(db, "smtp", [
      {
        ...template,
        uuid: "",
        name: "",
        host: "b51-dkim.example.test",
        password: "",
        enabled: true,
        dkim: { domain_name: "b51.example.test", key_selector: "b51", private_key: privateKey },
      },
    ]);
  } finally {
    db.close();
  }
  const stored = (await read()).smtp.find(
    (item: { host: string }) => item.host === "b51-dkim.example.test",
  );
  expect(stored.dkim.private_key).toBe("•".repeat(privateKey.length));
}

test("4. a new SMTP server without a DKIM block does not take another server's DKIM key", async () => {
  await storeUuidlessDkimServer();
  const body = unmasked(await read());
  const template = body.smtp.find(
    (item: { host: string }) => item.host === "b51-dkim.example.test",
  );
  const plain: Record<string, any> = {
    ...template,
    uuid: "",
    name: "b51-plain",
    host: "b51-plain.example.test",
    password: "",
    enabled: true,
  };
  delete plain.dkim;
  body.smtp = [plain];
  expect((await save(body)).status).toBe(200);

  const added = (await read()).smtp.find(
    (item: { host: string }) => item.host === "b51-plain.example.test",
  );
  expect(added).toBeDefined();
  expect(added.dkim).toBeUndefined();
});

test("5. a new SMTP server with a blank DKIM key is refused, and no other server's key is copied in", async () => {
  await storeUuidlessDkimServer();
  const before = await read();
  const body = unmasked(before);
  const template = body.smtp.find(
    (item: { host: string }) => item.host === "b51-dkim.example.test",
  );
  const kept: Record<string, any> = {
    ...template,
    uuid: "",
    name: "b51-keep-default",
    password: "",
    enabled: true,
  };
  delete kept.dkim;
  body.smtp = [
    kept,
    {
      ...template,
      uuid: "",
      name: "b51-blank",
      host: "b51-blank.example.test",
      password: "",
      enabled: false,
      dkim: { domain_name: "b51.example.test", key_selector: "b51", private_key: "" },
    },
  ];
  const response = await save(body);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ message: "Invalid DKIM configuration." });
  expect(await read()).toEqual(before);
});

test("6. an existing SMTP server saved with a blank password keeps its stored password", async () => {
  const secret = "b51-stored-secret";
  const body = unmasked(await read());
  body.smtp.push({
    ...body.smtp[0],
    uuid: "",
    name: "b51-keep",
    host: "b51-keep.example.test",
    username: "b51-keep-user",
    password: secret,
    enabled: false,
    from_addresses: [],
  });
  expect((await save(body)).status).toBe(200);
  const first = (await read()).smtp.find(
    (item: { host: string }) => item.host === "b51-keep.example.test",
  );
  expect(first.password).toBe("•".repeat(secret.length));

  // The page's normal masked save: the same item, with its uuid, and the password sent back empty.
  const again = unmasked(await read());
  expect(
    again.smtp.find((item: { host: string }) => item.host === "b51-keep.example.test").password,
  ).toBe("");
  expect((await save(again)).status).toBe(200);
  const kept = (await read()).smtp.find(
    (item: { host: string }) => item.host === "b51-keep.example.test",
  );
  expect(kept.uuid).toBe(first.uuid);
  expect(kept.password).toBe("•".repeat(secret.length));
});

test("7. a seeded SMTP server has a uuid before its first save, and that save keeps its password", async () => {
  const before = await read();
  expect(typeof before.smtp[0].uuid).toBe("string");
  expect(before.smtp[0].uuid.length).toBeGreaterThan(0);

  // The page's first save of a seeded server: its password is masked and sent back empty.
  expect((await save(unmasked(before))).status).toBe(200);
  const after = await read();
  expect(after.smtp[0].uuid).toBe(before.smtp[0].uuid);
  expect(after.smtp[0].password).toBe("•".repeat("password".length));
});

// The pre-B51 state: every list is stored with uuid-less rows that hold real passwords. The new
// items below are uuid-less too, so a lookup that matches "" to "" would hand them these secrets.
test("8. new SMTP, bounce and messenger items with blank passwords take none from uuid-less rows", async () => {
  const seeded = unmasked(await read());
  const db = openDatabase(f.persisted.dataDir);
  try {
    writeStoredValue(db, "smtp", [
      {
        ...seeded.smtp[0],
        uuid: "",
        name: "",
        host: "b51-stored-smtp.example.test",
        password: "b51-smtp-stored-secret",
      },
    ]);
    writeStoredValue(db, "bounce.mailboxes", [
      {
        ...seeded["bounce.mailboxes"][0],
        uuid: "",
        host: "b51-stored-bounce.example.test",
        password: "b51-bounce-stored-secret",
      },
    ]);
    writeStoredValue(db, "messengers", [
      {
        uuid: "",
        enabled: false,
        name: "b51-stored-chat",
        root_url: "https://chat.example.test",
        username: "b51-stored-bot",
        password: "b51-messenger-stored-secret",
        max_conns: 10,
        timeout: "5s",
        max_msg_retries: 2,
      },
    ]);
  } finally {
    db.close();
  }

  const body = unmasked(await read());
  body.smtp.push({
    ...seeded.smtp[0],
    uuid: "",
    name: "b51-new-smtp",
    host: "b51-new-smtp.example.test",
    username: "b51-new-smtp-user",
    password: "",
    enabled: false,
    from_addresses: [],
  });
  body["bounce.mailboxes"].push({
    ...seeded["bounce.mailboxes"][0],
    uuid: "",
    host: "b51-new-bounce.example.test",
    username: "b51-new-bounce-user",
    password: "",
    return_path: "bounces@b51.example.test",
  });
  body.messengers.push({
    uuid: "",
    enabled: false,
    name: "b51-new-chat",
    root_url: "https://chat.example.test",
    username: "b51-new-bot",
    password: "",
    max_conns: 10,
    timeout: "5s",
    max_msg_retries: 2,
  });
  expect((await save(body)).status).toBe(200);

  const after = await read();
  const smtp = after.smtp.find(
    (item: { host: string }) => item.host === "b51-new-smtp.example.test",
  );
  const bounce = after["bounce.mailboxes"].find(
    (item: { host: string }) => item.host === "b51-new-bounce.example.test",
  );
  const messenger = after.messengers.find((item: { name: string }) => item.name === "b51-new-chat");
  expect(smtp).toBeDefined();
  expect(bounce).toBeDefined();
  expect(messenger).toBeDefined();
  expect(smtp.password).toBeUndefined();
  expect(bounce.password).toBeUndefined();
  expect(messenger.password).toBeUndefined();
});
