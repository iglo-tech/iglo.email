// Every API error carries a stable `code` (src/server/error-codes.ts), and every 429 and 503 sends
// `Retry-After` (B131). The router is the boundary: synthetic routes answer each case, and the events
// API answers the real ones in-process.
import { afterEach, expect, test } from "bun:test";
import { SINGLE_BODY_BYTES } from "@/events/input";
import { errorCodesFor } from "@/server/error-codes";
import type { ErrorCode } from "@/server/error-codes";
import { HttpError, ok } from "@/server/response";
import { createRouter } from "@/server/server";
import { placeRestoreHold, refuseWhileHeld } from "@/settings/hold";
import { eventsFixture } from "@/test/events/fixture";
import type { EventsFixture } from "@/test/events/fixture";

const fixtures: Array<EventsFixture> = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.close();
  }
});
async function open() {
  const f = await eventsFixture();
  fixtures.push(f);
  return f;
}
const url = (path: string) => `http://fixture.test${path}`;

test("a route's HttpError answers its status, message, code and details", async () => {
  const f = await open();
  const router = createRouter();
  router.route("GET", "/api/fixture/conflict", () => {
    throw new HttpError(409, "Taken.", {}, "email_conflict", {
      conflict: { external_id: "h_1" },
    });
  });
  const r = await router.handle(f.app, new Request(url("/api/fixture/conflict")));
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({
    message: "Taken.",
    code: "email_conflict",
    conflict: { external_id: "h_1" },
  });
});

test("an error that names no code takes the code of its status", async () => {
  const f = await open();
  const router = createRouter();
  router.route("GET", "/api/fixture/status/:status", (c) => {
    throw new HttpError(Number(c.params.status), "Refused.");
  });
  const expected: Record<number, ErrorCode> = {
    400: "invalid_fields",
    401: "unauthorized",
    403: "permission_denied",
    404: "not_found",
    405: "method_not_allowed",
    409: "conflict",
    413: "payload_too_large",
    415: "unsupported_media_type",
    422: "result_too_large",
    429: "rate_limited",
    499: "client_closed",
    500: "internal_error",
    501: "not_implemented",
    502: "bad_gateway",
    503: "unavailable",
  };
  for (const [status, code] of Object.entries(expected)) {
    const r = await router.handle(f.app, new Request(url(`/api/fixture/status/${status}`)));
    expect({ status: r.status, body: await r.json() }).toEqual({
      status: Number(status),
      body: { message: "Refused.", code },
    });
    expect(errorCodesFor(Number(status))).toContain(code);
  }
});

test("429 and 503 send Retry-After: 1 s and 30 s unless the route names its own wait", async () => {
  const f = await open();
  const router = createRouter();
  router.route("GET", "/api/fixture/limited", () => {
    throw new HttpError(429, "Slow down.");
  });
  router.route("GET", "/api/fixture/window", () => {
    throw new HttpError(429, "Slow down.", { "Retry-After": "7" });
  });
  router.route("GET", "/api/fixture/busy", () => {
    throw new HttpError(503, "Busy.");
  });
  const limited = await router.handle(f.app, new Request(url("/api/fixture/limited")));
  expect([limited.status, limited.headers.get("Retry-After")]).toEqual([429, "1"]);
  const window = await router.handle(f.app, new Request(url("/api/fixture/window")));
  expect([window.status, window.headers.get("Retry-After")]).toEqual([429, "7"]);
  const busy = await router.handle(f.app, new Request(url("/api/fixture/busy")));
  expect([busy.status, busy.headers.get("Retry-After"), await busy.json()]).toEqual([
    503,
    "30",
    { message: "Busy.", code: "unavailable" },
  ]);
  // Other statuses send no Retry-After.
  router.route("GET", "/api/fixture/missing", () => {
    throw new HttpError(404, "Gone.");
  });
  const missing = await router.handle(f.app, new Request(url("/api/fixture/missing")));
  expect(missing.headers.get("Retry-After")).toBeNull();
});

