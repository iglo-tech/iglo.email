// B117a (D136): settings values the server reads are checked when they are saved, through the settings
// API. A refused value changes nothing and names the setting; an accepted one is read back as sent. A value
// an older build stored is checked only when it changes, so it does not block saving anything else.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { admin, api, get, login } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { openDatabase } from "@/db/connection";
import { startUserFixture } from "@/test/users/fixture";
import { readJson } from "@/test/read-body";
import { instanceKeys } from "@/settings/keys";

let f: Fixture;
let cookie = "";
beforeAll(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterAll(() => f.close());

/** One enabled SMTP server, as the settings form posts it; `overrides` set the field under test. */
function smtpServer(overrides: Record<string, unknown>) {
  return {
    name: "",
    uuid: "",
    enabled: true,
    host: "smtp.example.test",
    hello_hostname: "",
    port: 2525,
    auth_protocol: "none",
    username: "",
    password: "",
    email_headers: [],
    max_conns: 1,
    max_msg_retries: 0,
    msg_retry_delay: "10ms",
    idle_timeout: "15s",
    wait_timeout: "5s",
    tls_type: "none",
    tls_skip_verify: false,
    from_addresses: [],
    exclude_from_default: false,
    ...overrides,
  };
}

async function settings(path = "/api/settings"): Promise<Record<string, any>> {
  const res = await get(f, path, cookie);
  expect(res.status).toBe(200);
  return (await readJson<{ data: Record<string, any> }>(res)).data;
}
const instance = "/api/instance/settings";

/** A single-key write to its side's API: its status and, when refused, its message. */
async function put(key: string, value: unknown) {
  const res = await api(
    f,
    cookie,
    `${instanceKeys.has(key) ? instance : "/api/settings"}/${key}`,
    "PUT",
    value,
  );
  const message =
    res.status === 400 ? (await readJson<{ message: string }>(res)).message : undefined;
  return { status: res.status, message };
}

test("every administrator address is checked on save, and a blank entry is kept blank", async () => {
  const refused = await put("app.notify_emails", ["ops@example.test", "ops@"]);
  expect(refused.status).toBe(400);
  expect(refused.message).toBe("invalid notification email address: ops@");
  expect((await settings())["app.notify_emails"]).not.toContain("ops@");

  expect(await put("app.notify_emails", ["  ops@example.test  ", " "])).toEqual({
    status: 200,
    message: undefined,
  });
  expect((await settings())["app.notify_emails"]).toEqual(["ops@example.test", ""]);
  await put("app.notify_emails", []);
});

test("an administrator address an older build stored does not block saving another setting", async () => {
  // What an older build would have stored: the same file, written beside the running server.
  const db = openDatabase(f.persisted.dataDir);
  try {
    db.run("UPDATE settings SET value = ? WHERE key = ?", [
      JSON.stringify(["bad..local@example.test"]),
      "app.notify_emails",
    ]);
  } finally {
    db.close();
  }
  expect((await put("app.site_name", "Renamed with a stored bad address")).status).toBe(200);
  expect((await settings())["app.notify_emails"]).toEqual(["bad..local@example.test"]);
  // A new bad address is still refused, and the stored one is named nowhere new.
  const added = await put("app.notify_emails", ["bad..local@example.test", "new@"]);
  expect(added.status).toBe(400);
  expect(added.message).toBe("invalid notification email address: new@");
  await put("app.notify_emails", []);
});

test("the vacuum cron is checked when vacuum is on, and not while it is off", async () => {
  const bad = await put("maintenance.db", { vacuum: true, vacuum_cron_interval: "bad cron" });
  expect(bad.status).toBe(400);
  expect(bad.message).toContain("vacuum cron");
  expect(await put("maintenance.db", { vacuum: false, vacuum_cron_interval: "bad cron" })).toEqual({
    status: 200,
    message: undefined,
  });
  expect(await put("maintenance.db", { vacuum: true, vacuum_cron_interval: "0 3 * * 1" })).toEqual({
    status: 200,
    message: undefined,
  });
  await put("maintenance.db", { vacuum: false, vacuum_cron_interval: "0 2 * * *" });
});

test("the S3 expiry is a duration when it is set, and an empty one keeps the default", async () => {
  for (const value of ["x", "0s", "-1h"]) {
    expect((await put("upload.s3.expiry", value)).status).toBe(400);
  }
  expect(await put("upload.s3.expiry", "48h")).toEqual({ status: 200, message: undefined });
  expect(await put("upload.s3.expiry", "")).toEqual({ status: 200, message: undefined });
  await put("upload.s3.expiry", "167h");
});

test("an SMTP idle timeout is 1 s to 5 min, and the retry delay is a duration", async () => {
  const stored = await settings(instance);
  const save = (overrides: Record<string, unknown>) =>
    api(f, cookie, instance, "PUT", { ...stored, smtp: [smtpServer(overrides)] });
  for (const overrides of [
    { idle_timeout: "1ms" },
    { idle_timeout: "5m1s" },
    { idle_timeout: "x" },
  ]) {
    const refused = await save(overrides);
    expect({ overrides, status: refused.status }).toEqual({ overrides, status: 400 });
    expect((await readJson<{ message: string }>(refused)).message).toContain("idle timeout");
  }
  expect((await save({ msg_retry_delay: "x" })).status).toBe(400);
  expect((await save({ idle_timeout: "5m" })).status).toBe(200);
  expect((await save({ idle_timeout: "" })).status).toBe(200);
  expect((await save({})).status).toBe(200);
  expect((await put("security.trusted_urls", [])).status).toBe(200);
});

test("a from address refuses an encoded word with no charset or an unknown encoding", async () => {
  const original = (await settings())["app.from_email"];
  for (const value of [
    "=?Q?abc?= <a@example.test>",
    "=??Q?abc?= <a@example.test>",
    "=?utf-8?X?abc?= <a@example.test>",
    "Good =?Q?abc?= <a@example.test>",
  ]) {
    const refused = await put("app.from_email", [value]);
    expect({ value, status: refused.status }).toEqual({ value, status: 400 });
  }
  expect(await put("app.from_email", ["=?utf-8?Q?abc?= <a@example.test>"])).toEqual({
    status: 200,
    message: undefined,
  });
  await put("app.from_email", original);
});

test("a trusted URL refuses a port outside 1 to 65535 and a user name or password", async () => {
  for (const value of [
    "https://example.test:99999",
    "https://example.test:0",
    "https://user:pass@example.test",
    "https://user@example.test",
  ]) {
    const refused = await put("security.trusted_urls", [value]);
    expect({ value, status: refused.status }).toEqual({ value, status: 400 });
  }
  expect(await put("security.trusted_urls", ["https://example.test:8443"])).toEqual({
    status: 200,
    message: undefined,
  });
  await put("security.trusted_urls", []);
});

/** Writes a setting straight into the settings table, as an older build would have stored it. */
function storeAsOlderBuild(key: string, value: unknown): void {
  const db = openDatabase(f.persisted.dataDir);
  try {
    db.run("UPDATE settings SET value = ? WHERE key = ?", [JSON.stringify(value), key]);
  } finally {
    db.close();
  }
}

/** The admin form's save: the whole settings object, as the form posts it. Its status. */
async function saveForm(): Promise<number> {
  return (await api(f, cookie, "/api/settings", "PUT", await settings())).status;
}

// B117a (D136), lead decision 1 of round 1: a save checks only what it changes. Values an older build or
// upstream stored, probed with an unrelated save (a single key or the whole form), must not block it.
test("a trusted URL an older build stored does not block another save or the form", async () => {
  const stored = ["https://user@example.test", "https://example.test:0"];
  storeAsOlderBuild("security.trusted_urls", stored);
  try {
    expect(await put("app.site_name", "Renamed past stored trusted URLs")).toEqual({
      status: 200,
      message: undefined,
    });
    expect(await saveForm()).toBe(200);
    expect((await settings())["security.trusted_urls"]).toEqual(stored);
    // A new invalid entry is still refused, and only that entry is named.
    const added = await put("security.trusted_urls", [...stored, "https://new.example.test:99999"]);
    expect(added.status).toBe(400);
    expect(added.message).toContain("https://new.example.test:99999");
    expect(added.message).not.toContain("user@");
    expect(added.message).not.toContain("example.test:0");
  } finally {
    storeAsOlderBuild("security.trusted_urls", []);
  }
});

test("a from address an older build stored does not block another save or the form", async () => {
  const original = (await settings())["app.from_email"];
  const stored = ["=?Q?x?= <a@example.test>"];
  storeAsOlderBuild("app.from_email", stored);
  try {
    expect(await put("app.site_name", "Renamed past a stored from address")).toEqual({
      status: 200,
      message: undefined,
    });
    expect(await saveForm()).toBe(200);
    expect((await settings())["app.from_email"]).toEqual(stored);
    const added = await put("app.from_email", [...stored, "=?Q?y?= <b@example.test>"]);
    expect(added.status).toBe(400);
    expect(added.message).toBe("invalid from email address: =?Q?y?= <b@example.test>");
  } finally {
    storeAsOlderBuild("app.from_email", original);
  }
});

test("the default from address is checked when a save makes it first, even if an older build stored it", async () => {
  const original = (await settings())["app.from_email"];
  const valid = "Valid <valid@example.test>";
  const refused = "=?Q?x?= <a@example.test>";
  // An older build stored a valid default and an invalid second entry.
  storeAsOlderBuild("app.from_email", [valid, refused]);
  try {
    expect(await saveForm()).toBe(200);
    // Moving the stored invalid entry into first place makes it the default sender: it is checked.
    const moved = await put("app.from_email", [refused, valid]);
    expect(moved.status).toBe(400);
    expect(moved.message).toBe(`invalid from email address: ${refused}`);
    expect((await settings())["app.from_email"]).toEqual([valid, refused]);
    // The same stored entry in second place, with a valid default, is not checked again.
    expect(await put("app.from_email", [valid, refused])).toEqual({
      status: 200,
      message: undefined,
    });
    // The default that a save keeps unchanged is not checked again either, as before.
    storeAsOlderBuild("app.from_email", [refused, valid]);
    expect(await put("app.site_name", "Renamed past a stored default")).toEqual({
      status: 200,
      message: undefined,
    });
    expect((await settings())["app.from_email"]).toEqual([refused, valid]);
  } finally {
    storeAsOlderBuild("app.from_email", original);
  }
});

test("a notification address whose display name has a comma is stored as one address", async () => {
  const address = '"Ops, Team" <ops@example.test>';
  expect(await put("app.notify_emails", [address, "other@example.test"])).toEqual({
    status: 200,
    message: undefined,
  });
  expect((await settings())["app.notify_emails"]).toEqual([address, "other@example.test"]);
  await put("app.notify_emails", []);
});

test("an administrator address an older build stored untrimmed does not block another save", async () => {
  storeAsOlderBuild("app.notify_emails", [" ops@ "]);
  try {
    expect(await put("app.site_name", "Renamed past an untrimmed stored address")).toEqual({
      status: 200,
      message: undefined,
    });
    expect(await saveForm()).toBe(200);
    // The stored entry is compared trimmed on both sides, so it is not checked again.
    const added = await put("app.notify_emails", [" ops@ ", "new@"]);
    expect(added.status).toBe(400);
    expect(added.message).toBe("invalid notification email address: new@");
  } finally {
    storeAsOlderBuild("app.notify_emails", []);
  }
});

test("a site URL with a control character an older build stored does not block another save", async () => {
  const original = (await settings())["app.site_url"];
  // Mid-path: a trailing C1 character is trimmed by any save, as Go's TrimSpace does, so it would not be kept.
  const stored = "https://brand.example.test/a\u0085b";
  storeAsOlderBuild("app.site_url", stored);
  try {
    expect(await put("app.site_name", "Renamed past a stored site URL")).toEqual({
      status: 200,
      message: undefined,
    });
    expect(await saveForm()).toBe(200);
    expect((await settings())["app.site_url"]).toBe(stored);
    // A changed site URL is checked as before: a new fragment is refused and names the site URL.
    const refused = await put("app.site_url", "https://brand.example.test/#top");
    expect(refused.status).toBe(400);
    expect(refused.message).toContain("site URL");
    expect(await put("app.site_url", "https://brand.example.test/new")).toEqual({
      status: 200,
      message: undefined,
    });
  } finally {
    storeAsOlderBuild("app.site_url", original);
  }
});
