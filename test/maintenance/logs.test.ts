import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnalyticsPurge } from "@/analytics/purge";
import { campaignsFixture, type CampaignsFixture } from "@/test/campaigns/fixture";
import { createLogBuffer, type LogBuffer } from "@/maintenance/log-buffer";
import { registerMaintenanceRoutes } from "@/maintenance/routes";
import { createErrorLogger } from "@/app";

let f: CampaignsFixture;
let logs: LogBuffer;
let purge: ReturnType<typeof createAnalyticsPurge>;
beforeEach(async () => {
  f = await campaignsFixture();
  logs = createLogBuffer(f.clock, 3);
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
const logged = (error: unknown) => {
  const error_ = console.error;
  console.error = () => {};
  try {
    createErrorLogger(logs).error(error);
  } finally {
    console.error = error_;
  }
};

test("a line has upstream's shape, and the oldest lines go first", async () => {
  expect(await lines()).toEqual([]);
  for (const name of ["one", "two", "three", "four", "five", "six", "seven"])
    logged(new Error(`failed ${name}`));
  expect(await lines()).toEqual([
    "2026/01/02 03:04:05.000000 *: failed five",
    "2026/01/02 03:04:05.000000 *: failed six",
    "2026/01/02 03:04:05.000000 *: failed seven",
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
  logged(new Error("first\nsecond\tthird"));
  logged(Object.assign(new Error("short"), { cause: new Error("ada@example.com") }));
  logged("ada@example.com");
  const [multiline, withCause, notAnError] = logs.lines().slice(-3);
  expect(multiline).toEndWith("first second third");
  expect(withCause).toEndWith("short");
  expect(notAnError).toEndWith("Non-error value logged");
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
  expect((await lines())[0]!.length).toBeLessThan(540);
});

test("the route needs settings:get", async () => {
  expect((await f.json("/api/logs", "GET", undefined, {})).status).toBe(403);
});