test("a sending hold answers 503 held, and says when to retry", async () => {
  const f = await open();
  placeRestoreHold(f.db, "2026-11-20T00:00:00.000Z");
  const router = createRouter();
  router.route("POST", "/api/fixture/send", (c) => {
    refuseWhileHeld(c.app.db);
    return ok(true);
  });
  const r = await router.handle(f.app, new Request(url("/api/fixture/send"), { method: "POST" }));
  expect(r.status).toBe(503);
  expect(r.headers.get("Retry-After")).toBe("30");
  const body = (await r.json()) as { message: string; code: string };
  expect(body.code).toBe("held");
  expect(body.message.startsWith("Sending is held.")).toBe(true);
});

test("HEAD answers the status and Retry-After with no body", async () => {
  const f = await open();
  const router = createRouter();
  router.route("HEAD", "/api/fixture/busy", () => {
    throw new HttpError(503, "Busy.");
  });
  const r = await router.handle(f.app, new Request(url("/api/fixture/busy"), { method: "HEAD" }));
  expect([r.status, r.headers.get("Retry-After"), await r.text()]).toEqual([503, "30", ""]);
});

test("a failure that is not an HttpError is a logged 500 with a code and no Retry-After", async () => {
  const f = await open();
  const router = createRouter();
  router.route("GET", "/api/fixture/crash", () => {
    throw new Error("boom");
  });
  const r = await router.handle(f.app, new Request(url("/api/fixture/crash")));
  expect(r.status).toBe(500);
  expect(r.headers.get("Retry-After")).toBeNull();
  expect(await r.json()).toEqual({ message: "Internal Server Error", code: "internal_error" });
  expect(f.errors).toHaveLength(1);
});

test("a missing subscriber ID is listmonk's 400, with the code that says not_found", async () => {
  const f = await open();
  const r = await f.json("/api/subscribers/999999", "PUT", {
    email: "missing@example.com",
    name: "Missing",
    status: "enabled",
    attribs: {},
  });
  expect(r).toEqual({
    status: 400,
    body: { message: "Subscriber (999999: ) not found", code: "not_found" },
  });
});

test("an unknown API path answers 404 not_found", async () => {
  const f = await open();
  const r = await f.request("/api/no-such-thing");
  expect(r.status).toBe(404);
  expect(await r.json()).toEqual({ message: "404 unknown endpoint", code: "not_found" });
});

test("the events API answers its refusals with codes: invalid, unauthenticated, too large and in flight", async () => {
  const f = await open();
  const invalid = await f.post({ name: "no subscriber" });
  expect(invalid.status).toBe(400);
  expect(invalid.body.code).toBe("invalid_fields");

  const anonymous = await f.post({ subscriber: { email: "a@example.com" }, name: "x" }, {});
  expect(anonymous.status).toBe(403);
  expect(anonymous.body.code).toBe("permission_denied");

  const large = await f.post("x".repeat(SINGLE_BODY_BYTES + 1));
  expect(large.status).toBe(413);
  expect(large.body.code).toBe("payload_too_large");

  // Four batch bodies being read hold every slot; a fifth waits for none.
  const encoder = new TextEncoder();
  const gate = Promise.withResolvers<void>();
  const reading = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
  const bodies = reading.map((read) => {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"events":'));
      },
      async pull(controller) {
        read.resolve();
        await gate.promise;
        controller.enqueue(encoder.encode("[]}"));
        controller.close();
      },
    });
  });
  const pending = bodies.map((body) =>
    f.request("/api/subscriber-events/batch", {
      method: "POST",
      headers: { ...f.api, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );
  await Promise.all(reading.map((read) => read.promise));
  const shed = await f.request("/api/subscriber-events/batch", {
    method: "POST",
    headers: { ...f.api, "content-type": "application/json" },
    body: "{}",
  });
  expect(shed.status).toBe(429);
  expect(shed.headers.get("Retry-After")).toBe("1");
  expect(await shed.json()).toEqual({ message: "Too many requests", code: "rate_limited" });

  gate.resolve();
  for (const response of await Promise.all(pending)) {
    expect(response.status).not.toBe(429);
    await response.text();
  }
});
