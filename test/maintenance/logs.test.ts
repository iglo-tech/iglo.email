import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnalyticsPurge } from "@/analytics/purge";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { createLogBuffer, type LogBuffer, type SafeMessage } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { createErrorLogger } from "@/app";

let f: CampaignsFixture;
let logs: LogBuffer;
let purge: ReturnType<typeof createAnalyticsPurge>;
beforeEach(async () => {
  f = await campaignsFixture({
    logger: (clock) => {
      logs = createLogBuffer(clock, 3);
      return createErrorLogger(logs);
    },
  });
  purge = createAnalyticsPurge(f.db, f.db);
  registerMaintenanceRoutes(f.router, {
    subscribers: f.owners.subscribers,
    analytics: purge,
    logs,
    auth: f.owners.auth,
    clock: f.clock,
    keepOpen: () => {},
    individualTracking: () => false,
  });
});
afterEach(async () => {
  purge.close();
  await f.close();
});

const lines = async () => {
  const response = await f.json("/api/logs");
  expect(response.status).toBe(200);
  return response.body.data as string[];
};
const logged = (error: unknown, safe?: SafeMessage) => {
  const error_ = console.error;
  console.error = () => {};
  try {
    createErrorLogger(logs).error(error, safe);
  } finally {
    console.error = error_;
  }
};

test("a line has upstream's shape, and the oldest lines go first", async () => {
  expect(await lines()).toEqual([]);
  logged(new Error("first"), "Outbox failed");
  logged(new Error("second"), "Outbox failed");
  logged(new TypeError("third"));
  logged(new RangeError("fourth"));
  logged(new Error("fifth"), "error sending campaign message");
  expect(await lines()).toEqual([
    "2026/01/02 03:04:05.000000 *: unexpected error (TypeError)",
    "2026/01/02 03:04:05.000000 *: unexpected error (RangeError)",
    "2026/01/02 03:04:05.000000 *: error sending campaign message (Error)",
  ]);
});

test("nothing secret or personal reaches a reader of the buffer", async () => {
  const secret = [
    "error rendering message (Spring) (ada.lovelace+news@example.com): boom",
    "550 5.1.1 <ada@example.com>: Recipient address rejected",
    "webhook https://hooks.example.test/T000/B000/XXXX?token=abc failed",
    "smtp://mailer:hunter2@smtp.example.test:587 refused",
    'JSON Parse error: Unexpected identifier "Ada Lovelace"',
    "SyntaxError near 'Grace Hopper'",
    "password=hunter2 rejected",
    "token: 0123abcd rejected",
    "Authorization: Basic aHVudGVyMjpodW50ZXIy",
    "bearer abc.def.ghi expired",
    "api_key=sk-1234 invalid",
    "subscriber 7c9e6679-7425-40de-944b-e07fc1f90ae7 is gone",
    "connect ECONNREFUSED 192.0.2.10:25",
    "from 2001:db8::ff00:42:8329 refused",
    `digest ${"ab12".repeat(16)} unknown`,
  ];
  for (const message of secret) {
    logs = createLogBuffer(f.clock, 3);
    logged(new Error(message));
    const [line] = logs.lines();
    for (const value of [
      "ada",
      "example.com",
      "hooks.example",
      "hunter2",
      "Lovelace",
      "Hopper",
      "0123abcd",
      "aHVudGVy",
      "abc.def",
      "sk-1234",
      "7c9e6679",
      "192.0.2.10",
      "2001:db8",
      "ab12ab12",
    ])
      expect(line).not.toContain(value);
  }
  logs = createLogBuffer(f.clock, 4);
  logged(new Error("first\nsecond\tthird"));
  logged(Object.assign(new Error("short"), { cause: new Error("ada@example.com") }));
  logged("ada@example.com");
  logged(new Error("ada@example.com"), "ada@example.com" as SafeMessage);
  const [multiline, withCause, notAnError, unknownMark] = logs.lines().slice(-4);
  expect(multiline).toEndWith("*: unexpected error (Error)");
  expect(withCause).toEndWith("*: unexpected error (Error)");
  expect(notAnError).toEndWith("*: unexpected error (not an Error)");
  expect(unknownMark).toEndWith("*: unexpected error (Error)");
});

test("a line is bounded, and a logger keeps its stderr copy whole", async () => {
  const seen: unknown[] = [];
  const error_ = console.error;
  console.error = (...args: unknown[]) => seen.push(args[1]);
  const failure = new Error(`${"long ".repeat(500)}ada@example.com`);
  try {
    createErrorLogger(logs).error(failure);
  } finally {
    console.error = error_;
  }
  expect(seen).toEqual([failure]);
  expect((await lines())[0]).toEndWith("*: unexpected error (Error)");
});

/** What the API user given only `settings:get` reads, and all that stderr received meanwhile. */
const brokenImage = async (filename: string) => {
  const role = await f.json("/api/roles/users", "POST", {
    name: "log-reader",
    permissions: ["settings:get"],
  });
  const user = await f.json("/api/users", "POST", {
    username: "log-reader",
    type: "api",
    status: "enabled",
    name: "reader",
    user_role_id: role.body.data.id,
  });
  const authorization = `Basic ${btoa(`log-reader:${user.body.data.password}`)}`;
  const list = await f.list("embeds");
  await f.subscriber("test@example.com", [list]);
  const input = {
    name: "Embeds",
    subject: "S",
    lists: [list],
    content_type: "richtext",
    type: "regular",
    messenger: "fixture",
    body: `<img data-embed src="${filename}">`,
    from_email: "Fixture <noreply@fixture.test>",
  };
  const campaign = await f.campaign(input);
  const stderr: unknown[] = [];
  const error_ = console.error;
  console.error = (...args: unknown[]) => stderr.push(...args);
  try {
    const sent = await f.json(`/api/campaigns/${campaign.id}/test`, "POST", {
      ...input,
      subscribers: ["test@example.com"],
    });
    expect(sent.status).toBe(200);
  } finally {
    console.error = error_;
  }
  const read = await f.json("/api/logs", "GET", undefined, { authorization });
  expect(read.status).toBe(200);
  return { lines: read.body.data as string[], stderr: stderr.map(String).join(" ") };
};

test("a settings:get reader sees that an image is missing, not whose it was", async () => {
  const { lines, stderr } = await brokenImage("Ada%20Lovelace.png");
  expect(lines).toEqual([
    "2026/01/02 03:04:05.000000 *: inline image not embedded: no such media (Error)",
  ]);
  expect(stderr).toContain("Ada Lovelace.png");
});

test("the line of a very long file name is the line of any other", async () => {
  const name = "a".repeat(40 * 1024);
  const { lines, stderr } = await brokenImage(name);
  expect(lines).toEqual([
    "2026/01/02 03:04:05.000000 *: inline image not embedded: no such media (Error)",
  ]);
  expect(stderr).toContain(name);
});

test("the buffer reads no text of an error, so its work cannot grow with one", () => {
  const read: string[] = [];
  const failure = new Error("unused");
  for (const key of ["message", "stack", "cause"])
    Object.defineProperty(failure, key, {
      get: () => {
        read.push(key);
        return "x".repeat(1024);
      },
    });
  logs.add(failure);
  expect(read).toEqual([]);
});

test("the route needs settings:get", async () => {
  expect((await f.json("/api/logs", "GET", undefined, {})).status).toBe(403);
});
