// B165 (D193, 07-api-and-ui "Settings"): a listmonk client's full `PUT /api/settings` sends back
// the keys upstream serves and leaves every native key out; each native key keeps its value. The
// walk cannot drift: every key either side serves is listmonk's (test/settings/upstream-keys.ts, from
// the pinned upstream) or native, and a native key with no changed value below fails the test, so a
// key added later is covered or the test says which one is not. `source.password` is the one native
// key a full write blanks (it then keeps the stored password only for the same source).
// Public boundary: /api/settings and /api/instance/settings with the admin's session.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { defaults } from "@/settings/defaults";
import { admin, api, get, login } from "@/test/admin/support";
import type { Fixture } from "@/test/admin/support";
import { readJson } from "@/test/read-body";
import { listmonkSettingKeys } from "@/test/settings/upstream-keys";
import { startUserFixture } from "@/test/users/fixture";

let f: Fixture;
let cookie = "";
beforeEach(async () => {
  f = await startUserFixture();
  cookie = (await login(f, admin.user, admin.password)).cookie;
});
afterEach(() => f.close());

const listmonk = new Set(listmonkSettingKeys);
const BLANKED = "source.password";

const read = async (path: string) => {
  const response = await get(f, path, cookie);
  expect(response.status).toBe(200);
  return (await readJson<{ data: Record<string, unknown> }>(response)).data;
};
const write = async (path: string, body: Record<string, unknown>) => {
  const response = await api(f, cookie, path, "PUT", body);
  expect(response.status, await response.clone().text()).toBe(200);
};

/**
 * Whether a served value is what a full PUT binds a key it leaves out to: false, 0, "", an empty
 * list (served as [] or null), or an object of only such fields. A value to keep must not be, or a
 * key missing from `nativeKeys` would read back as kept.
 */
function omitted(value: unknown): boolean {
  if (value === null || value === false || value === 0 || value === "") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return typeof value === "object" && Object.values(value).every(omitted);
}

/** A value other than the default for each native key; `list` is the id a grant rule names. */
function changed(list: number): Record<string, Record<string, unknown>> {
  return {
    project: {
      "app.site_url": "https://site.example.test",
      "privacy.preference_fields": [
        {
          key: "age",
          label: "Age",
          type: "number",
          editable: true,
          required: false,
          min: 1,
          max: 99,
          options: [],
        },
      ],
      "marketing.min_interval": "P3D",
      "security.public_rate_limit": { subscribe: 5, optin: 6, unsubscribe: 7, privacy: 8 },
      "source.connector": "pocketbase",
      "source.url": "https://pocketbase.example.test",
      "source.auth_collection": "svc",
      "source.identity": "svc@example.test",
      "source.events": {
        collection: "evts",
        user: "u",
        name: "n",
        data: "d",
        occurred_at: "at",
        key: "k",
      },
      "source.recipients": { collection: "recips", email: "e", name: "n", opt_out: "o" },
      "source.users": { collection: "people", leaving_filter: "deletedAt != ''" },
      "source.grant_lists": [{ event: "paid", where: { "data.plan": "pro" }, lists: [list] }],
      "appearance.brand.accent": "#aa3300",
      "appearance.brand.font": "system-serif",
      "appearance.brand.header": "name",
    },
    instance: {
      "messaging.max_send_rate": 5,
      "ses.api_region": "eu-west-1",
      "ses.api_access_key_id": "AKIASYNTHETIC0000000",
      "ses.api_secret_access_key": "synthetic-ses-secret",
      // The default, but not what an omitted boolean binds to.
      "webhooks.block_private_addresses": true,
      "sources.private_hosts": ["pocketbase"],
      // B162a (D188): the sources module, off by default; on, the project side serves `source.*`.
      "sources.enabled": true,
      "security.trusted_proxies": ["127.0.0.1"],
      "bounce.ses_topic_arns": ["arn:aws:sns:eu-west-1:123456789012:bounces"],
    },
  };
}

test("a full PUT without the native keys, as a listmonk client sends it, keeps every native key", async () => {
  // This fixture serves no lists and checks no rule's lists (the production server does, which
  // test/sources covers), so any list id stands. The instance goes first: it turns the sources
  // module on, without which the project side serves no `source.*` key (D188).
  const values = changed(1);
  for (const [side, path] of [
    ["instance", "/api/instance/settings"],
    ["project", "/api/settings"],
  ] as const) {
    const served = await read(path);
    const native = Object.keys(served).filter((key) => !listmonk.has(key) && key !== BLANKED);
    // Every native key has a value to keep, and each value is for a key this side serves.
    expect(native.toSorted(), side).toEqual(Object.keys(values[side]!).toSorted());

    const extra = side === "project" ? { "source.password": "synthetic-source-password" } : {};
    await write(path, { ...served, ...values[side], ...extra });
    const set = await read(path);
    for (const key of native) {
      // Kept must be told apart from what a full write binds an omitted key to; a boolean has two
      // values, so one whose default is `true` keeps `true`, and only the others also differ from
      // their default.
      expect(omitted(set[key]), `${side} ${key} differs from an omitted key's value`).toBe(false);
      if (typeof set[key] !== "boolean") {
        expect(set[key], `${side} ${key} changed`).not.toEqual(
          (defaults as Record<string, unknown>)[key],
        );
      }
    }

    // What a listmonk client sends: the keys upstream serves, with the values just read.
    const listmonkBody = Object.fromEntries(
      Object.entries(set).filter(([key]) => listmonk.has(key)),
    );
    await write(path, listmonkBody);
    const after = await read(path);
    for (const key of native) {
      expect(after[key], `${side} ${key} kept`).toEqual(set[key]);
    }
    // Same source URL and identity: the blanked password keeps the stored one.
    if (side === "project") {
      expect(after[BLANKED]).toBe(set[BLANKED]);
    }
  }
});
